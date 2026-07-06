/**
 * Agent Event Type System — typed event registry with runtime validation.
 *
 * `AgentEvents` is the single source of truth: each event type maps to a
 * metadata record holding its TypeBox schema, whether it's externally
 * ingestable, and an optional human-readable description.
 *
 * `AgentEventSchemas` and `isExternalEventType` are derived views exposed
 * for ergonomics and backward compatibility.
 *
 * Adding a new event type:
 *   1. Define its payload interface
 *   2. Add it to `AgentEventMap`
 *   3. Add an entry to `AgentEvents` with schema + (optional) external/description
 */

import { Type, type TSchema } from '@sinclair/typebox'
import AjvPkg from 'ajv'
import type { AuthzLevel } from '@traderalice/uta-protocol'

// The cron engine was retired (workspace self-scheduling replaced it). The
// `cron.fire` event type stays defined here as the event bus's canonical sample
// event (kept so the bus specs don't churn); it has no producer/listener now.
export interface CronFirePayload {
  jobId: string
  jobName: string
  payload: string
  workspaceId?: string
  agent?: string
}

/**
 * Which trigger source produced an AgentWork request — the routing key
 * the agent-work-listener uses to pick a source config. Canonical home
 * for this union (it used to live in the now-deleted notifications-store
 * as `NotificationSource`). Kept in lockstep with the TypeBox
 * `SourceUnion` literals below.
 */
export type AgentWorkSource = 'heartbeat' | 'cron' | 'task' | 'manual'

// ==================== Payload Interfaces ====================

export interface MessageReceivedPayload {
  channel: string
  to: string
  prompt: string
}

export interface MessageSentPayload {
  channel: string
  to: string
  prompt: string
  reply: string
  durationMs: number
}

export type TradeEventGuardVerdictStatus = 'pass' | 'reject' | 'skipped'
export type TradeEventRiskState = 'NORMAL' | 'CAUTIOUS' | 'READ_ONLY' | 'HALT'
export type TradeEventRiskTransitionBy = 'auto' | 'human'

export interface TradeEventApproverIdentity {
  via: 'alice-bff' | 'loopback' | 'auto-push-paper'
  fingerprint?: string
  at: string
}

export type TradeEventMetricValue = string | number | boolean | null
export type TradeEventMetrics = Record<string, TradeEventMetricValue>

export interface TradeEventOperationSummary {
  action: string
  symbol: string
  side?: string
  orderType?: string
  quantity?: string
  cashQuantity?: string
  price?: string
  orderId?: string
  status?: string
  error?: string
}

export interface TradeEventGuardVerdict {
  operationIndex: number
  operationAction: string
  symbol: string
  guard: string
  verdict: TradeEventGuardVerdictStatus
  reason?: string
  metrics?: TradeEventMetrics
}

export interface TradeEventRiskSnapshot {
  state: TradeEventRiskState
  reason?: string
  updatedAt?: string
  metrics?: TradeEventMetrics
}

export interface TradeEventGuardSummary {
  configured: string[]
  evaluated: number
  passed: number
  rejected: number
  skipped: number
}

export interface TradeCommittedPayload {
  id: string
  accountId: string
  operationCount: number
  operations: TradeEventOperationSummary[]
  thesis: {
    excerpt: string
    hash: string
  }
}

export interface TradePushedPayload {
  id: string
  accountId: string
  operationCount: number
  operations: TradeEventOperationSummary[]
  approver: TradeEventApproverIdentity
  guards: TradeEventGuardVerdict[]
  guardSummary: TradeEventGuardSummary
  risk: TradeEventRiskSnapshot
}

export interface TradeExecutedPayload {
  id: string
  accountId: string
  commitHash: string
  operation: TradeEventOperationSummary
  orderId?: string
  status: 'filled'
  filledQty?: string
  filledPrice?: string
  source: 'push' | 'sync'
}

