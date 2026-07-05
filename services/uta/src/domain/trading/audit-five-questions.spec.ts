import { afterEach, describe, expect, it } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import Decimal from 'decimal.js'
import { createEventLog, type EventLog, type EventLogEntry } from '@/core/event-log.js'
import type { AgentEventMap } from '@/core/agent-event.js'
import { UnifiedTradingAccount } from './UnifiedTradingAccount.js'
import { MockBroker } from './brokers/mock/index.js'
import { projectOrderHistory } from './order-history.js'
import { riskStatePath, type PersistedRiskState } from './risk-state.js'
import type { GitCommit, GitExportState } from './git/types.js'
import type { ApproverIdentity } from '@traderalice/uta-protocol'
import type { UtaEventSink, UtaLifecycleEventType } from './events.js'
import './contract-ext.js'

type AuditEvent =
  | TypedEntry<'risk.state-changed'>
  | TypedEntry<'trade.committed'>
  | TypedEntry<'trade.pushed'>
  | TypedEntry<'trade.executed'>

type TypedEntry<K extends keyof AgentEventMap> = EventLogEntry<AgentEventMap[K]> & { type: K }

type PersistentSink = UtaEventSink & { events: Promise<EventLogEntry[]> }

const ACCOUNT_ID = 'mock-audit-five'
const RAW_SESSION_ID = `sid-${randomUUID()}`
const APPROVER: ApproverIdentity = {
  via: 'alice-bff',
  fingerprint: fingerprintFor(RAW_SESSION_ID),
  at: '2026-07-05T12:00:00.000Z',
}
const GUARD_TYPES = ['symbol-whitelist', 'cooldown'] as const
const ORDERING_FIXTURE_BASE_TS = 1_800_000_000_000

let tempRoots: string[] = []
let openLogs: EventLog[] = []

