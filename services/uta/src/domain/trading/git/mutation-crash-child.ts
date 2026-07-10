/**
 * Child process for the mutation crash/restart test.
 *
 * The fake venue makes acceptance durable on disk, then deliberately never
 * returns. The parent kills this process at that exact boundary: after the
 * venue accepted the call but before TradingGit can persist a receipt.
 */

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import Decimal from 'decimal.js'
import { Contract, Order } from '@traderalice/ibkr'
import type { ApproverIdentity, GitExportState, GitState, Operation } from './types.js'
import { isMutationEnvelopeV1 } from './types.js'
import { loadGitState, createGitPersister } from '../git-persistence.js'
import { TradingGit } from './TradingGit.js'
import type { TradingGitConfig } from './interfaces.js'
import '../contract-ext.js'

type CrashScenario = 'push' | 'emergency_cancel' | 'flatten' | 'prepared'

const [mode, scenario, accountId, venueWitnessPath] = process.argv.slice(2)

if (
  process.env['OPENALICE_MUTATION_CRASH_FIXTURE'] !== '1'
  || !process.env['OPENALICE_HOME']
  || (mode !== 'crash' && mode !== 'recover')
  || (scenario !== 'push' && scenario !== 'emergency_cancel' && scenario !== 'flatten' && scenario !== 'prepared')
  || !accountId
  || !venueWitnessPath
) {
  throw new Error(
    'Mutation crash fixture requires its isolated test environment and valid arguments',
  )
}

const approver: ApproverIdentity = {
  via: 'alice-bff',
  fingerprint: 'mutation-crash-process-test',
  at: new Date().toISOString(),
}

function emptyGitState(): GitState {
  return {
    totalCashValue: '100000',
    netLiquidation: '100000',
    unrealizedPnL: '0',
    realizedPnL: '0',
    positions: [],
    pendingOrders: [],
  }
}

function makeContract(): Contract {
  const contract = new Contract()
  contract.aliceId = `${accountId}|AAPL`
  contract.symbol = 'AAPL'
  contract.localSymbol = 'AAPL'
  contract.secType = 'STK'
  contract.exchange = 'SMART'
  contract.currency = 'USD'
  return contract
}

function mutationOperation(kind: CrashScenario): Operation {
  const contract = makeContract()
  if (kind === 'emergency_cancel') {
    return {
      action: 'emergencyCancelOrder',
      orderId: 'venue-order-1',
      contract,
    }
  }
  if (kind === 'flatten') {
    return {
      action: 'emergencyClosePosition',
      contract,
      quantity: new Decimal(1),
    }
  }

  const order = new Order()
  order.action = 'BUY'
  order.orderType = 'MKT'
  order.totalQuantity = new Decimal(1)

  return { action: 'placeOrder', contract, order }
}

/** Append one venue acceptance and fsync before reporting it to the parent. */
function recordDurableVenueCall(operation: Operation): void {
  mkdirSync(dirname(venueWitnessPath), { recursive: true })
  const fd = openSync(venueWitnessPath, 'a')
  try {
    const entry = JSON.stringify({
      acceptedAt: new Date().toISOString(),
      action: operation.action,
    })
    writeSync(fd, `${entry}\n`)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function countVenueCalls(): number {
  try {
    return readFileSync(venueWitnessPath, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .length
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
}

async function writeStdout(line: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(`${line}\n`, (error) => error ? reject(error) : resolve())
  })
}

const persistRaw = createGitPersister(accountId)

/**
 * The `prepared` scenario crashes at the OTHER Stage-1 boundary: after the
 * attempt is durably `prepared` but strictly before the dispatching
 * transition, so the venue is provably untouched. The persister itself is the
 * only deterministic hook before dispatch: once it has written an all-prepared
 * attempt, signal the parent synchronously and block the thread until SIGKILL.
 */
function persist(state: GitExportState): void {
  persistRaw(state)
  if (mode !== 'crash' || scenario !== 'prepared') return
  const attempt = isMutationEnvelopeV1(state.mutation) ? state.mutation.activeAttempt : undefined
  if (!attempt || attempt.operations.length === 0) return
  if (!attempt.operations.every((operation) => operation.state === 'prepared')) return
  writeSync(1, 'PREPARED_DURABLE\n')
  // Synchronous forever-block: nothing after this durable write may run —
  // especially not the dispatching transition. Only SIGKILL ends the fixture.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
}

const config: TradingGitConfig = {
  getGitState: async () => emptyGitState(),
  onCommit: persist,
  executeOperation: async (operation: Operation) => {
    recordDurableVenueCall(operation)

    if (mode === 'crash') {
      await writeStdout('VENUE_DURABLE')
      // A bare unresolved top-level await does not keep Node alive (it exits
      // with code 13 once the event loop is empty). Keep a referenced handle
      // alive so only the parent's explicit process kill ends this fixture.
      await new Promise<never>(() => {
        const keepAlive = setInterval(() => {}, 60_000)
        keepAlive.ref()
      })
    }

    return { success: true, orderId: `unexpected-replay-${countVenueCalls()}` }
  },
}

async function attemptMutation(git: TradingGit, kind: CrashScenario): Promise<void> {
  if (kind === 'push' || kind === 'prepared') {
    if (mode === 'crash') {
      git.add(mutationOperation(kind))
      git.commit('process crash quarantine probe')
    }
    await git.push(approver)
    return
  }

  await git.executeSyntheticMutation({
    kind,
    message: `process crash quarantine ${kind}`,
    approver,
    prepare: async () => [mutationOperation(kind)],
    execute: config.executeOperation,
  })
}

if (mode === 'crash') {
  const git = new TradingGit(config)
  await attemptMutation(git, scenario)
  throw new Error('Crash fixture mutation unexpectedly returned')
}

const saved = await loadGitState(accountId)
if (!saved) throw new Error(`No persisted git state for ${accountId}`)

const git = TradingGit.restore(saved, config)
const before = git.status()
let retryError: string | undefined
try {
  await attemptMutation(git, scenario)
} catch (error) {
  retryError = error instanceof Error ? error.message : String(error)
}

// For the prepared-state crash the durable record PROVES dispatch never
// began, so the safe human exit is an audited discard — exercise it.
let discard: { resolved: boolean; readiness: string; commitResultStatus?: string } | undefined
if (scenario === 'prepared') {
  const attemptId = git.status().mutation?.activeAttempt?.attemptId
  if (attemptId) {
    const resolution = await git.resolveMutation({
      attemptId,
      action: 'discard-never-dispatched',
      reason: 'durable prepared state proves dispatch never began',
      confirmation: attemptId,
      approver,
    })
    discard = {
      resolved: resolution.resolved,
      readiness: resolution.readiness,
      commitResultStatus: resolution.hash
        ? git.show(resolution.hash)?.results[0]?.status
        : undefined,
    }
  }
}

await writeStdout(`RECOVERY_RESULT ${JSON.stringify({
  before,
  after: git.status(),
  retryError,
  discard,
  venueCalls: countVenueCalls(),
})}`)