export interface TradeRejectedPayload {
  id: string
  accountId: string
  operationCount: number
  operations: TradeEventOperationSummary[]
  reason: string
  approver?: TradeEventApproverIdentity
  guards: TradeEventGuardVerdict[]
  rejectingGuards: TradeEventGuardVerdict[]
  risk: TradeEventRiskSnapshot
}

export interface RiskStateChangedPayload {
  accountId: string
  from: TradeEventRiskState
  to: TradeEventRiskState
  by: TradeEventRiskTransitionBy
  reason: string
  at: string
  triggerIdentity?: TradeEventApproverIdentity
  metrics?: TradeEventMetrics
}

export interface RiskEmergencyStopPayload {
  accountId: string
  hash: string
  reason: string
  cancelOrders: boolean
  triggerIdentity?: TradeEventApproverIdentity
  outcomes: Array<{
    orderId: string
    symbol: string
    aliceId?: string
    success: boolean
    status: string
    error?: string
  }>
}

export interface RiskFlattenPayload {
  accountId: string
  hash: string
  triggerIdentity?: TradeEventApproverIdentity
  outcomes: Array<{
    symbol: string
    aliceId?: string
    side: string
    quantity: string
    success: boolean
    orderId?: string
    status: string
    error?: string
  }>
}

export interface AuthzLevelChangedPayload {
  scope: 'workspace' | 'account'
  id: string
  from: AuthzLevel
  to: AuthzLevel
  approver: TradeEventApproverIdentity
}

// ==================== Canonical AgentWork events ====================
//
// DORMANT since World B was deleted: the in-process consumer
// (agent-work-listener) is gone, so nothing acts on these today.
// `agent.work.requested` is still externally-ingestable via the webhook
// `/api/events/ingest` (it lands in the event log + Flow), kept so a future
// webhook→headless-workspace listener can consume it without re-adding a wire
// type. done/skip/error are no longer emitted by anyone. The `source` field is
// the routing key consumers would filter on.

export interface AgentWorkRequestedPayload {
  /** Which trigger source produced this work request. */
  source: AgentWorkSource
  /** The AI prompt to execute. */
  prompt: string
  /** Trigger-specific metadata, surfaced back on the canonical
   *  done/skip/error events via per-source payload builders. */
  metadata?: Record<string, unknown>
}

export interface AgentWorkDonePayload {
  source: AgentWorkSource
  reply: string
  durationMs: number
  /** Did the notification actually reach the connector? */
  delivered: boolean
  metadata?: Record<string, unknown>
}

export interface AgentWorkSkipPayload {
  source: AgentWorkSource
  /** Free-form reason — e.g. 'ack' | 'duplicate' | 'empty' |
   *  'outside-active-hours' | per-source extension. */
  reason: string
  metadata?: Record<string, unknown>
}

export interface AgentWorkErrorPayload {
  source: AgentWorkSource
  error: string
  durationMs: number
  metadata?: Record<string, unknown>
}

// ==================== Event Map ====================

export interface AgentEventMap {
  'cron.fire': CronFirePayload
  'message.received': MessageReceivedPayload
  'message.sent': MessageSentPayload
  'trade.committed': TradeCommittedPayload
  'trade.pushed': TradePushedPayload
  'trade.executed': TradeExecutedPayload
  'trade.rejected': TradeRejectedPayload
  'risk.state-changed': RiskStateChangedPayload
  'risk.emergency-stop': RiskEmergencyStopPayload
  'risk.flatten': RiskFlattenPayload
  'authz.level-changed': AuthzLevelChangedPayload
  'agent.work.requested': AgentWorkRequestedPayload
  'agent.work.done':      AgentWorkDonePayload
  'agent.work.skip':      AgentWorkSkipPayload
  'agent.work.error':     AgentWorkErrorPayload
}

// ==================== TypeBox Schemas ====================

const CronFireSchema = Type.Object({
  jobId: Type.String(),
  jobName: Type.String(),
  payload: Type.String(),
  // Dispatch target (headless workspace run). Optional for pre-headless jobs.
  workspaceId: Type.Optional(Type.String()),
  agent: Type.Optional(Type.String()),
})

