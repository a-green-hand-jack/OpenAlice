import { AUTHZ_LEVELS } from '@traderalice/uta-protocol';
import { z } from 'zod';

export const WAKE_SCHEMA_VERSION = 1;
/** Current decision-ledger entry version. v2 (issue #125) makes `actions` a
 *  strict discriminated union and `pendingHash` strict-pending (null once an
 *  action executed). Writes MUST be v2; reads stay lenient for v1 history. */
export const DECISION_LEDGER_SCHEMA_VERSION = 2;
/** Legacy decision-ledger entry version, retained ONLY for the lenient read
 *  path over pre-#125 history — never written. v1 `actions` stay `unknown[]`. */
export const DECISION_LEDGER_SCHEMA_VERSION_V1 = 1;
export const STEWARD_LOCK_SCHEMA_VERSION = 1;
export const STEWARD_STATE_SCHEMA_VERSION = 1;

export const stewardWakeReasonSchema = z.enum([
  'scheduled_observe',
  'market_event',
  'risk_event',
  'user_request',
  'supervisor_recovery',
]);
export type StewardWakeReason = z.infer<typeof stewardWakeReasonSchema>;

export const stewardExpectedDecisionSchema = z.enum(['no_trade', 'propose_trade', 'blocked']);
export type StewardExpectedDecision = z.infer<typeof stewardExpectedDecisionSchema>;

export const stewardWakeStatusSchema = z.enum([
  'queued',
  'injected',
  'done',
  'blocked',
  'error',
  'stuck',
  'timeout',
]);
export type StewardWakeStatus = z.infer<typeof stewardWakeStatusSchema>;

export const stewardDecisionSchema = z.enum(['no_trade', 'propose_trade', 'blocked']);
export type StewardDecision = z.infer<typeof stewardDecisionSchema>;

export const stewardLedgerStatusSchema = z.enum(['done', 'blocked', 'error']);
export type StewardLedgerStatus = z.infer<typeof stewardLedgerStatusSchema>;

export const stewardAuthzLevelSchema = z.enum(AUTHZ_LEVELS);

const jsonRecordSchema = z.record(z.string(), z.unknown());

export const stewardWakeEnvelopeSchema = z.object({
  reason: stewardWakeReasonSchema,
  accountId: z.string().min(1),
  authzLevel: stewardAuthzLevelSchema,
  expectedDecision: stewardExpectedDecisionSchema,
  marketContext: jsonRecordSchema.optional(),
  riskContext: jsonRecordSchema.optional(),
  humanRequest: z.string().optional(),
}).passthrough();
export type StewardWakeEnvelope = z.infer<typeof stewardWakeEnvelopeSchema>;

// Terminal-outcome attribution (issue #132). The status enum stays STABLE (a
// context-overflow timeout is still a `timeout` for every existing consumer —
// campaign harness terminal set, UI); the distinction rides this optional
// structured field instead of widening the enum. Today the only attribution is
// `context_overflow`: the supervisor saw `input_tokens >= model_context_window`
// on the session's rollout when the deadline expired, i.e. the session was
// context-poisoned, not merely slow.
export const stewardWakeAttributionSchema = z.object({
  kind: z.literal('context_overflow'),
  inputTokens: z.coerce.number().int().nonnegative(),
  modelContextWindow: z.coerce.number().int().nonnegative(),
}).passthrough();
export type StewardWakeAttribution = z.infer<typeof stewardWakeAttributionSchema>;

export const stewardWakeRecordSchema = z.object({
  version: z.literal(WAKE_SCHEMA_VERSION),
  wakeId: z.string().min(1),
  status: stewardWakeStatusSchema,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1).optional(),
  injectedAt: z.string().min(1).nullable(),
  completedAt: z.string().min(1).nullable().optional(),
  deadline: z.string().min(1),
  sessionId: z.string().min(1).nullable(),
  envelope: stewardWakeEnvelopeSchema,
  error: z.string().min(1).optional(),
  attribution: stewardWakeAttributionSchema.optional(),
}).passthrough();
export type StewardWakeRecord = z.infer<typeof stewardWakeRecordSchema>;

export const stewardCompletionSchema = z.object({
  reason: z.string().trim().min(1),
  // Non-empty, aligned with the generated validate-ledger.mjs's requirement
  // (`entry.completion.evidenceRefs.length === 0` fails there) — both sides
  // of the contract now enforce the same rule.
  evidenceRefs: z.array(z.string().min(1)).min(1),
}).passthrough();
export type StewardCompletion = z.infer<typeof stewardCompletionSchema>;

