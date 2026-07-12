import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'
import type {
  StewardSizingSourceVersions,
  StewardUtaMutationRequest,
  StewardUtaMutationResponse,
} from '@traderalice/uta-protocol'

const CHILD_FIXTURE = fileURLToPath(new URL('./steward-mutation-child.ts', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../../../../..', import.meta.url))

type Behavior = 'normal' | 'gated_normal' | 'crash_dispatching' | 'advance_source_lose_response'

interface ChildResult {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
  readonly response?: StewardUtaMutationResponse
}

interface ProcessHarness {
  readonly home: string
  readonly accountId: string
  readonly requestPath: string
  readonly sourcePath: string
  readonly witnessPath: string
  readonly statePath: string
  request: StewardUtaMutationRequest
}

const activeChildren = new Set<ChildProcessWithoutNullStreams>()
const homes = new Set<string>()

afterEach(async () => {
  await Promise.all([...activeChildren].map(terminateChild))
  await Promise.all([...homes].map((home) => rm(home, { recursive: true, force: true })))
  homes.clear()
})

async function createHarness(label: string): Promise<ProcessHarness> {
  const home = await mkdtemp(join(tmpdir(), `openalice-steward-process-${label}-`))
  homes.add(home)
  const accountId = `mock-steward-${label}`
  const requestPath = join(home, 'request.json')
  const sourcePath = join(home, 'source.json')
  const witnessPath = join(home, 'fixture-invocations.jsonl')
  const statePath = join(home, 'data', 'trading', accountId, 'commit.json')
  const request = mutationRequest(accountId)
  await writeFile(requestPath, `${JSON.stringify(request)}\n`, 'utf8')
  await writeFile(sourcePath, `${JSON.stringify(sourceVersions())}\n`, 'utf8')
  const harness = { home, accountId, requestPath, sourcePath, witnessPath, statePath, request }
  const init = await runChild(harness, 'init', 'normal')
  if (init.code !== 0 || !init.stdout.includes('STEWARD_INIT_OK')) {
    throw new Error(`Steward child init failed: stdout=${init.stdout}; stderr=${init.stderr}`)
  }
  return harness
}

function mutationRequest(accountId: string): StewardUtaMutationRequest {
  return {
    version: 1,
    accountId,
    utaMutationReference: `uta-mutation:${accountId}:1`,
    expectedSourceVersions: sourceVersions(),
    operation: {
      operationId: 'operation:increase:1',
      kind: 'order_place',
      effect: 'increase',
      instrument: `${accountId}/ASSET-A`,
      side: 'BUY',
      totalQuantity: '15',
    },
    protection: {
      kind: 'selected',
      operationId: 'operation:increase:1',
      instrument: `${accountId}/ASSET-A`,
      exitSide: 'SELL',
      orderType: 'STP',
      triggerPrice: '90',
    },
  }
}

function sourceVersions(): StewardSizingSourceVersions & { riskEnvelope: number } {
  return {
    accountState: 'account:1',
    riskState: 'risk:1',
    riskEnvelope: 3,
    brokerCapabilities: 'broker:1',
  }
}

function spawnChild(
  harness: ProcessHarness,
  mode: 'init' | 'invoke',
  behavior: Behavior,
): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, [
    '--conditions=openalice-source',
    '--import',
    'tsx',
    CHILD_FIXTURE,
    mode,
    harness.accountId,
    harness.requestPath,
    harness.sourcePath,
    harness.witnessPath,
    behavior,
  ], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      OPENALICE_HOME: harness.home,
      AQ_LAUNCHER_ROOT: join(harness.home, 'workspaces'),
      OPENALICE_GLOBAL_DIR: join(harness.home, 'global'),
      OPENALICE_APP_HOME: REPO_ROOT,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  activeChildren.add(child)
  child.once('close', () => { activeChildren.delete(child) })
  return child
}

async function runChild(
  harness: ProcessHarness,
  mode: 'init' | 'invoke',
  behavior: Behavior,
): Promise<ChildResult> {
  const child = spawnChild(harness, mode, behavior)
  return collectChild(child)
}

async function collectChild(child: ChildProcessWithoutNullStreams): Promise<ChildResult> {
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`Steward child timed out: stdout=${stdout}; stderr=${stderr}`))
    }, 30_000)
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('close', (code, signal) => {
      clearTimeout(timeout)
      resolve({ code, signal })
    })
  })
  const line = stdout.split('\n').find((candidate) => candidate.startsWith('STEWARD_RESULT '))
  return {
    ...result,
    stdout,
    stderr,
    ...(line ? { response: JSON.parse(line.slice('STEWARD_RESULT '.length)) as StewardUtaMutationResponse } : {}),
  }
}

async function runGatedChildren(
  harness: ProcessHarness,
  count: number,
): Promise<ChildResult[]> {
  const children = Array.from({ length: count }, () =>
    spawnChild(harness, 'invoke', 'gated_normal'))
  await Promise.all(children.map(waitForReady))
  const results = children.map(collectChild)
  for (const child of children) child.stdin.end('release\n')
  return Promise.all(results)
}