const MessageReceivedSchema = Type.Object({
  channel: Type.String(),
  to: Type.String(),
  prompt: Type.String(),
})

const MessageSentSchema = Type.Object({
  channel: Type.String(),
  to: Type.String(),
  prompt: Type.String(),
  reply: Type.String(),
  durationMs: Type.Number(),
})

const TradeMetricValueSchema = Type.Union([
  Type.String(),
  Type.Number(),
  Type.Boolean(),
  Type.Null(),
])

const TradeMetricsSchema = Type.Record(Type.String(), TradeMetricValueSchema)

const ApproverIdentitySchema = Type.Object({
  via: Type.Union([
    Type.Literal('alice-bff'),
    Type.Literal('loopback'),
    Type.Literal('auto-push-paper'),
  ]),
  fingerprint: Type.Optional(Type.String()),
  at: Type.String(),
})

const TradeOperationSummarySchema = Type.Object({
  action: Type.String(),
  symbol: Type.String(),
  side: Type.Optional(Type.String()),
  orderType: Type.Optional(Type.String()),
  quantity: Type.Optional(Type.String()),
  cashQuantity: Type.Optional(Type.String()),
  price: Type.Optional(Type.String()),
  orderId: Type.Optional(Type.String()),
  status: Type.Optional(Type.String()),
  error: Type.Optional(Type.String()),
})

const TradeGuardVerdictSchema = Type.Object({
  operationIndex: Type.Number(),
  operationAction: Type.String(),
  symbol: Type.String(),
  guard: Type.String(),
  verdict: Type.Union([
    Type.Literal('pass'),
    Type.Literal('reject'),
    Type.Literal('skipped'),
  ]),
  reason: Type.Optional(Type.String()),
  metrics: Type.Optional(TradeMetricsSchema),
})

const RiskStateUnion = Type.Union([
  Type.Literal('NORMAL'),
  Type.Literal('CAUTIOUS'),
  Type.Literal('READ_ONLY'),
  Type.Literal('HALT'),
])

const TradeRiskSnapshotSchema = Type.Object({
  state: RiskStateUnion,
  reason: Type.Optional(Type.String()),
  updatedAt: Type.Optional(Type.String()),
  metrics: Type.Optional(TradeMetricsSchema),
})

const TradeGuardSummarySchema = Type.Object({
  configured: Type.Array(Type.String()),
  evaluated: Type.Number(),
  passed: Type.Number(),
  rejected: Type.Number(),
  skipped: Type.Number(),
})

const TradeCommittedSchema = Type.Object({
  id: Type.String(),
  accountId: Type.String(),
  operationCount: Type.Number(),
  operations: Type.Array(TradeOperationSummarySchema),
  thesis: Type.Object({
    excerpt: Type.String(),
    hash: Type.String(),
  }),
})

const TradePushedSchema = Type.Object({
  id: Type.String(),
  accountId: Type.String(),
  operationCount: Type.Number(),
  operations: Type.Array(TradeOperationSummarySchema),
  approver: ApproverIdentitySchema,
  guards: Type.Array(TradeGuardVerdictSchema),
  guardSummary: TradeGuardSummarySchema,
  risk: TradeRiskSnapshotSchema,
})

const TradeExecutedSchema = Type.Object({
  id: Type.String(),
  accountId: Type.String(),
  commitHash: Type.String(),
  operation: TradeOperationSummarySchema,
  orderId: Type.Optional(Type.String()),
  status: Type.Literal('filled'),
  filledQty: Type.Optional(Type.String()),
  filledPrice: Type.Optional(Type.String()),
  source: Type.Union([Type.Literal('push'), Type.Literal('sync')]),
})

const TradeRejectedSchema = Type.Object({
  id: Type.String(),
  accountId: Type.String(),
  operationCount: Type.Number(),
  operations: Type.Array(TradeOperationSummarySchema),
  reason: Type.String(),
  approver: Type.Optional(ApproverIdentitySchema),
  guards: Type.Array(TradeGuardVerdictSchema),
  rejectingGuards: Type.Array(TradeGuardVerdictSchema),
  risk: TradeRiskSnapshotSchema,
})

