import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const CHILD_FIXTURE = fileURLToPath(new URL('./mutation-crash-child.ts', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../../../../../..', import.meta.url))
const CRASH_SCENARIOS = ['push', 'emergency_cancel', 'flatten'] as const
type CrashScenario = typeof CRASH_SCENARIOS[number]
const EXPECTED_ACTION: Record<CrashScenario, string> = {
  push: 'placeOrder',
  emergency_cancel: 'emergencyCancelOrder',
  flatten: 'emergencyClosePosition',
}

interface RecoveryResult {
  before: {
    staged: unknown[]
    pendingMessage: string | null
    pendingHash: string | null
    mutation?: {
      readiness?: string
      activeAttempt?: {
        attemptId?: string
        operations?: Array<{ state?: string }>
      }
      downgradeBlocked?: boolean
    }
  }
  after: RecoveryResult['before']
  retryError?: string
  discard?: { resolved: boolean; readiness: string; commitResultStatus?: string }
  venueCalls: number
}

let tempHome: string | undefined
const activeChildren = new Set<ChildProcessWithoutNullStreams>()

afterEach(async () => {
  await Promise.all([...activeChildren].map(terminateChild))
  if (tempHome) await rm(tempHome, { recursive: true, force: true })
  tempHome = undefined
})

async function terminateChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return

  await new Promise<void>((resolve) => {
    const fallback = setTimeout(resolve, 2_000)
    child.once('close', () => {
      clearTimeout(fallback)
      resolve()
    })
    child.kill('SIGKILL')
  })
}

function spawnFixture(
  mode: 'crash' | 'recover',
  scenario: CrashScenario | 'prepared',
  accountId: string,
  witnessPath: string,
): ChildProcessWithoutNullStreams {
  if (!tempHome) throw new Error('Crash fixture requires an isolated OPENALICE_HOME')

  const child = spawn(process.execPath, [
    '--conditions=openalice-source',
    '--import',
    'tsx',
    CHILD_FIXTURE,
    mode,
    scenario,
    accountId,
    witnessPath,
  ], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      OPENALICE_HOME: tempHome,
      OPENALICE_APP_HOME: REPO_ROOT,
      OPENALICE_MUTATION_CRASH_FIXTURE: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  activeChildren.add(child)
  child.once('close', () => { activeChildren.delete(child) })
  return child
}

async function killAtDurableMarker(
  child: ChildProcessWithoutNullStreams,
  marker: 'VENUE_DURABLE' | 'PREPARED_DURABLE',
): Promise<void> {
  let stdout = ''
  let stderr = ''

  await new Promise<void>((resolve, reject) => {
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, 15_000)

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      if (!stdout.includes(marker)) return
      clearTimeout(timeout)
      child.kill('SIGKILL')
    })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('close', (code, signal) => {
      clearTimeout(timeout)
      if (timedOut) {
        reject(new Error(`Timed out waiting for ${marker}; stdout=${stdout}; stderr=${stderr}`))
      } else if (
        stdout.includes(marker)
        && (signal === 'SIGKILL' || (process.platform === 'win32' && code !== 0))
      ) resolve()
      else reject(new Error(`Crash fixture exited before kill: signal=${signal}; stdout=${stdout}; stderr=${stderr}`))
    })
  })
}

async function runRecovery(
  scenario: CrashScenario | 'prepared',
  accountId: string,
  witnessPath: string,
): Promise<RecoveryResult> {
  const child = spawnFixture('recover', scenario, accountId, witnessPath)
  let stdout = ''
  let stderr = ''

  const code = await new Promise<number | null>((resolve, reject) => {
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, 15_000)
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('close', (exitCode) => {
      clearTimeout(timeout)
      if (timedOut) {
        reject(new Error(`Timed out waiting for recovery fixture; stdout=${stdout}; stderr=${stderr}`))
      } else {
        resolve(exitCode)
      }
    })
  })

  if (code !== 0) throw new Error(`Recovery fixture exited ${code}: ${stderr}`)
  const resultLine = stdout
    .split('\n')
    .find((line) => line.startsWith('RECOVERY_RESULT '))
  if (!resultLine) throw new Error(`Recovery fixture emitted no result: stdout=${stdout}; stderr=${stderr}`)
  return JSON.parse(resultLine.slice('RECOVERY_RESULT '.length)) as RecoveryResult
}