afterEach(async () => {
  await Promise.all(openLogs.map((log) => log.close()))
  openLogs = []
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

describe('trading audit five-question reconstruction', () => {
  it('reconstructs what/why/who/checks/outcome from persisted data only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openalice-audit-five-'))
    tempRoots.push(root)
    const dataDir = join(root, 'data')
    const tradingDir = join(dataDir, 'trading')
    const accountDir = join(tradingDir, ACCOUNT_ID)
    const commitPath = join(accountDir, 'commit.json')
    const eventLogPath = join(dataDir, 'event-log', 'events.jsonl')
    const riskPath = riskStatePath(ACCOUNT_ID, { baseDir: tradingDir })

    const eventLog = await createEventLog({ logPath: eventLogPath })
    openLogs.push(eventLog)
    const eventSink = createPersistentSink(eventLog)
    const broker = new MockBroker({ id: ACCOUNT_ID, label: 'Audit Mock Account', cash: 100_000 })
    broker.setQuote('AAPL', 100)
    const uta = new UnifiedTradingAccount(broker, {
      guardStateBaseDir: tradingDir,
      riskStateBaseDir: tradingDir,
      guards: [
        { type: GUARD_TYPES[0], options: { symbols: ['AAPL'] } },
        { type: GUARD_TYPES[1], options: { minIntervalMs: 60_000 } },
      ],
      eventSink,
      onCommit: (state) => persistJson(commitPath, state),
    })
    await uta.waitForConnect()
    await uta.setRiskState('NORMAL', 'audit baseline before approval drill', APPROVER)

    const account = await broker.getAccount()
    const quote = await uta.getQuote(uta.contractFromAliceId(`${ACCOUNT_ID}|AAPL`))
    const thesis = [
      `Thesis: observed ${ACCOUNT_ID} cash ${account.totalCashValue}`,
      `AAPL mock quote ${quote.bid}/${quote.ask}`,
      'buy 3 shares with a resting limit and require human approval',
    ].join('; ')

    uta.stagePlaceOrder({
      aliceId: `${ACCOUNT_ID}|AAPL`,
      symbol: 'AAPL',
      action: 'BUY',
      orderType: 'LMT',
      totalQuantity: '3',
      lmtPrice: '101',
    })
    const prepared = uta.commit(thesis)
    const pushed = await uta.push(APPROVER)
    expect(pushed.submitted, 'setup: push must submit the staged mock order').toHaveLength(1)
    const orderId = pushed.submitted[0]?.orderId
    expect(orderId, 'setup: pushed order id is required for fill correlation').toBeDefined()

    broker.fillPendingOrder(orderId!, 99.5)
    const sync = await uta.sync()
    expect(sync.updatedCount, 'setup: sync must persist the terminal fill').toBe(1)
    await eventSink.flush()
    await uta.close()

    const persistedGit = await readJson<GitExportState>(commitPath)
    const persistedRisk = await readJson<PersistedRiskState>(riskPath)
    const persistedEvents = await readJsonl(eventLogPath)

    const orderingFixtureEvents = createTimestampOrderingFixture(persistedEvents)
    const audit = reconstructFiveQuestions({
      accountId: ACCOUNT_ID,
      commitHash: prepared.hash,
      orderId: orderId!,
      git: persistedGit,
      risk: persistedRisk,
      events: orderingFixtureEvents,
    })

    expect(audit.auditEvents.map((entry) => entry.type), 'ordering: audit reconstruction must prefer timestamp before type tiebreak when they disagree').toEqual([
      'trade.committed',
      'trade.pushed',
      'risk.state-changed',
      'trade.executed',
    ])
    expect(audit.lifecycle.map((entry) => entry.type), 'ordering: lifecycle reconstruction must ignore seq and use timestamp/type correlation').toEqual([
      'trade.committed',
      'trade.pushed',
      'trade.executed',
    ])

    expect(audit.pushedCommit.message, 'WHAT IT SAW: pushed commit must persist the observation/thesis context').toContain(`observed ${ACCOUNT_ID} cash 100000`)
    expect(audit.committedEvent.payload.thesis.excerpt, 'WHAT IT SAW: trade.committed must persist the thesis excerpt').toContain('AAPL mock quote')
    expect(audit.committedEvent.payload.thesis.hash, 'WHAT IT SAW: trade.committed thesis hash must match the persisted commit message').toBe(shortHash(audit.pushedCommit.message))

    expect(audit.pushedCommit.message, 'WHY: commit message must persist the human-readable thesis').toBe(thesis)

    expect(audit.pushedCommit.approver, 'WHO APPROVED: pushed TradingGit commit must persist approver identity').toMatchObject({
      via: 'alice-bff',
      fingerprint: APPROVER.fingerprint,
    })
    expect(audit.pushedEvent.payload.approver, 'WHO APPROVED: trade.pushed event must persist approver identity').toMatchObject({
      via: 'alice-bff',
      fingerprint: APPROVER.fingerprint,
    })
    const persistedAuditText = [
      JSON.stringify(persistedGit),
      JSON.stringify(persistedRisk),
      persistedEvents.map((entry) => JSON.stringify(entry)).join('\n'),
    ].join('\n')
    // Meaningful raw-secret leak guard: the fingerprint is persisted, but the raw sid must not be.
    expect(persistedAuditText, 'WHO APPROVED: raw session id must never be persisted in audit artifacts').not.toContain(RAW_SESSION_ID)

    expect(audit.pushedEvent.payload.guards, 'WHICH CHECKS RAN: trade.pushed must carry an explicit guard verdict list').toEqual([
      expect.objectContaining({ guard: 'symbol-whitelist', verdict: 'pass', operationIndex: 0, operationAction: 'placeOrder' }),
      expect.objectContaining({ guard: 'cooldown', verdict: 'pass', operationIndex: 0, operationAction: 'placeOrder' }),
    ])
    expect(audit.pushedEvent.payload.guardSummary, 'WHICH CHECKS RAN: guard summary must preserve the configured guard set').toEqual({
      configured: [...GUARD_TYPES],
      evaluated: 2,
      passed: 2,
      rejected: 0,
      skipped: 0,
    })
    expect(audit.pushedCommit.results[0]?.guardVerdicts, 'WHICH CHECKS RAN: pushed commit result must persist the same guard verdict list').toEqual([
      expect.objectContaining({ guard: 'symbol-whitelist', verdict: 'pass' }),
      expect.objectContaining({ guard: 'cooldown', verdict: 'pass' }),
    ])
    expect(audit.pushedEvent.payload.risk, 'WHICH CHECKS RAN: push event must include the risk snapshot evaluated at approval time').toMatchObject({ state: 'NORMAL' })
    expect(audit.risk.state, 'WHICH CHECKS RAN: risk-state persistence must agree with the push risk snapshot').toBe(audit.pushedEvent.payload.risk.state)

    expect(audit.orderHistory, 'OUTCOME: order history projected from persisted commits must have one order').toHaveLength(1)
    expect(audit.orderHistory[0], 'OUTCOME: order history must show the terminal fill').toMatchObject({
      orderId,
      status: 'filled',
      filledQty: '3',
      avgFillPrice: '99.5',
      commitHash: prepared.hash,
    })
    expect(audit.executedEvent.payload, 'OUTCOME: trade.executed event must persist the same terminal fill').toMatchObject({
      accountId: ACCOUNT_ID,
      orderId,
      status: 'filled',
      filledQty: '3',
      filledPrice: '99.5',
      source: 'sync',
    })
    expect(audit.finalState.positions, 'OUTCOME: persisted account state must contain the filled position').toHaveLength(1)
    const position = audit.finalState.positions[0]
    expect(position?.contract.symbol, 'OUTCOME: persisted position must identify the filled symbol').toBe('AAPL')
    expect(new Decimal(String(position?.quantity)).toString(), 'OUTCOME: persisted position quantity must reconcile with the fill').toBe('3')
    expect(audit.finalState.totalCashValue, 'OUTCOME: persisted cash must reconcile with 3 * 99.5 fill cost').toBe('99701.5')
  })
})

