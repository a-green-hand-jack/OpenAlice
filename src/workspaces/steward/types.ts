import { AUTHZ_LEVELS } from '@traderalice/uta-protocol';
import { z } from 'zod';

export const WAKE_SCHEMA_VERSION = 1;
export const DECISION_LEDGER_SCHEMA_VERSION = 1;
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
}).passthrough();
export type StewardWakeRecord = z.infer<typeof stewardWakeRecordSchema>;

export const stewardCompletionSchema = z.object({
  reason: z.string().trim().min(1),
  evidenceRefs: z.array(z.string().min(1)),
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

export const stewardDecisionLedgerEntrySchema = z.object({
  version: z.literal(DECISION_LEDGER_SCHEMA_VERSION),
  wakeId: z.string().min(1),
  at: z.string().min(1),
  accountId: z.string().min(1),
  decision: stewardDecisionSchema,
  status: stewardLedgerStatusSchema,
  context: stewardContextRefSchema.optional(),
  completion: stewardCompletionSchema,
  checklist: stewardChecklistSchema,
  thesis: z.string(),
  actions: z.array(z.unknown()),
  pendingHash: z.string().min(1).nullable(),
  invalidation: z.string(),
  cost: stewardCostSchema,
}).passthrough();
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

export function parseStewardDecisionLedgerEntry(value: unknown): StewardDecisionLedgerEntry {
  return stewardDecisionLedgerEntrySchema.parse(value);
}

export function parseStewardLockRecord(value: unknown): StewardLockRecord {
  return stewardLockRecordSchema.parse(value);
}

export function parseStewardState(value: unknown): StewardState {
  return stewardStateSchema.parse(value);
}
