import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'
import {
  UTA_STEWARD_WORKSPACE_AUTHZ_HEADER,
  createUTAClient,
  type StewardSizingSourceVersions,
} from '@traderalice/uta-protocol'

import { UTAAccountSDK } from '../../services/uta-client/UTAAccountSDK.js'
import type { CliAdapter } from '../cli-adapter.js'
import type { Logger } from '../logger.js'
import { ScheduleMarkerStore } from '../schedule/marker-store.js'
import { ScheduleScanner } from '../schedule/scanner.js'
import { WorkspaceRegistry, type WorkspaceMeta } from '../workspace-registry.js'
import {
  createStewardExecutionRecordStore,
  stewardExecutionRecordSchema,
  type StewardExecutionRecord,
} from './execution-record.js'
import { stewardExecutionRecordsDir } from './paths.js'
import { integrateStewardSizingOutcome } from './sizing-integration.js'
import { sizeStewardDecision, type StewardSizingOutcome } from './sizing.js'

const NOW = Date.parse('2026-07-13T12:00:00.000Z')
const ACCOUNT_ID = 'mock-scheduler-uta'
const ISSUE_ID = 'bounded-reduce-risk'
const INTERNAL_TOKEN = 'scheduler-uta-process-internal-token'
const SNAPSHOT_SHA256 = '7'.repeat(64)
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const CHILD_FIXTURE = fileURLToPath(new URL(
  '../../../services/uta/src/http/steward-scheduler-process-child.ts',
  import.meta.url,
))

const activeChildren = new Set<ChildProcessWithoutNullStreams>()
const roots = new Set<string>()

const noopLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  event() {},
  child() { return noopLogger },
} as unknown as Logger

const unusedHeadlessAdapter = {
  id: 'shell',
  capabilities: { headless: false },
} as unknown as CliAdapter

afterEach(async () => {
  await Promise.all([...activeChildren].map(terminateChild))
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })))
  roots.clear()
})

