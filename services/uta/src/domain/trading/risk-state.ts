/**
 * Per-account risk state machine.
 *
 * Storage layout:
 *   data/trading/{accountId}/risk-state.json
 *
 * The file is separate from git commits, snapshots, and portfolio guard
 * baselines: risk posture must survive restarts even when no trading activity
 * or snapshot has happened recently. Corrupt/unreadable files fail closed to
 * READ_ONLY and never silently reset an account to NORMAL.
 */

import Decimal from 'decimal.js'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { dataPath } from '@/core/paths.js'
import type {
  AccountInfo,
  RiskState,
  RiskStateInfo,
  RiskStateMetrics,
  RiskStateTransition,
} from '@traderalice/uta-protocol'
import {
  createPortfolioGuardStateStore,
  type PortfolioGuardStateStore,
} from './guards/portfolio-state.js'

const STATE_FILE = 'risk-state.json'
const DEFAULT_BASE_DIR = dataPath('trading')
const HISTORY_LIMIT = 100
const DEFAULT_SEVERE_MULTIPLIER = 1.5
const DEFAULT_MAX_DRAWDOWN_PCT = 10
const DEFAULT_MAX_DAILY_LOSS_PCT = 5

const RISK_RANK: Record<RiskState, number> = {
  NORMAL: 0,
  CAUTIOUS: 1,
  READ_ONLY: 2,
  HALT: 3,
}

export type HumanRecoverableRiskState = Exclude<RiskState, 'HALT'>

export interface RiskStateStoreOptions {
  baseDir?: string
  now?: () => Date
}

export interface PersistedRiskState {
  version: 1
  state: RiskState
  reason?: string
  metrics?: RiskStateMetrics
  updatedAt?: string
  history: RiskStateTransition[]
}

interface InitialRiskState {
  state: PersistedRiskState
  corruptFilePath?: string
}

export interface RiskStateStore {
  current(): RiskStateInfo
  autoTighten(input: {
    target: Exclude<RiskState, 'NORMAL'>
    reason: string
    metrics?: RiskStateMetrics
    at?: Date
  }): Promise<RiskStateInfo>
  humanSet(input: {
    state: RiskState
    reason: string
    metrics?: RiskStateMetrics
    at?: Date
  }): Promise<RiskStateInfo>
}

export interface RiskGuardConfig {
  type: string
  options?: Record<string, unknown>
}

export interface RiskStateEvaluator {
  evaluate(account: Readonly<AccountInfo>): Promise<RiskStateInfo>
}

export interface RiskStateEvaluatorOptions {
  accountId: string
  guards: RiskGuardConfig[]
  riskStateStore: RiskStateStore
  portfolioStateStore?: PortfolioGuardStateStore
  stateBaseDir?: string
  now?: () => Date
}

export function riskStatePath(accountId: string, options?: RiskStateStoreOptions): string {
  return resolve(options?.baseDir ?? DEFAULT_BASE_DIR, accountId, STATE_FILE)
}