async function waitForReady(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    const onStdout = (chunk: Buffer) => {
      stdout += chunk.toString()
      if (!stdout.includes('STEWARD_READY')) return
      cleanup()
      resolve()
    }
    const onStderr = (chunk: Buffer) => { stderr += chunk.toString() }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup()
      reject(new Error(
        `Steward child exited before ready: code=${code}; signal=${signal}; stdout=${stdout}; stderr=${stderr}`,
      ))
    }
    const cleanup = () => {
      child.stdout.off('data', onStdout)
      child.stderr.off('data', onStderr)
      child.off('error', onError)
      child.off('close', onClose)
    }
    child.stdout.on('data', onStdout)
    child.stderr.on('data', onStderr)
    child.once('error', onError)
    child.once('close', onClose)
  })
}

async function terminateChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 2_000)
    child.once('close', () => {
      clearTimeout(timeout)
      resolve()
    })
    child.kill('SIGKILL')
  })
}

async function invocationCount(path: string): Promise<number> {
  try {
    return (await readFile(path, 'utf8')).split('\n').filter((line) => line.trim()).length
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
}

describe('Steward mutation process ownership', () => {
  it('deduplicates identical concurrent processes and rejects a different payload for the same key', async () => {
    const harness = await createHarness('concurrent')
    const responses = await runGatedChildren(harness, 8)
    for (const child of responses) {
      expect(child.code, child.stderr).toBe(0)
      expect(child.response?.status).toBe('accepted')
    }
    expect(responses.filter((child) =>
      child.response?.status === 'accepted' && !child.response.deduplicated)).toHaveLength(1)
    expect(await invocationCount(harness.witnessPath)).toBe(1)

    const durable = JSON.parse(await readFile(harness.statePath, 'utf8')) as {
      commits: Array<{
        operations?: Array<{ tpsl?: { stopLoss?: { price?: string } } }>
        mutationAudit?: { context?: { stewardMutation?: { payloadFingerprint?: string } } }
      }>
    }
    expect(durable.commits).toHaveLength(1)
    expect(durable.commits[0]?.mutationAudit?.context?.stewardMutation?.payloadFingerprint)
      .toMatch(/^[0-9a-f]{64}$/)
    expect(durable.commits[0]?.operations?.[0]?.tpsl?.stopLoss?.price).toBe('90')

    const increase = harness.request as Extract<StewardUtaMutationRequest, { protection: unknown }>
    harness.request = {
      ...increase,
      protection: { ...increase.protection, triggerPrice: '89' },
    }
    await writeFile(harness.requestPath, `${JSON.stringify(harness.request)}\n`, 'utf8')
    const conflict = await runChild(harness, 'invoke', 'normal')
    expect(conflict.code, conflict.stderr).toBe(0)
    expect(conflict.response).toMatchObject({ status: 'rejected', code: 'idempotency_conflict' })
    expect(await invocationCount(harness.witnessPath)).toBe(1)
  }, 60_000)

  it('keeps a crash after durable dispatching in recovery and never replays after restart', async () => {
    const harness = await createHarness('crash')
    const crashed = await runChild(harness, 'invoke', 'crash_dispatching')
    expect(
      crashed.signal === 'SIGKILL' || (process.platform === 'win32' && crashed.code !== 0),
      `stdout=${crashed.stdout}; stderr=${crashed.stderr}`,
    ).toBe(true)

    const durable = JSON.parse(await readFile(harness.statePath, 'utf8')) as {
      mutation?: { activeAttempt?: { kind?: string; operations?: Array<{ state?: string }> } }
    }
    expect(durable.mutation?.activeAttempt?.kind).toBe('steward_operation')
    expect(durable.mutation?.activeAttempt?.operations?.[0]?.state).toBe('dispatching')

    const firstRestart = await runChild(harness, 'invoke', 'normal')
    const secondRestart = await runChild(harness, 'invoke', 'normal')
    expect(firstRestart.response).toMatchObject({ status: 'rejected', code: 'mutation_recovery_required' })
    expect(secondRestart.response).toMatchObject({ status: 'rejected', code: 'mutation_recovery_required' })
    expect(await invocationCount(harness.witnessPath)).toBe(1)
  }, 60_000)

  it('deduplicates a lost response after the successful invocation advances accountState', async () => {
    const harness = await createHarness('lost-response')
    const lost = await runChild(harness, 'invoke', 'advance_source_lose_response')
    expect(lost.code).toBe(86)
    expect(lost.response).toBeUndefined()
    expect(JSON.parse(await readFile(harness.sourcePath, 'utf8'))).toMatchObject({
      accountState: 'account:2',
    })

    const retry = await runChild(harness, 'invoke', 'normal')
    expect(retry.code, retry.stderr).toBe(0)
    expect(retry.response).toMatchObject({ status: 'accepted', deduplicated: true })
    expect(await invocationCount(harness.witnessPath)).toBe(1)
  }, 60_000)
})