describe('D3 scheduled Steward to UTA process boundary', () => {
  it('runs one sizing-derived reduce-only operation after authenticated version checks and then advances the schedule marker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openalice-d3-scheduler-uta-'))
    roots.add(root)
    const workspaceDir = join(root, 'workspace')
    const launcherRoot = join(root, 'launcher')
    const utaHome = join(root, 'uta-home')
    const sourcePath = join(root, 'source-versions.json')
    const witnessPath = join(root, 'witness.jsonl')
    const markerPath = join(launcherRoot, 'state', 'schedule-markers.json')
    const registryPath = join(launcherRoot, 'workspaces.json')
    const sourceVersions: StewardSizingSourceVersions & { riskEnvelope: number } = {
      accountState: 'account-state:scheduler:1',
      riskState: 'risk-state:scheduler:1',
      riskEnvelope: 3,
      brokerCapabilities: 'broker-capabilities:scheduler:1',
    }
    await mkdir(join(workspaceDir, '.alice', 'issues'), { recursive: true })
    await writeFile(sourcePath, `${JSON.stringify(sourceVersions)}\n`, 'utf8')
    await writeFile(join(workspaceDir, '.alice', 'issues', `${ISSUE_ID}.md`), scheduledIssue(), 'utf8')

    const child = spawnUtaChild({ root, utaHome, sourcePath, witnessPath, workspaceDir })
    const { baseUrl } = await waitForChildReady(child)
    const mutationPath = `/api/trading/uta/${encodeURIComponent(ACCOUNT_ID)}/steward/mutation`

    const forged = await fetch(`${baseUrl}${mutationPath}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [UTA_STEWARD_WORKSPACE_AUTHZ_HEADER]: 'paper',
      },
      body: '{}',
    })
    expect(forged.status).toBe(401)
    expect(await readWitness(witnessPath)).toEqual([])

    const registry = await WorkspaceRegistry.load(registryPath, noopLogger)
    const workspace: WorkspaceMeta = {
      id: 'workspace-d3-scheduler-uta',
      tag: 'd3-scheduler-uta',
      dir: workspaceDir,
      createdAt: new Date(NOW).toISOString(),
      authzLevel: 'paper',
      agents: ['shell'],
    }
    await registry.add(workspace)
    const markers = await ScheduleMarkerStore.load(markerPath, noopLogger)
    const executionRecordStore = createStewardExecutionRecordStore(workspaceDir)
    const client = createUTAClient({ baseUrl, internalToken: INTERNAL_TOKEN })
    const account = new UTAAccountSDK({ client, id: ACCOUNT_ID })

    let completedOutcome: StewardSizingOutcome | undefined
    let completedRecord: StewardExecutionRecord | undefined
    let releaseSuccessfulDispatch: (() => void) | undefined
    let signalSuccessfulDispatch: (() => void) | undefined
    const successfulDispatch = new Promise<void>((resolve) => { signalSuccessfulDispatch = resolve })
    const dispatchRelease = new Promise<void>((resolve) => { releaseSuccessfulDispatch = resolve })

    const scanner = new ScheduleScanner({
      registry,
      resolveAdapter: () => unusedHeadlessAdapter,
      dispatch: async () => { throw new Error('headless dispatch must remain unused') },
      dispatchStewardWake: async (meta, wake) => {
        expect(meta.id).toBe(workspace.id)
        expect(wake).toMatchObject({
          issueId: ISSUE_ID,
          accountId: ACCOUNT_ID,
          authzLevel: 'paper',
          expectedDecision: 'reduce_risk',
          reason: 'risk_event',
          nowMs: NOW,
        })
        const rawIntent = reduceOnlyIntent(wake.wakeId)
        const outcome = sizeStewardDecision({
          decisionWakeId: wake.wakeId,
          accountId: wake.accountId,
          decision: 'reduce_risk',
          rawIntent,
          snapshot: {
            snapshotId: rawIntent.snapshotId,
            snapshotSha256: rawIntent.snapshotSha256,
          },
          account: {
            accountId: wake.accountId,
            accountStateVersion: sourceVersions.accountState,
            equity: '10000',
            instrument: {
              instrument: `${wake.accountId}/ASSET-A`,
              positionQuantity: '-7.5',
              markPrice: null,
              contractMultiplier: '1',
              quantityIncrement: '0.5',
            },
          },
          risk: {
            accountId: wake.accountId,
            riskStateVersion: sourceVersions.riskState,
            envelope: {
              kind: 'available',
              envelopeVersion: sourceVersions.riskEnvelope,
              scopeAllowed: true,
              increaseAllowed: false,
              caps: {
                maxPositionPctOfEquity: '25',
                maxSingleOrderPctOfEquity: '20',
                remainingLossPctOfEquity: '0',
              },
            },
          },
          brokerCapabilities: {
            capabilitiesStateVersion: sourceVersions.brokerCapabilities,
            market: true,
            stop: false,
            stopLimit: { supported: false },
          },
        })
        expect(outcome).toMatchObject({
          kind: 'proposal',
          sourceStateVersions: sourceVersions,
          operations: [{ effect: 'reduce', side: 'BUY', totalQuantity: '7.5' }],
          protections: [],
        })

        const utaMutationReference = `uta-mutation:${wake.wakeId}:reduce:0`
        const result = await integrateStewardSizingOutcome({
          rawIntent,
          sizingOutcome: outcome,
          utaMutationReference,
          utaMutationCapability: account.bindStewardMutationCapability(
            () => meta.authzLevel ?? 'read_only',
          ),
          executionRecordStore,
        })
        if (result.status !== 'operations_accepted') {
          throw new Error(`bounded Steward mutation was not accepted: ${JSON.stringify(result)}`)
        }
        completedOutcome = outcome
        completedRecord = result.executionRecord
        signalSuccessfulDispatch?.()
        await dispatchRelease
        return { wakeId: wake.wakeId }
      },
      markers,
      logger: noopLogger,
      now: () => NOW,
    })

    const scan = scanner.scan()
    await successfulDispatch
    expect(markers.get(workspace.id, ISSUE_ID)).toBeUndefined()
    releaseSuccessfulDispatch?.()
    await scan

    expect(markers.get(workspace.id, ISSUE_ID)).toBe(NOW)
    const persistedMarkers = JSON.parse(await readFile(markerPath, 'utf8')) as {
      markers: Record<string, number>
    }
    expect(persistedMarkers.markers[`${workspace.id} ${ISSUE_ID}`]).toBe(NOW)

    expect(completedOutcome).toMatchObject({
      sourceStateVersions: sourceVersions,
      operations: [{ effect: 'reduce', totalQuantity: '7.5' }],
    })
    expect(completedRecord).toBeDefined()
    const recordPath = executionRecordStore.path(completedRecord!.recordId)
    const diskRecord = stewardExecutionRecordSchema.parse(JSON.parse(await readFile(recordPath, 'utf8')))
    expect(diskRecord).toEqual(completedRecord)

    const witnesses = await readWitness(witnessPath)
    expect(witnesses.filter((event) => event.type === 'authorized-http')).toEqual([{
      type: 'authorized-http',
      internalTokenMatched: true,
      workspaceAuthzLevel: 'paper',
    }])
    expect(witnesses.filter((event) => event.type === 'source-read')).toEqual([{
      type: 'source-read',
      expected: sourceVersions,
      actual: sourceVersions,
    }])
    expect(witnesses.filter((event) => event.type === 'invoke')).toEqual([{
      type: 'invoke',
      accountId: ACCOUNT_ID,
      utaMutationReference: completedRecord!.utaMutationReference,
      operationId: completedOutcome && 'operations' in completedOutcome
        ? completedOutcome.operations[0]?.operationId
        : undefined,
      effect: 'reduce',
      requestQuantity: '7.5',
      operationAction: 'closePosition',
      operationQuantity: '7.5',
      recordMutationReference: completedRecord!.utaMutationReference,
    }])

    const durable = JSON.parse(await readFile(
      join(utaHome, 'data', 'trading', ACCOUNT_ID, 'commit.json'),
      'utf8',
    )) as {
      commits: Array<{
        mutationAudit?: {
          context?: {
            stewardMutation?: {
              utaMutationReference?: string
              operationId?: string
            }
          }
        }
      }>
    }
    expect(durable.commits).toHaveLength(1)
    expect(durable.commits[0]?.mutationAudit?.context?.stewardMutation).toEqual({
      utaMutationReference: completedRecord!.utaMutationReference,
      operationId: completedOutcome && 'operations' in completedOutcome
        ? completedOutcome.operations[0]?.operationId
        : undefined,
      payloadFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
  }, 60_000)
})

function scheduledIssue(): string {
  return `---
title: Bounded reduce-only integration
status: todo
when: { kind: every, every: "30m" }
what: Execute the authorized deterministic reduce-only fixture.
kind: steward-wake
accountId: ${ACCOUNT_ID}
authzLevel: paper
expectedDecision: reduce_risk
wakeReason: risk_event
---
`
}

function reduceOnlyIntent(wakeId: string) {
  return {
    kind: 'single' as const,
    direction: 'flat' as const,
    instrument: `${ACCOUNT_ID}/ASSET-A`,
    targetExposure: { minPct: 0, maxPct: 0 },
    invalidation: [{ kind: 'thesis' as const, note: 'The risk event requires the position to be closed.' }],
    confidence: 'high' as const,
    maxAcceptableLossPct: 0,
    timeHorizon: { unit: 'hour' as const, value: 1 },
    evidence: [{ ref: `wake:${wakeId}`, note: 'The scheduled risk event is the bounded fixture input.' }],
    snapshotId: `snap:${wakeId}`,
    snapshotSha256: SNAPSHOT_SHA256,
  }
}

function spawnUtaChild(input: {
  readonly root: string
  readonly utaHome: string
  readonly sourcePath: string
  readonly witnessPath: string
  readonly workspaceDir: string
}): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, [
    '--conditions=openalice-source',
    '--import',
    'tsx',
    CHILD_FIXTURE,
    ACCOUNT_ID,
    input.sourcePath,
    input.witnessPath,
    stewardExecutionRecordsDir(input.workspaceDir),
  ], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      OPENALICE_HOME: input.utaHome,
      AQ_LAUNCHER_ROOT: join(input.root, 'uta-workspaces'),
      OPENALICE_GLOBAL_DIR: join(input.root, 'uta-global'),
      OPENALICE_APP_HOME: REPO_ROOT,
      OPENALICE_UTA_INTERNAL_TOKEN: INTERNAL_TOKEN,
      NODE_OPTIONS: `--localstorage-file=${join(input.root, 'uta-node-localstorage')}`,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  activeChildren.add(child)
  child.once('close', () => { activeChildren.delete(child) })
  return child
}

async function waitForChildReady(child: ChildProcessWithoutNullStreams): Promise<{ baseUrl: string }> {
  let stdout = ''
  let stderr = ''
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`UTA child readiness timed out: stdout=${stdout}; stderr=${stderr}`))
    }, 30_000)
    const onStdout = (chunk: Buffer) => {
      stdout += chunk.toString()
      const line = stdout.split('\n').find((candidate) => candidate.startsWith('STEWARD_UTA_READY '))
      if (!line) return
      cleanup()
      const ready = JSON.parse(line.slice('STEWARD_UTA_READY '.length)) as { port: number }
      resolve({ baseUrl: `http://127.0.0.1:${ready.port}` })
    }
    const onStderr = (chunk: Buffer) => { stderr += chunk.toString() }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup()
      reject(new Error(
        `UTA child exited before ready: code=${code}; signal=${signal}; stdout=${stdout}; stderr=${stderr}`,
      ))
    }
    const cleanup = () => {
      clearTimeout(timeout)
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
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      resolve()
    }, 3_000)
    child.once('close', () => {
      clearTimeout(timeout)
      resolve()
    })
    child.kill('SIGTERM')
  })
}

interface WitnessEvent {
  readonly type: string
  readonly [key: string]: unknown
}

async function readWitness(path: string): Promise<WitnessEvent[]> {
  try {
    return (await readFile(path, 'utf8'))
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as WitnessEvent)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}