function createPersistentSink(eventLog: EventLog): PersistentSink {
  let chain = Promise.resolve()
  return {
    emit(type, payload) {
      chain = chain.then(async () => {
        await eventLog.append(type, payload)
      })
    },
    async flush() {
      await chain
    },
    async close() {
      await chain
    },
    get events() {
      return eventLog.read()
    },
  }
}

function reconstructFiveQuestions(input: {
  accountId: string
  commitHash: string
  orderId: string
  git: GitExportState
  risk: PersistedRiskState
  events: EventLogEntry[]
}) {
  const pushedCommit = requireCommit(input.git, input.commitHash)
  const auditEvents = sortAuditEvents(input.events.filter((entry): entry is AuditEvent => (
    isType(entry, 'risk.state-changed') ||
    isType(entry, 'trade.committed') ||
    isType(entry, 'trade.pushed') ||
    isType(entry, 'trade.executed')
  )).filter((entry) => {
    const payload = entry.payload as { accountId?: string; id?: string; commitHash?: string; orderId?: string }
    if (payload.accountId !== input.accountId) return false
    if (entry.type === 'trade.executed') return payload.orderId === input.orderId
    if (entry.type === 'risk.state-changed') return true
    return payload.id === input.commitHash || payload.commitHash === input.commitHash
  }))
  const lifecycle = auditEvents.filter((entry) => entry.type !== 'risk.state-changed')
  const committedEvent = requireEvent(lifecycle, 'trade.committed')
  const pushedEvent = requireEvent(lifecycle, 'trade.pushed')
  const executedEvent = requireEvent(lifecycle, 'trade.executed')
  const orderHistory = projectOrderHistory(input.git.commits)
  const finalState = input.git.commits[input.git.commits.length - 1]?.stateAfter
  expect(finalState, 'OUTCOME: final persisted TradingGit state is required').toBeDefined()

  return {
    pushedCommit,
    committedEvent,
    pushedEvent,
    executedEvent,
    auditEvents,
    lifecycle,
    orderHistory,
    risk: input.risk,
    finalState: finalState!,
  }
}