describe('TradingGit process crash quarantine', () => {
  it.each(CRASH_SCENARIOS)(
    'does not replay a venue-accepted %s after receipt persistence is interrupted',
    async (scenario) => {
      tempHome = await mkdtemp(join(tmpdir(), 'openalice-mutation-crash-'))
      const accountId = `crash-${scenario.replace('_', '-')}`
      const witnessPath = join(tempHome, 'fake-venue', 'accepted.jsonl')
      const statePath = join(tempHome, 'data', 'trading', accountId, 'commit.json')

      await killAtDurableMarker(spawnFixture('crash', scenario, accountId, witnessPath), 'VENUE_DURABLE')

      // The legacy approval fields are cleared in the first durable mutation
      // write, so an older reader cannot replay the operation after the crash.
      const crashState = JSON.parse(await readFile(statePath, 'utf8')) as {
        stagingArea?: unknown[]
        pendingMessage?: string | null
        pendingHash?: string | null
        mutation?: {
          schemaVersion?: number
          activeAttempt?: {
            attemptId?: string
            kind?: string
            operations?: Array<{
              state?: string
              operation?: { action?: string }
            }>
          }
        }
      }
      expect(crashState.stagingArea).toEqual([])
      expect(crashState.pendingMessage).toBeNull()
      expect(crashState.pendingHash).toBeNull()
      expect(crashState.mutation?.schemaVersion).toBe(1)
      expect(crashState.mutation?.activeAttempt?.kind).toBe(scenario)
      expect(crashState.mutation?.activeAttempt?.attemptId).toEqual(expect.any(String))
      expect(crashState.mutation?.activeAttempt?.operations).toHaveLength(1)
      expect(crashState.mutation?.activeAttempt?.operations?.[0]?.operation?.action)
        .toBe(EXPECTED_ACTION[scenario])
      expect(crashState.mutation?.activeAttempt?.operations?.[0]?.state).toBe('dispatching')

      const recovered = await runRecovery(scenario, accountId, witnessPath)

      expect(recovered.before.staged).toEqual([])
      expect(recovered.before.pendingMessage).toBeNull()
      expect(recovered.before.pendingHash).toBeNull()
      expect(recovered.before.mutation?.readiness).toBe('recovery_required')
      expect(recovered.before.mutation?.activeAttempt?.operations?.[0]?.state).toBe('uncertain')
      expect(recovered.before.mutation?.downgradeBlocked).toBe(true)
      expect(recovered.before.mutation?.activeAttempt?.attemptId).toEqual(expect.any(String))
      expect(recovered.before.mutation?.activeAttempt?.attemptId)
        .toBe(crashState.mutation?.activeAttempt?.attemptId)
      expect(recovered.retryError).toMatch(/Mutation recovery required/i)
      expect(recovered.retryError).toContain(recovered.before.mutation?.activeAttempt?.attemptId)
      expect(recovered.after).toEqual(recovered.before)
      expect(recovered.venueCalls).toBe(1)

      const witnessLines = (await readFile(witnessPath, 'utf8'))
        .split('\n')
        .filter((line) => line.trim().length > 0)
      expect(witnessLines).toHaveLength(1)
    },
    45_000,
  )

  it(
    'quarantines a crash in the prepared state and allows a safe audited human discard',
    async () => {
      tempHome = await mkdtemp(join(tmpdir(), 'openalice-mutation-crash-'))
      const accountId = 'crash-prepared'
      const witnessPath = join(tempHome, 'fake-venue', 'accepted.jsonl')
      const statePath = join(tempHome, 'data', 'trading', accountId, 'commit.json')

      // Kill after the attempt is durably `prepared` but strictly before the
      // dispatching transition — the venue was provably never contacted.
      await killAtDurableMarker(spawnFixture('crash', 'prepared', accountId, witnessPath), 'PREPARED_DURABLE')

      const crashState = JSON.parse(await readFile(statePath, 'utf8')) as {
        stagingArea?: unknown[]
        pendingMessage?: string | null
        pendingHash?: string | null
        mutation?: {
          schemaVersion?: number
          activeAttempt?: { operations?: Array<{ state?: string }> }
        }
      }
      // Legacy replay fields cleared in the same durable write that recorded
      // the attempt; every operation is still `prepared`.
      expect(crashState.stagingArea).toEqual([])
      expect(crashState.pendingMessage).toBeNull()
      expect(crashState.pendingHash).toBeNull()
      expect(crashState.mutation?.activeAttempt?.operations?.every(
        (operation) => operation.state === 'prepared',
      )).toBe(true)

      const recovered = await runRecovery('prepared', accountId, witnessPath)

      // Conservative quarantine on restart: not pushable, no auto-replay.
      expect(recovered.before.mutation?.readiness).toBe('recovery_required')
      expect(recovered.before.mutation?.activeAttempt?.operations?.[0]?.state).toBe('prepared')
      expect(recovered.retryError).toMatch(/Mutation recovery required/i)

      // The durable state proves dispatch never began, so the human discard
      // is accepted, audited, and leaves the account ready again.
      expect(recovered.discard).toMatchObject({
        resolved: true,
        readiness: 'ready',
        commitResultStatus: 'user-rejected',
      })
      expect(recovered.after.mutation?.readiness).toBe('ready')

      // ZERO venue calls across crash, restart, retry, and discard.
      expect(recovered.venueCalls).toBe(0)
    },
    45_000,
  )
})