// A smaller/cheaper steward model (observed: claude-haiku-4-5-20251001) has
// been seen writing these numeric fields as JSON strings (e.g. `"0"` instead
// of `0`). z.coerce.number() tolerates that ("0" -> 0, "12.5" -> 12.5) while
// still rejecting genuinely non-numeric strings ("abc" -> fails). Composed
// with plain `.nullable()` this still round-trips a real `null` as `null`
// (verified against this repo's zod@4.3.6: `.nullable()` short-circuits on
// `null` input before the coerce step runs, so null is never coerced to 0) —
// no `z.union([z.null(), ...])` workaround needed. Applied to every numeric
// field here, including the integer token counts, since the same
// stringify-everything failure mode is just as plausible for those as it was
// for the USD cost fields actually observed.
export const stewardCostSchema = z.object({
  model: z.string().min(1).nullable(),
  inputTokens: z.coerce.number().int().nonnegative().nullable(),
  outputTokens: z.coerce.number().int().nonnegative().nullable(),
  modelCostUsd: z.coerce.number().nonnegative().nullable(),
  allocatedServerCostUsd: z.coerce.number().nonnegative().nullable(),
  tradingFeesUsd: z.coerce.number().nonnegative().nullable(),
  estimatedSlippageUsd: z.coerce.number().nonnegative().nullable(),
  totalEstimatedCostUsd: z.coerce.number().nonnegative().nullable(),
}).passthrough();
export type StewardCost = z.infer<typeof stewardCostSchema>;

export const stewardCostSummarySchema = z.object({
  entries: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  modelCostUsd: z.number().nonnegative(),
  allocatedServerCostUsd: z.number().nonnegative(),
  tradingFeesUsd: z.number().nonnegative(),
  estimatedSlippageUsd: z.number().nonnegative(),
  totalEstimatedCostUsd: z.number().nonnegative(),
}).passthrough();
export type StewardCostSummary = z.infer<typeof stewardCostSummarySchema>;

export const stewardChecklistSchema = z.object({
  account: z.string().min(1),
  positions: z.string().min(1),
  orders: z.string().min(1),
  risk: z.string().min(1),
  market: z.string().min(1),
  history: z.string().min(1),
}).passthrough();
export type StewardChecklist = z.infer<typeof stewardChecklistSchema>;

export const stewardContextRefSchema = z.object({
  manifestPath: z.string().min(1),
  manifestSha256: z.string().min(1),
}).passthrough();
export type StewardContextRef = z.infer<typeof stewardContextRefSchema>;

// --- Decision-ledger actions (v2, issue #125) ---------------------------
//
// `actions` was a free-form `unknown[]` in v1. v2 makes it a strict
// discriminated union: every action is an object recording the exact broker
// intent (`kind`), the contract it touched (`aliceId`), a params summary, the
// commit provenance (`commitHash`, where applicable), and the real guard/broker
// `outcome` — the same four branches the wake prompt teaches for `autoPush`:
//   executed          -> autoPush.status "pushed"   (order actually ran)
//   awaiting_approval  -> autoPush absent / skipped non-policy (pending approval)
//   policy_denied      -> autoPush.status "skipped" reason paper_policy_denied
//   failed             -> autoPush.status "failed"  (broker/tool error)
// Free-text action strings are rejected at v2.

export const stewardLedgerActionOutcomeSchema = z.enum([
  'executed',
  'awaiting_approval',
  'policy_denied',
  'failed',
]);
export type StewardLedgerActionOutcome = z.infer<typeof stewardLedgerActionOutcomeSchema>;

export const stewardLedgerActionKindSchema = z.enum([
  'order_place',
  'order_commit',
  'order_modify',
  'order_cancel',
  'position_close',
  'git_reject',
]);
export type StewardLedgerActionKind = z.infer<typeof stewardLedgerActionKindSchema>;

/** One policy violation attached to a `policy_denied` action — a bare reason
 *  string or the structured `autoPush.policyViolations[]` object. */
const ledgerActionViolationSchema = z.union([z.string().min(1), jsonRecordSchema]);

/** Fields shared by every action kind. `params` is a free-form summary object
 *  (e.g. side/qty/orderType/stopLoss), not the raw broker payload. */
const ledgerActionBaseShape = {
  params: jsonRecordSchema,
  commitHash: z.string().min(1).nullable().optional(),
  outcome: stewardLedgerActionOutcomeSchema,
  violations: z.array(ledgerActionViolationSchema).optional(),
};

function tradingActionMember<K extends StewardLedgerActionKind>(kind: K) {
  return z.object({
    kind: z.literal(kind),
    aliceId: z.string().min(1),
    ...ledgerActionBaseShape,
  }).passthrough();
}

export const stewardLedgerActionSchema = z.discriminatedUnion('kind', [
  tradingActionMember('order_place'),
  tradingActionMember('order_commit'),
  tradingActionMember('order_modify'),
  tradingActionMember('order_cancel'),
  tradingActionMember('position_close'),
  // git_reject discards a wrong stage — it is not scoped to one contract, so
  // aliceId is optional; commitHash names the rejected stage where known.
  z.object({
    kind: z.literal('git_reject'),
    aliceId: z.string().min(1).optional(),
    ...ledgerActionBaseShape,
  }).passthrough(),
]).superRefine((action, ctx) => {
  if (action.outcome === 'policy_denied' && (action.violations?.length ?? 0) === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['violations'],
      message: 'a policy_denied action must record non-empty violations',
    });
  }
  if (action.outcome === 'executed' && action.kind !== 'git_reject' && !action.commitHash) {
    ctx.addIssue({
      code: 'custom',
      path: ['commitHash'],
      message: 'an executed order/position action must record its commitHash',
    });
  }
});
export type StewardLedgerAction = z.infer<typeof stewardLedgerActionSchema>;