export function createRiskStateStore(
  accountId: string,
  options: RiskStateStoreOptions = {},
): RiskStateStore {
  const filePath = riskStatePath(accountId, options)
  const now = options.now ?? (() => new Date())
  const initial = readInitialState(accountId, filePath)
  let state = initial.state
  let pendingCorruptFilePath = initial.corruptFilePath
  let writeChain = Promise.resolve()

  async function writeState(next: PersistedRiskState): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true })
    if (pendingCorruptFilePath) {
      const quarantine = `${pendingCorruptFilePath}.corrupt-${Date.now()}`
      await rename(pendingCorruptFilePath, quarantine)
      pendingCorruptFilePath = undefined
      console.error(`risk-state[${accountId}]: preserved unreadable risk state file at ${quarantine}`)
    }
    const tmp = `${filePath}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(next, null, 2), 'utf-8')
    await rename(tmp, filePath)
  }

  function transition(input: {
    to: RiskState
    by: RiskStateTransition['by']
    reason: string
    metrics?: RiskStateMetrics
    at?: Date
    recordEvenIfSame?: boolean
  }): Promise<RiskStateInfo> {
    const nextWrite = writeChain.then(async () => {
      const from = state.state
      if (input.by === 'auto' && RISK_RANK[input.to] <= RISK_RANK[from]) return toInfo(state)
      if (from === input.to && !input.recordEvenIfSame) return toInfo(state)

      const at = (input.at ?? now()).toISOString()
      const entry: RiskStateTransition = {
        from,
        to: input.to,
        by: input.by,
        reason: input.reason,
        ...(input.metrics ? { metrics: input.metrics } : {}),
        at,
      }
      state = normalize({
        version: 1,
        state: input.to,
        reason: input.reason,
        ...(input.metrics ? { metrics: input.metrics } : {}),
        updatedAt: at,
        history: [...state.history, entry].slice(-HISTORY_LIMIT),
      })
      await writeState(state)
      logTransition(accountId, entry)
      return toInfo(state)
    })
    writeChain = nextWrite.then(() => undefined, () => undefined)
    return nextWrite
  }

  return {
    current() {
      return toInfo(state)
    },

    autoTighten(input) {
      if (RISK_RANK[input.target] <= RISK_RANK[state.state]) {
        return Promise.resolve(toInfo(state))
      }
      return transition({
        to: input.target,
        by: 'auto',
        reason: input.reason,
        metrics: input.metrics,
        at: input.at,
      })
    },

    humanSet(input) {
      return transition({
        to: input.state,
        by: 'human',
        reason: input.reason,
        metrics: input.metrics,
        at: input.at,
        recordEvenIfSame: true,
      })
    },
  }
}

export function createRiskStateEvaluator(options: RiskStateEvaluatorOptions): RiskStateEvaluator {
  const portfolioStateStore = options.portfolioStateStore
    ?? createPortfolioGuardStateStore(
      options.accountId,
      options.stateBaseDir ? { baseDir: options.stateBaseDir } : undefined,
    )
  const now = options.now ?? (() => new Date())
  const triggers = options.guards
    .map(parseRiskTrigger)
    .filter((t): t is RiskTrigger => t != null)

  return {
    async evaluate(account) {
      if (triggers.length === 0) return options.riskStateStore.current()

      const equity = new Decimal(account.netLiquidation)
      const candidates: Array<{
        target: Exclude<RiskState, 'NORMAL'>
        reason: string
        metrics: RiskStateMetrics
      }> = []

      for (const trigger of triggers) {
        if (trigger.type === 'max-drawdown') {
          candidates.push(...await evaluateMaxDrawdown(portfolioStateStore, equity, trigger))
        } else {
          candidates.push(...await evaluateDailyLoss(portfolioStateStore, equity, trigger, now))
        }
      }

      candidates.sort((a, b) => RISK_RANK[b.target] - RISK_RANK[a.target])
      const strongest = candidates[0]
      if (!strongest) return options.riskStateStore.current()

      return options.riskStateStore.autoTighten(strongest)
    },
  }
}

export function isRiskStateReadOnly(state: RiskState): boolean {
  return state === 'READ_ONLY' || state === 'HALT'
}

export function isLooserRiskState(from: RiskState, to: RiskState): boolean {
  return RISK_RANK[to] < RISK_RANK[from]
}

function readInitialState(accountId: string, filePath: string): InitialRiskState {
  if (!existsSync(filePath)) return { state: emptyState() }
  try {
    return { state: normalize(JSON.parse(readFileSync(filePath, 'utf-8'))) }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`risk-state[${accountId}]: failed to read ${filePath}; forcing READ_ONLY: ${msg}`)
    return {
      state: {
        version: 1,
        state: 'READ_ONLY',
        reason: `Risk state file is corrupt or unreadable: ${msg}`,
        metrics: { failClosed: true },
        updatedAt: new Date().toISOString(),
        history: [],
      },
      corruptFilePath: filePath,
    }
  }
}

function emptyState(): PersistedRiskState {
  return { version: 1, state: 'NORMAL', history: [] }
}

function normalize(raw: unknown): PersistedRiskState {
  if (!isRecord(raw) || raw.version !== 1 || !isRiskState(raw.state)) {
    throw new Error('risk state: unsupported or corrupt state file')
  }
  const state: PersistedRiskState = {
    version: 1,
    state: raw.state,
    history: [],
  }
  if (raw.reason !== undefined) {
    if (typeof raw.reason !== 'string') throw new Error('risk state: corrupt reason')
    state.reason = raw.reason
  }
  if (raw.metrics !== undefined) state.metrics = normalizeMetrics(raw.metrics)
  if (raw.updatedAt !== undefined) {
    if (typeof raw.updatedAt !== 'string') throw new Error('risk state: corrupt updatedAt')
    state.updatedAt = raw.updatedAt
  }
  if (!Array.isArray(raw.history)) throw new Error('risk state: corrupt history')
  state.history = raw.history.map(normalizeTransition).slice(-HISTORY_LIMIT)
  return state
}

function normalizeTransition(raw: unknown): RiskStateTransition {
  if (!isRecord(raw) || !isRiskState(raw.from) || !isRiskState(raw.to)) {
    throw new Error('risk state: corrupt history entry')
  }
  if (raw.by !== 'auto' && raw.by !== 'human') throw new Error('risk state: corrupt history entry')
  if (typeof raw.reason !== 'string' || typeof raw.at !== 'string') {
    throw new Error('risk state: corrupt history entry')
  }
  return {
    from: raw.from,
    to: raw.to,
    by: raw.by,
    reason: raw.reason,
    ...(raw.metrics !== undefined ? { metrics: normalizeMetrics(raw.metrics) } : {}),
    at: raw.at,
  }
}

function normalizeMetrics(raw: unknown): RiskStateMetrics {
  if (!isRecord(raw)) throw new Error('risk state: corrupt metrics')
  const out: RiskStateMetrics = {}
  for (const [key, value] of Object.entries(raw)) {
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      value === null
    ) {
      out[key] = value
      continue
    }
    throw new Error(`risk state: corrupt metric "${key}"`)
  }
  return out
}

function toInfo(state: PersistedRiskState): RiskStateInfo {
  return {
    state: state.state,
    ...(state.reason ? { reason: state.reason } : {}),
    ...(state.metrics ? { metrics: { ...state.metrics } } : {}),
    ...(state.updatedAt ? { updatedAt: state.updatedAt } : {}),
    history: state.history.map((h) => ({
      ...h,
      ...(h.metrics ? { metrics: { ...h.metrics } } : {}),
    })),
  }
}

function logTransition(accountId: string, entry: RiskStateTransition): void {
  const line = `risk-state[${accountId}]: ${entry.from} -> ${entry.to} by ${entry.by}; reason=${entry.reason}; metrics=${JSON.stringify(entry.metrics ?? {})}`
  // TODO(#P2): emit a persisted account.risk_state_transition event here.
  if (entry.to === 'READ_ONLY' || entry.to === 'HALT') console.error(line)
  else console.warn(line)
}

type RiskTrigger =
  | {
      type: 'max-drawdown'
      thresholdPct: number
      severeMultiplier: number
    }
  | {
      type: 'daily-loss'
      thresholdPct: number
      severeMultiplier: number
    }

function parseRiskTrigger(config: RiskGuardConfig): RiskTrigger | null {
  if (config.type !== 'max-drawdown' && config.type !== 'daily-loss') return null
  const options = config.options ?? {}
  const thresholdPct = config.type === 'max-drawdown'
    ? numericOption(options.maxDrawdownPct, DEFAULT_MAX_DRAWDOWN_PCT)
    : numericOption(options.maxDailyLossPct, DEFAULT_MAX_DAILY_LOSS_PCT)
  const severeMultiplier = numericOption(
    options.severeBreachMultiplier ?? options.riskStateSevereMultiplier,
    DEFAULT_SEVERE_MULTIPLIER,
  )
  return { type: config.type, thresholdPct, severeMultiplier }
}

async function evaluateMaxDrawdown(
  stateStore: PortfolioGuardStateStore,
  equity: Decimal,
  trigger: Extract<RiskTrigger, { type: 'max-drawdown' }>,
): Promise<Array<{ target: Exclude<RiskState, 'NORMAL'>; reason: string; metrics: RiskStateMetrics }>> {
  const state = await stateStore.update((draft) => {
    const current = new Decimal(draft.maxDrawdown?.highWaterMark ?? equity)
    if (!draft.maxDrawdown || equity.gt(current)) {
      draft.maxDrawdown = { highWaterMark: equity.toString() }
    }
  })
  const highWaterMark = new Decimal(state.maxDrawdown?.highWaterMark ?? equity)
  const drawdownPct = highWaterMark.gt(0) && equity.lt(highWaterMark)
    ? highWaterMark.minus(equity).div(highWaterMark).mul(100)
    : new Decimal(0)
  if (drawdownPct.lt(trigger.thresholdPct)) return []

  const severePct = new Decimal(trigger.thresholdPct).mul(trigger.severeMultiplier)
  const severe = drawdownPct.gte(severePct)
  const metrics: RiskStateMetrics = {
    trigger: 'max-drawdown',
    drawdownPct: drawdownPct.toNumber(),
    maxDrawdownPct: trigger.thresholdPct,
    severeBreachMultiplier: trigger.severeMultiplier,
    severeThresholdPct: severePct.toNumber(),
    highWaterMark: highWaterMark.toNumber(),
    equity: equity.toNumber(),
  }
  return [{
    target: severe ? 'READ_ONLY' : 'CAUTIOUS',
    reason: `MaxDrawdown breach: drawdown is ${drawdownPct.toFixed(1)}% of equity (limit: ${trigger.thresholdPct}%)`,
    metrics,
  }]
}

async function evaluateDailyLoss(
  stateStore: PortfolioGuardStateStore,
  equity: Decimal,
  trigger: Extract<RiskTrigger, { type: 'daily-loss' }>,
  now: () => Date,
): Promise<Array<{ target: Exclude<RiskState, 'NORMAL'>; reason: string; metrics: RiskStateMetrics }>> {
  const utcDate = now().toISOString().slice(0, 10)
  const state = await stateStore.update((draft) => {
    if (!draft.dailyLoss || draft.dailyLoss.utcDate !== utcDate) {
      draft.dailyLoss = { utcDate, dayStartEquity: equity.toString() }
    }
  })
  const dayStartEquity = new Decimal(state.dailyLoss?.dayStartEquity ?? equity)
  const dailyLossPct = dayStartEquity.gt(0) && equity.lt(dayStartEquity)
    ? dayStartEquity.minus(equity).div(dayStartEquity).mul(100)
    : new Decimal(0)
  if (dailyLossPct.lt(trigger.thresholdPct)) return []

  const severePct = new Decimal(trigger.thresholdPct).mul(trigger.severeMultiplier)
  const severe = dailyLossPct.gte(severePct)
  const metrics: RiskStateMetrics = {
    trigger: 'daily-loss',
    dailyLossPct: dailyLossPct.toNumber(),
    maxDailyLossPct: trigger.thresholdPct,
    severeBreachMultiplier: trigger.severeMultiplier,
    severeThresholdPct: severePct.toNumber(),
    dayStartEquity: dayStartEquity.toNumber(),
    equity: equity.toNumber(),
    utcDate,
  }
  return [{
    target: severe ? 'READ_ONLY' : 'CAUTIOUS',
    reason: `DailyLoss breach: daily loss is ${dailyLossPct.toFixed(1)}% of day-start equity (limit: ${trigger.thresholdPct}%)`,
    metrics,
  }]
}

function numericOption(value: unknown, fallback: number): number {
  const n = Number(value ?? fallback)
  return Number.isFinite(n) ? n : fallback
}

function isRiskState(value: unknown): value is RiskState {
  return value === 'NORMAL' || value === 'CAUTIOUS' || value === 'READ_ONLY' || value === 'HALT'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}