const RiskStateChangedSchema = Type.Object({
  accountId: Type.String(),
  from: RiskStateUnion,
  to: RiskStateUnion,
  by: Type.Union([Type.Literal('auto'), Type.Literal('human')]),
  reason: Type.String(),
  at: Type.String(),
  triggerIdentity: Type.Optional(ApproverIdentitySchema),
  metrics: Type.Optional(TradeMetricsSchema),
})

const RiskEmergencyStopSchema = Type.Object({
  accountId: Type.String(),
  hash: Type.String(),
  reason: Type.String(),
  cancelOrders: Type.Boolean(),
  triggerIdentity: Type.Optional(ApproverIdentitySchema),
  outcomes: Type.Array(Type.Object({
    orderId: Type.String(),
    symbol: Type.String(),
    aliceId: Type.Optional(Type.String()),
    success: Type.Boolean(),
    status: Type.String(),
    error: Type.Optional(Type.String()),
  })),
})

const RiskFlattenSchema = Type.Object({
  accountId: Type.String(),
  hash: Type.String(),
  triggerIdentity: Type.Optional(ApproverIdentitySchema),
  outcomes: Type.Array(Type.Object({
    symbol: Type.String(),
    aliceId: Type.Optional(Type.String()),
    side: Type.String(),
    quantity: Type.String(),
    success: Type.Boolean(),
    orderId: Type.Optional(Type.String()),
    status: Type.String(),
    error: Type.Optional(Type.String()),
  })),
})

const AuthzLevelUnion = Type.Union([
  Type.Literal('read_only'),
  Type.Literal('paper'),
  Type.Literal('small_live'),
  Type.Literal('limited_autonomy'),
])

const AuthzLevelChangedSchema = Type.Object({
  scope: Type.Union([Type.Literal('workspace'), Type.Literal('account')]),
  id: Type.String(),
  from: AuthzLevelUnion,
  to: AuthzLevelUnion,
  approver: ApproverIdentitySchema,
})

// ---- Canonical agent-work event schemas ----
//
// `source` is constrained to the AgentWorkSource union literal set.
// Free-form `metadata` is `unknown` at validation time (downstream
// shape decided per-source).

const SourceUnion = Type.Union([
  Type.Literal('heartbeat'),
  Type.Literal('cron'),
  Type.Literal('task'),
  Type.Literal('manual'),
])

const AgentWorkRequestedSchema = Type.Object({
  source: SourceUnion,
  prompt: Type.String(),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
})

const AgentWorkDoneSchema = Type.Object({
  source: SourceUnion,
  reply: Type.String(),
  durationMs: Type.Number(),
  delivered: Type.Boolean(),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
})

const AgentWorkSkipSchema = Type.Object({
  source: SourceUnion,
  reason: Type.String(),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
})

const AgentWorkErrorSchema = Type.Object({
  source: SourceUnion,
  error: Type.String(),
  durationMs: Type.Number(),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
})

// ==================== AgentEvents — metadata registry ====================

export interface AgentEventMeta {
  /** TypeBox schema for runtime payload validation. */
  schema: TSchema
  /** If true, this event type may be ingested from outside the process
   *  (HTTP webhook, external API). Internal-only types cannot be
   *  forged by external callers. Default: false. */
  external?: boolean
  /** Optional human-readable description — surfaced in topology UI tooltips. */
  description?: string
}

