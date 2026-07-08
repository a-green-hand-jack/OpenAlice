import { AUTHZ_LEVELS } from '@traderalice/uta-protocol';
import { z } from 'zod';

export const WAKE_SCHEMA_VERSION = 1;
export const DECISION_LEDGER_SCHEMA_VERSION = 1;

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

export const stewardCostSchema = z.object({
  model: z.string().min(1).nullable(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  modelCostUsd: z.number().nonnegative().nullable(),
  allocatedServerCostUsd: z.number().nonnegative().nullable(),
  tradingFeesUsd: z.number().nonnegative().nullable(),
  estimatedSlippageUsd: z.number().nonnegative().nullable(),
  totalEstimatedCostUsd: z.number().nonnegative().nullable(),
}).passthrough();
export type StewardCost = z.infer<typeof stewardCostSchema>;

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

export function parseStewardWakeRecord(value: unknown): StewardWakeRecord {
  return stewardWakeRecordSchema.parse(value);
}

export function parseStewardDecisionLedgerEntry(value: unknown): StewardDecisionLedgerEntry {
  return stewardDecisionLedgerEntrySchema.parse(value);
}