function createTimestampOrderingFixture(events: EventLogEntry[]): EventLogEntry[] {
  const tsByType: Record<AuditEvent['type'], number> = {
    'trade.committed': ORDERING_FIXTURE_BASE_TS,
    'trade.pushed': ORDERING_FIXTURE_BASE_TS + 10,
    'risk.state-changed': ORDERING_FIXTURE_BASE_TS + 20,
    'trade.executed': ORDERING_FIXTURE_BASE_TS + 30,
  }
  const seqByType: Record<AuditEvent['type'], number> = {
    'trade.committed': 30_003,
    'trade.pushed': 30_001,
    'risk.state-changed': 30_004,
    'trade.executed': 30_002,
  }
  return events
    .map((entry, index) => {
      if (!isAuditFixtureType(entry.type)) return { ...entry, seq: 40_000 + index }
      return { ...entry, ts: tsByType[entry.type], seq: seqByType[entry.type] }
    })
    .sort((a, b) => orderingFixtureInputRank(a) - orderingFixtureInputRank(b))
}

function isAuditFixtureType(type: string): type is AuditEvent['type'] {
  return (
    type === 'risk.state-changed' ||
    type === 'trade.committed' ||
    type === 'trade.pushed' ||
    type === 'trade.executed'
  )
}

function orderingFixtureInputRank(entry: EventLogEntry): number {
  if (entry.type === 'trade.executed') return 0
  if (entry.type === 'risk.state-changed') return 1
  if (entry.type === 'trade.pushed') return 2
  if (entry.type === 'trade.committed') return 3
  return 99
}

function sortAuditEvents(events: AuditEvent[]): AuditEvent[] {
  const typeOrder: Record<UtaLifecycleEventType, number> = {
    'risk.state-changed': 0,
    'trade.committed': 1,
    'trade.pushed': 2,
    'trade.executed': 3,
    'trade.rejected': 4,
    'risk.emergency-stop': 5,
    'risk.flatten': 6,
  }
  // #38: Alice and UTA can both append to events.jsonl with independent seq
  // counters, so audit reconstruction must never assume seq is globally
  // monotonic. Correlate by timestamp plus event type / commit id instead.
  return [...events].sort((a, b) => (
    a.ts - b.ts ||
    typeOrder[a.type] - typeOrder[b.type] ||
    auditCorrelationKey(a).localeCompare(auditCorrelationKey(b))
  ))
}

function auditCorrelationKey(entry: AuditEvent): string {
  const payload = entry.payload as { id?: string; commitHash?: string; orderId?: string }
  return payload.id ?? payload.commitHash ?? payload.orderId ?? ''
}

function requireCommit(git: GitExportState, hash: string): GitCommit {
  const commit = git.commits.find((candidate) => candidate.hash === hash)
  expect(commit, `persisted TradingGit commit ${hash} must exist`).toBeDefined()
  return commit!
}

function requireEvent<K extends AuditEvent['type']>(
  events: AuditEvent[],
  type: K,
): Extract<AuditEvent, { type: K }> {
  const event = events.find((entry): entry is Extract<AuditEvent, { type: K }> => entry.type === type)
  expect(event, `persisted event ${type} must exist`).toBeDefined()
  return event!
}

function isType<K extends keyof AgentEventMap>(
  entry: EventLogEntry,
  type: K,
): entry is TypedEntry<K> {
  return entry.type === type
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, 'utf-8')) as T
}

async function readJsonl(filePath: string): Promise<EventLogEntry[]> {
  const raw = await readFile(filePath, 'utf-8')
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as EventLogEntry)
}

function persistJson(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, JSON.stringify(value, null, 2))
}

function fingerprintFor(rawSessionId: string): string {
  return createHash('sha256')
    .update(`openalice-admin-session:${rawSessionId}`)
    .digest('hex')
    .slice(0, 16)
}

function shortHash(message: string): string {
  return createHash('sha256').update(message).digest('hex').slice(0, 16)
}