/** Single source of truth — metadata for every registered event type. */
export const AgentEvents: { [K in keyof AgentEventMap]: AgentEventMeta } = {
  'cron.fire': {
    schema: CronFireSchema,
    description: 'Cron scheduler timer fired for a registered job.',
  },
  'message.received': {
    schema: MessageReceivedSchema,
    description: 'A user message arrived on a connector (Web chat, Telegram, etc.).',
  },
  'message.sent': {
    schema: MessageSentSchema,
    description: 'An assistant reply was dispatched on a connector.',
  },
  'trade.committed': {
    schema: TradeCommittedSchema,
    description: 'UTA prepared a pending trading commit and is waiting for approval.',
  },
  'trade.pushed': {
    schema: TradePushedSchema,
    description: 'A pending trading commit was approved and pushed to the broker; includes approver, guard verdicts, and risk state.',
  },
  'trade.executed': {
    schema: TradeExecutedSchema,
    description: 'A pushed trading operation reached a terminal filled state, either immediately or through sync.',
  },
  'trade.rejected': {
    schema: TradeRejectedSchema,
    description: 'A trading push was refused by guards or the risk state machine.',
  },
  'risk.state-changed': {
    schema: RiskStateChangedSchema,
    description: 'UTA risk state changed by a human action or automatic P1 risk transition.',
  },
  'risk.emergency-stop': {
    schema: RiskEmergencyStopSchema,
    description: 'A human-triggered emergency stop ran, including trigger identity and per-order cancellation outcomes.',
  },
  'risk.flatten': {
    schema: RiskFlattenSchema,
    description: 'A human-triggered flatten action ran, including trigger identity and per-position close outcomes.',
  },
  'authz.level-changed': {
    schema: AuthzLevelChangedSchema,
    description: 'A human changed a workspace authzLevel or account maxAuthzLevel; includes approver identity.',
  },
  'agent.work.requested': {
    schema: AgentWorkRequestedSchema,
    external: true,
    description: 'Canonical request to dispatch an AgentWork task. Carries `source` (which trigger produced it) plus the AI prompt. Ingestible via POST /api/events/ingest; the webhook layer also accepts the legacy `task.requested` event type and translates it to this canonical form.',
  },
  'agent.work.done': {
    schema: AgentWorkDoneSchema,
    description: 'An AgentWork task completed and its reply was dispatched. Filter on payload.source to attribute to a specific trigger (heartbeat / cron / task).',
  },
  'agent.work.skip': {
    schema: AgentWorkSkipSchema,
    description: 'An AgentWork task was suppressed before delivery (dedup, empty content, outside active hours, AI declined to notify, …). Filter on payload.source for trigger attribution.',
  },
  'agent.work.error': {
    schema: AgentWorkErrorSchema,
    description: 'An AgentWork task failed during execution. Filter on payload.source for trigger attribution.',
  },
}

// ==================== Derived views ====================

/** Schemas-only map — derived for Ajv compilation and existing consumers. */
export const AgentEventSchemas: { [K in keyof AgentEventMap]: TSchema } =
  Object.fromEntries(
    (Object.keys(AgentEvents) as Array<keyof AgentEventMap>).map(
      (k) => [k, AgentEvents[k].schema],
    ),
  ) as { [K in keyof AgentEventMap]: TSchema }

/** Whether this event type may be ingested from outside the process. */
export function isExternalEventType(type: string): boolean {
  return (
    type in AgentEvents &&
    AgentEvents[type as keyof AgentEventMap].external === true
  )
}

// ==================== Runtime Validation ====================

// Ajv ESM interop — package's default export is on `.default` under ESM
const ajv = new (AjvPkg as unknown as new (opts?: object) => import('ajv').default)({
  allErrors: true,
  strict: false,
})

const validators = new Map<string, ReturnType<typeof ajv.compile>>()
for (const [type, meta] of Object.entries(AgentEvents)) {
  validators.set(type, ajv.compile(meta.schema))
}

/**
 * Validate a payload against its registered schema.
 * - Registered type + valid payload → returns silently
 * - Registered type + invalid payload → throws Error
 * - Unregistered type → returns silently (no schema to check)
 */
export function validateEventPayload(type: string, payload: unknown): void {
  const validate = validators.get(type)
  if (!validate) return
  if (!validate(payload)) {
    const errors = validate.errors?.map(e => `${e.instancePath || '/'} ${e.message}`).join('; ')
    throw new Error(`Invalid payload for event "${type}": ${errors}`)
  }
}