// --- Decision-ledger entry (v1 lenient read / v2 strict write) -----------

/** Fields common to v1 and v2 ledger entries. Only `version` and `actions`
 *  differ between the two schemas. */
const decisionLedgerCommonShape = {
  wakeId: z.string().min(1),
  at: z.string().min(1),
  accountId: z.string().min(1),
  decision: stewardDecisionSchema,
  status: stewardLedgerStatusSchema,
  context: stewardContextRefSchema.optional(),
  completion: stewardCompletionSchema,
  checklist: stewardChecklistSchema,
  thesis: z.string(),
  // Strict-pending semantics (issue #125 D1): the stage hash currently
  // AWAITING APPROVAL, or null. MUST be null once any action executed — a
  // successful auto-push is terminal, so commit provenance lives in
  // actions[].commitHash, not here. This makes ledger<->UTA reconciliation an
  // equality check.
  pendingHash: z.string().min(1).nullable(),
  invalidation: z.string(),
  cost: stewardCostSchema,
};

/** STRICT v2 entry — the only shape ever written. */
export const stewardDecisionLedgerEntryV2Schema = z.object({
  version: z.literal(DECISION_LEDGER_SCHEMA_VERSION),
  ...decisionLedgerCommonShape,
  actions: z.array(stewardLedgerActionSchema),
}).passthrough().superRefine((entry, ctx) => {
  const hasExecuted = entry.actions.some((action) => action.outcome === 'executed');
  if (hasExecuted && entry.pendingHash !== null) {
    ctx.addIssue({
      code: 'custom',
      path: ['pendingHash'],
      message: 'pendingHash must be null once an action has outcome "executed" (commit provenance belongs in actions[].commitHash)',
    });
  }
});
export type StewardDecisionLedgerEntryV2 = z.infer<typeof stewardDecisionLedgerEntryV2Schema>;

/** LEGACY v1 entry — read-only, for pre-#125 history. `actions` stay
 *  `unknown[]` (never re-typed, never written). */
export const stewardDecisionLedgerEntryV1Schema = z.object({
  version: z.literal(DECISION_LEDGER_SCHEMA_VERSION_V1),
  ...decisionLedgerCommonShape,
  actions: z.array(z.unknown()),
}).passthrough();
export type StewardDecisionLedgerEntryV1 = z.infer<typeof stewardDecisionLedgerEntryV1Schema>;

/** Lenient read schema: strict v2, or legacy v1 history. Version literals are
 *  mutually exclusive, so the union is unambiguous. */
export const stewardDecisionLedgerEntrySchema = z.union([
  stewardDecisionLedgerEntryV2Schema,
  stewardDecisionLedgerEntryV1Schema,
]);
export type StewardDecisionLedgerEntry = z.infer<typeof stewardDecisionLedgerEntrySchema>;

export const stewardLockRecordSchema = z.object({
  version: z.literal(STEWARD_LOCK_SCHEMA_VERSION),
  accountId: z.string().min(1),
  wakeId: z.string().min(1),
  acquiredAt: z.string().min(1),
  expiresAt: z.string().min(1),
}).passthrough();
export type StewardLockRecord = z.infer<typeof stewardLockRecordSchema>;

export const stewardStateSchema = z.object({
  version: z.literal(STEWARD_STATE_SCHEMA_VERSION),
  updatedAt: z.string().min(1),
  cost: stewardCostSummarySchema,
  warnings: z.array(z.string()),
}).passthrough();
export type StewardState = z.infer<typeof stewardStateSchema>;

export function parseStewardWakeRecord(value: unknown): StewardWakeRecord {
  return stewardWakeRecordSchema.parse(value);
}

/** STRICT v2 parse — the write path (append + validator). Rejects legacy v1
 *  shape and free-text actions. */
export function parseStewardDecisionLedgerEntry(value: unknown): StewardDecisionLedgerEntryV2 {
  return stewardDecisionLedgerEntryV2Schema.parse(value);
}

/** LENIENT parse — the read path. Accepts strict v2 AND legacy v1 history. */
export function parseStewardDecisionLedgerEntryLenient(value: unknown): StewardDecisionLedgerEntry {
  return stewardDecisionLedgerEntrySchema.parse(value);
}

export function parseStewardLockRecord(value: unknown): StewardLockRecord {
  return stewardLockRecordSchema.parse(value);
}

export function parseStewardState(value: unknown): StewardState {
  return stewardStateSchema.parse(value);
}
