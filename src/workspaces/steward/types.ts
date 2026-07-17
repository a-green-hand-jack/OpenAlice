import { AUTHZ_LEVELS, riskEnvelopeSchema } from '@traderalice/uta-protocol';
import { z } from 'zod';

export const WAKE_SCHEMA_VERSION = 1;
export const WAKE_ENVELOPE_SCHEMA_VERSION = 2;
export const INFORMATION_SNAPSHOT_SCHEMA_VERSION = 1;
/** Current decision-ledger entry version. Writes MUST be v3; reads stay
 *  lenient over the historical v1/v2 shapes. */
export const DECISION_LEDGER_SCHEMA_VERSION = 3;
/** Historical v2 ledger version. Retained only for lenient reads and pinned
 *  raw-fingerprint compatibility; it is never accepted on the write path. */
export const DECISION_LEDGER_SCHEMA_VERSION_V2 = 2;
/** Legacy decision-ledger entry version, retained ONLY for the lenient read
 *  path over pre-#125 history — never written. v1 `actions` stay `unknown[]`. */
export const DECISION_LEDGER_SCHEMA_VERSION_V1 = 1;
export const STEWARD_LOCK_SCHEMA_VERSION = 1;
export const STEWARD_STATE_SCHEMA_VERSION = 1;
/** Current ledger-receipt version (issue #134). A receipt is a corruption-evident
 *  marker, captured the FIRST time the supervisor drove a ledger-backed wake to
 *  a terminal state, that lets every later tick detect if that wake's
 *  first-wins ledger entry later disappears or is mutated. It is not
 *  tamper-proof: receipt, wake record, and ledger share one agent-writable
 *  trust domain, so it detects accidental integrity drift, not a coordinated
 *  rewrite. */
export const STEWARD_LEDGER_RECEIPT_SCHEMA_VERSION = 1;
/** Current ledger-integrity marker version (issue #134). Persisted on the wake
 *  the first time a violation is detected so the supervisor appends a given
 *  (kind, fingerprints) violation event exactly once instead of every tick. */
export const STEWARD_LEDGER_INTEGRITY_SCHEMA_VERSION = 1;
/** Clock-skew tolerance for a draft ledger entry's `at` timestamp (issue #255).
 *  Mirrored, same value, in the generated `validate-ledger.mjs`
 *  (`FUTURE_AT_TOLERANCE_MS`) -- keep the two in lockstep if this changes. */
export const LEDGER_ENTRY_FUTURE_AT_TOLERANCE_MS = 60_000;
/** Current finalization-marker version (issue #136). The generated validator
 *  writes one per wake AFTER all checks pass; it is the commit point the
 *  supervisor waits for before terminalizing a marker-protocol wake. */
export const STEWARD_FINALIZE_MARKER_SCHEMA_VERSION = 1;
/** v1 intentionally supports one operator-approved root mandate bound to one
 * trading entrusted unit. Parent/child delegation is not a runtime surface. */
export const ENTRUSTED_UNIT_MANDATE_SCHEMA_VERSION = 1;

export const stewardWakeReasonSchema = z.enum([
  'scheduled_observe',
  'market_event',
  'risk_event',
  'user_request',
  'supervisor_recovery',
]);
export type StewardWakeReason = z.infer<typeof stewardWakeReasonSchema>;

export const stewardExpectedDecisionSchema = z.enum(['no_trade', 'propose_change', 'reduce_risk', 'blocked']);
export type StewardExpectedDecision = z.infer<typeof stewardExpectedDecisionSchema>;
const stewardLegacyDecisionSchema = z.enum(['no_trade', 'propose_trade', 'blocked']);

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

// Which surface drives a wake (issue #146). 'pty' is the historical control
// face — a PTY pool session whose petname lands in `sessionId`. 'machine' is a
// machine-protocol thread (codex app-server) whose native thread UUID lands in
// `sessionId` instead. Absent on every pre-#146 record; those read as 'pty'
// via the wake-record schema default, so legacy data and existing PTY wakes are
// unchanged.
export const stewardControlFaceSchema = z.enum(['pty', 'machine']);
export type StewardControlFace = z.infer<typeof stewardControlFaceSchema>;

// Steward config validation (issue #153). `.alice/steward/config.json` is
// hand-edited JSON with no write-time validation; the S6 read-time fail-safe
// in `decideStewardControlFace` (machine-driver/dispatch.ts) already refuses
// to interpret an unrecognized `controlFace` value as `machine` — it declines
// to PTY, loudly. That fail-safe STAYS the sole enforcement point. This schema
// is used PURELY for a load-time OBSERVABILITY warning (`readStewardConfig` in
// `config.ts`) — it never blocks the read or rewrites the config. Every
// recognized field is optional and every object level is `.passthrough()`, so
// an absent field, or a genuinely new forward-compatible key, never triggers a
// warning — only a RECOGNIZED key carrying a value of the wrong shape does
// (e.g. `controlFace: 'PTY'`, `sessionRotation.threshold: "high"`).
export const stewardConfigSchema = z.object({
  version: z.number().optional(),
  agent: z.string().optional(),
  // Bootstrap writes `sessionId: null` and the machine face never rewrites it
  // (machine thread ids live in the thread-store, not config.json) — null must
  // parse as valid or this warning fires on every default machine-face
  // workspace, every wake and every supervisor tick.
  sessionId: z.string().nullable().optional(),
  controlFace: stewardControlFaceSchema.optional(),
  sessionRotation: z.object({
    threshold: z.number().optional(),
  }).passthrough().optional(),
  monthlyBudget: z.object({
    modelUsd: z.number().optional(),
    serverUsd: z.number().optional(),
  }).passthrough().optional(),
  costPolicy: z.object({
    warnAtPct: z.number().optional(),
  }).passthrough().optional(),
}).passthrough();
export type StewardConfig = z.infer<typeof stewardConfigSchema>;

export const stewardDecisionV3Schema = z.enum(['no_trade', 'propose_change', 'reduce_risk', 'blocked']);
export const stewardDecisionSchema = z.union([stewardDecisionV3Schema, stewardLegacyDecisionSchema]);
export type StewardDecision = z.infer<typeof stewardDecisionSchema>;

export const stewardLedgerStatusSchema = z.enum(['done', 'blocked', 'error']);
export type StewardLedgerStatus = z.infer<typeof stewardLedgerStatusSchema>;

export const stewardAuthzLevelSchema = z.enum(AUTHZ_LEVELS);

const jsonRecordSchema = z.record(z.string(), z.unknown());
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const nonEmptyStringSchema = z.string().trim().min(1);
const isoTimestampSchema = z.iso.datetime({ offset: true });

export const entrustedUnitIntentIdentitySchema = z.object({
  mandateId: nonEmptyStringSchema,
  entrustedUnitId: nonEmptyStringSchema,
}).strict();
export type EntrustedUnitIntentIdentity = z.infer<typeof entrustedUnitIntentIdentitySchema>;

export const entrustedUnitMandateSchema = z.object({
  version: z.literal(ENTRUSTED_UNIT_MANDATE_SCHEMA_VERSION),
  mandateId: nonEmptyStringSchema,
  entrustedUnitId: nonEmptyStringSchema,
  parentMandateId: z.null(),
  accountId: nonEmptyStringSchema,
  capital: z.object({
    currency: nonEmptyStringSchema,
    limit: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/),
  }).strict(),
  scope: z.object({
    kind: z.literal('instrument_whitelist'),
    instruments: z.array(nonEmptyStringSchema).min(1),
  }).strict(),
  validFrom: isoTimestampSchema,
  validUntil: isoTimestampSchema,
  heartbeat: z.object({
    intervalMs: z.number().int().positive(),
    graceMs: z.number().int().nonnegative(),
  }).strict(),
  riskEnvelope: riskEnvelopeSchema,
}).strict().superRefine((mandate, ctx) => {
  if (Date.parse(mandate.validUntil) <= Date.parse(mandate.validFrom)) {
    ctx.addIssue({ code: 'custom', path: ['validUntil'], message: 'validUntil must be after validFrom' });
  }
  if (new Set(mandate.scope.instruments).size !== mandate.scope.instruments.length) {
    ctx.addIssue({ code: 'custom', path: ['scope', 'instruments'], message: 'mandate scope instruments must be unique' });
  }
  if (mandate.riskEnvelope.scope.kind !== 'whitelist') {
    ctx.addIssue({ code: 'custom', path: ['riskEnvelope', 'scope'], message: 'v1 mandate requires a whitelist Risk Envelope' });
    return;
  }
  const mandateScope = [...mandate.scope.instruments].sort();
  const envelopeScope = [...mandate.riskEnvelope.scope.symbols].sort();
  if (JSON.stringify(mandateScope) !== JSON.stringify(envelopeScope)) {
    ctx.addIssue({ code: 'custom', path: ['scope'], message: 'mandate scope must equal the Risk Envelope whitelist' });
  }
});
export type EntrustedUnitMandate = z.infer<typeof entrustedUnitMandateSchema>;

const stewardWakeEnvelopeCommonShape = {
  reason: stewardWakeReasonSchema,
  accountId: z.string().min(1),
  authzLevel: stewardAuthzLevelSchema,
  marketContext: jsonRecordSchema.optional(),
  riskContext: jsonRecordSchema.optional(),
  humanRequest: z.string().optional(),
  mandate: entrustedUnitMandateSchema.optional(),
};

/** Deterministic dispatch input before Snapshot M1 is published. */
export const stewardWakeEnvelopeInputSchema = z.object({
  ...stewardWakeEnvelopeCommonShape,
  expectedDecision: stewardExpectedDecisionSchema,
}).passthrough();
export type StewardWakeEnvelopeInput = z.infer<typeof stewardWakeEnvelopeInputSchema>;

export const stewardInformationSnapshotBindingSchema = z.object({
  snapshotId: z.string().startsWith('snap:'),
  sha256: sha256Schema,
  path: z.string().min(1),
  asOf: isoTimestampSchema,
}).strict();
export type StewardInformationSnapshotBinding = z.infer<typeof stewardInformationSnapshotBindingSchema>;

/** Current envelope written for every new wake. */
export const stewardWakeEnvelopeSchema = z.object({
  version: z.literal(WAKE_ENVELOPE_SCHEMA_VERSION),
  ...stewardWakeEnvelopeCommonShape,
  expectedDecision: stewardExpectedDecisionSchema,
  snapshotRef: stewardInformationSnapshotBindingSchema,
}).passthrough();
export type StewardWakeEnvelope = z.infer<typeof stewardWakeEnvelopeSchema>;

/** Historical pre-Snapshot envelope, read-only. */
const stewardLegacyWakeEnvelopeSchema = z.object({
  // Pre-Snapshot envelopes had neither field. Keeping them explicitly absent
  // prevents a malformed v2 envelope from falling through this compatibility
  // branch and being misread as valid legacy data.
  version: z.never().optional(),
  snapshotRef: z.never().optional(),
  ...stewardWakeEnvelopeCommonShape,
  expectedDecision: stewardLegacyDecisionSchema,
}).passthrough();
export const stewardWakeEnvelopeReadSchema = z.union([
  stewardWakeEnvelopeSchema,
  stewardLegacyWakeEnvelopeSchema,
]);
export type StewardWakeEnvelopeReadable = z.infer<typeof stewardWakeEnvelopeReadSchema>;

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

// Ledger-integrity receipt (issue #134). Captured the FIRST time the supervisor
// reconciles a wake to a ledger-backed terminal state (done|blocked|error), and
// then treated as append-once. `fingerprint` is the canonical SEMANTIC SHA-256
// of the first-wins ledger entry (see ledger-receipt.ts) — format/whitespace-
// and unknown-key-invariant, so a benign reformat never trips a false alarm, but
// a semantic edit or a vanished line does. Later ticks and the generated
// validator compare the current first-wins entry against this receipt to detect
// history that was corrupted (deleted/rewritten). `bootstrapped` marks a receipt
// back-filled from a pre-#134 terminal wake's current entry — an honest
// limitation: detection starts there, the current entry is trusted once.
//
// Scope: corruption-evident, NOT tamper-proof — receipt/wake/ledger share one
// agent-writable trust domain.
export const stewardLedgerReceiptSchema = z.object({
  version: z.literal(STEWARD_LEDGER_RECEIPT_SCHEMA_VERSION),
  wakeId: z.string().min(1),
  status: stewardLedgerStatusSchema,
  decision: stewardDecisionSchema,
  at: z.string().min(1),
  accountId: z.string().min(1),
  fingerprint: z.string().min(1),
  recordedAt: z.string().min(1),
  bootstrapped: z.boolean().optional(),
}).passthrough();
export type StewardLedgerReceipt = z.infer<typeof stewardLedgerReceiptSchema>;

export const stewardLedgerIntegrityKindSchema = z.enum([
  'entry_missing',
  'entry_mutated',
  'entry_missing_no_receipt',
  // Issue #139: an ACTIVE (not-yet-terminal) wake has a ledger entry filed under
  // a different top-level wakeId whose evidence self-references this wake. Unlike
  // the others this is pre-terminal and non-fatal — it's surfaced so the same
  // wake can be corrected instead of silently timing out.
  'active_identity_mismatch',
]);
export type StewardLedgerIntegrityKind = z.infer<typeof stewardLedgerIntegrityKindSchema>;

// Persisted integrity-violation marker (issue #134). Written on the wake the
// first time a violation of a given (kind, expected/actual fingerprint) is seen,
// so the supervisor emits that structured event ONCE rather than re-appending it
// every tick (bounding supervisor.jsonl growth). Cleared — with a
// `ledger_integrity_recovered` event — if a later tick finds the entry restored.
export const stewardLedgerIntegritySchema = z.object({
  version: z.literal(STEWARD_LEDGER_INTEGRITY_SCHEMA_VERSION),
  kind: stewardLedgerIntegrityKindSchema,
  expectedFingerprint: z.string().min(1).optional(),
  actualFingerprint: z.string().min(1).optional(),
  // Issue #139: for an `active_identity_mismatch`, the WRONG top-level wakeId the
  // completion was filed under (the dedup key for that event).
  misfiledUnderWakeId: z.string().min(1).optional(),
  firstDetectedAt: z.string().min(1),
}).passthrough();
export type StewardLedgerIntegrity = z.infer<typeof stewardLedgerIntegritySchema>;

// Finalization marker (issue #136 finalize barrier). Written atomically by the
// generated validate-ledger.mjs ONLY after the current wake's entry passes the
// full schema + duplicate + prior-terminal-completeness checks. `fingerprint`
// is the canonical semantic fingerprint (see ledger-receipt.ts) of the entry
// that was validated. The supervisor terminalizes a marker-protocol wake only
// when a matching parseable first-wins entry AND a marker with this exact
// fingerprint both exist — so an allowed same-wake correction made AFTER a
// draft validated does not terminalize until the corrected line is re-validated
// (which atomically replaces this marker). Read lenient (unknown keys allowed).
export const stewardFinalizeMarkerSchema = z.object({
  version: z.literal(STEWARD_FINALIZE_MARKER_SCHEMA_VERSION),
  wakeId: z.string().min(1),
  fingerprint: z.string().min(1),
  validatedAt: z.string().min(1),
  schemaVersion: z.coerce.number().int().optional(),
}).passthrough();
export type StewardFinalizeMarker = z.infer<typeof stewardFinalizeMarkerSchema>;

export function parseStewardFinalizeMarker(value: unknown): StewardFinalizeMarker {
  return stewardFinalizeMarkerSchema.parse(value);
}

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
  // Control face (issue #146). For a 'machine' wake, `sessionId` above carries
  // the native thread UUID (not a PTY petname). `.default('pty')` back-fills
  // every pre-#146 record on read, so absence always means the historical PTY
  // face — legacy data and existing wakes are bit-identical.
  controlFace: stewardControlFaceSchema.default('pty'),
  envelope: stewardWakeEnvelopeReadSchema,
  error: z.string().min(1).optional(),
  attribution: stewardWakeAttributionSchema.optional(),
  ledgerReceipt: stewardLedgerReceiptSchema.optional(),
  ledgerIntegrity: stewardLedgerIntegritySchema.optional(),
  // Finalize barrier (issue #136). New wakes are created with 'marker', so the
  // supervisor terminalizes them only after the generated validator publishes a
  // matching finalization marker (validation is the commit point). Absent on
  // wakes created before this shipped — a BOUNDED compatibility rule: those
  // legacy in-flight wakes still terminalize from raw ledger presence, but every
  // NEW wake requires the marker (see supervisor.ts requiresFinalizeMarker).
  finalizeProtocol: z.literal('marker').optional(),
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

// --- Decision Intent + Information Snapshot (v3 / M1) --------------------

const percentageSchema = z.number().finite().min(0).max(100);
const positiveDecimalStringSchema = z.string().refine(
  (value) =>
    /^(?:\d+|\d+\.\d+|\.\d+)$/.test(value)
    && Number.isFinite(Number(value))
    && Number(value) > 0,
  { message: 'expected a finite positive decimal string' },
);

export const stewardTargetExposureSchema = z.object({
  minPct: percentageSchema,
  maxPct: percentageSchema,
}).strict().superRefine((exposure, ctx) => {
  if (exposure.minPct > exposure.maxPct) {
    ctx.addIssue({
      code: 'custom',
      path: ['minPct'],
      message: 'minPct must be less than or equal to maxPct',
    });
  }
});

export const stewardIntentInvalidationSchema = z.union([
  z.object({
    kind: z.enum(['price_below', 'price_above']),
    value: positiveDecimalStringSchema,
    note: nonEmptyStringSchema,
  }).strict(),
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('time_expiry'), note: nonEmptyStringSchema }).strict(),
    z.object({ kind: z.literal('thesis'), note: nonEmptyStringSchema }).strict(),
  ]),
]);

const intentTargetShape = {
  direction: z.enum(['long', 'short', 'flat']),
  instrument: nonEmptyStringSchema,
  targetExposure: stewardTargetExposureSchema,
  invalidation: z.array(stewardIntentInvalidationSchema).min(1),
};
const intentCommonShape = {
  identity: entrustedUnitIntentIdentitySchema.optional(),
  confidence: z.enum(['low', 'medium', 'high']),
  maxAcceptableLossPct: percentageSchema,
  timeHorizon: z.object({
    unit: z.enum(['hour', 'day', 'week', 'month']),
    value: z.number().int().positive(),
  }).strict(),
  evidence: z.array(z.object({
    ref: nonEmptyStringSchema,
    note: nonEmptyStringSchema,
  }).strict()).min(1),
  snapshotId: z.string().startsWith('snap:'),
  snapshotSha256: sha256Schema,
};

export const stewardDecisionIntentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('single'), ...intentTargetShape, ...intentCommonShape }).strict(),
  z.object({
    kind: z.literal('portfolio'),
    targets: z.array(z.object(intentTargetShape).strict()).min(2),
    ...intentCommonShape,
  }).strict(),
]).superRefine((intent, ctx) => {
  if (intent.kind !== 'portfolio') return;
  const seen = new Set<string>();
  intent.targets.forEach((target, index) => {
    if (seen.has(target.instrument)) {
      ctx.addIssue({
        code: 'custom',
        path: ['targets', index, 'instrument'],
        message: 'portfolio target instruments must be unique',
      });
    }
    seen.add(target.instrument);
  });
});
export type StewardDecisionIntent = z.infer<typeof stewardDecisionIntentSchema>;

export const stewardThesisDispositionSchema = z.object({
  wakeId: nonEmptyStringSchema,
  instrument: nonEmptyStringSchema,
  disposition: z.enum(['supersede', 'invalidate', 'expire', 'keep']),
  note: nonEmptyStringSchema,
}).strict();
export type StewardThesisDisposition = z.infer<typeof stewardThesisDispositionSchema>;

export function stewardThesisIdentity(input: { readonly wakeId: string; readonly instrument: string }): string {
  return JSON.stringify([input.wakeId, input.instrument]);
}

export const stewardSnapshotRefSchema = z.object({
  ref: nonEmptyStringSchema,
  sha256: sha256Schema,
  asOf: isoTimestampSchema,
  freshness: nonEmptyStringSchema.optional(),
}).strict();

const providedSnapshotRefsSchema = z.discriminatedUnion('provided', [
  z.object({ provided: z.literal(true), refs: z.array(stewardSnapshotRefSchema).min(1) }).strict(),
  z.object({ provided: z.literal(false), note: nonEmptyStringSchema }).strict(),
]);

const stewardSnapshotHistorySchema = z.discriminatedUnion('provided', [
  z.object({
    provided: z.literal(true),
    openTheses: z.array(z.object({
      wakeId: nonEmptyStringSchema,
      fingerprint: sha256Schema,
      instrument: nonEmptyStringSchema,
      expiresAt: isoTimestampSchema,
    }).strict()),
    refs: z.array(stewardSnapshotRefSchema).min(1),
  }).strict(),
  z.object({ provided: z.literal(false), note: nonEmptyStringSchema }).strict(),
]).superRefine((history, ctx) => {
  if (!history.provided) return;
  const addresses = new Set<string>();
  const instruments = new Set<string>();
  history.openTheses.forEach((thesis, index) => {
    const address = stewardThesisIdentity(thesis);
    if (addresses.has(address)) {
      ctx.addIssue({
        code: 'custom',
        path: ['openTheses', index],
        message: `duplicate open thesis address: ${thesis.wakeId}:${thesis.instrument}`,
      });
    }
    if (instruments.has(thesis.instrument)) {
      ctx.addIssue({
        code: 'custom',
        path: ['openTheses', index, 'instrument'],
        message: `account-bound snapshot has more than one open thesis for instrument: ${thesis.instrument}`,
      });
    }
    addresses.add(address);
    instruments.add(thesis.instrument);
  });
});

export const stewardInformationSnapshotSchema = z.object({
  version: z.literal(INFORMATION_SNAPSHOT_SCHEMA_VERSION),
  snapshotId: z.string().startsWith('snap:'),
  wakeId: nonEmptyStringSchema,
  accountId: nonEmptyStringSchema,
  asOf: isoTimestampSchema,
  market: providedSnapshotRefsSchema,
  portfolio: providedSnapshotRefsSchema,
  risk: z.discriminatedUnion('provided', [
    z.object({
      provided: z.literal(true),
      envelopeVersion: z.number().int().positive(),
      refs: z.array(stewardSnapshotRefSchema).min(1),
    }).strict(),
    z.object({
      provided: z.literal(false),
      envelopeVersion: z.null(),
      note: nonEmptyStringSchema,
    }).strict(),
  ]),
  events: providedSnapshotRefsSchema,
  history: stewardSnapshotHistorySchema,
}).strict().superRefine((snapshot, ctx) => {
  if (snapshot.snapshotId !== `snap:${snapshot.wakeId}`) {
    ctx.addIssue({
      code: 'custom',
      path: ['snapshotId'],
      message: 'snapshotId must equal "snap:" + wakeId',
    });
  }
});
export type StewardInformationSnapshot = z.infer<typeof stewardInformationSnapshotSchema>;

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
// Free-text action strings are rejected from v2 onward.

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

// --- Decision-ledger entry (v1/v2 lenient read / v3 strict write) --------

const legacyDecisionLedgerCommonShape = {
  wakeId: z.string().min(1),
  at: z.string().min(1),
  accountId: z.string().min(1),
  decision: stewardLegacyDecisionSchema,
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

/**
 * STRUCTURAL v2 entry (issue #125 D1/D2): typed discriminated `actions` +
 * strict-pending `pendingHash`. This is the LENIENT-READ shape — it does NOT
 * enforce the issue #139 evidence self-reference, so a pre-#139 v2 history line
 * (written before that rule existed, with no `wake:<self>` ref) still READS as a
 * valid entry. Read-lenient / write-strict (issue #125): reconciliation, cost
 * aggregation, and history all go through this. It is historical read-only now
 * that v3 is the sole write shape.
 */
export const stewardDecisionLedgerEntryV2StructuralSchema = z.object({
  version: z.literal(DECISION_LEDGER_SCHEMA_VERSION_V2),
  ...legacyDecisionLedgerCommonShape,
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

/**
 * Historical strict-v2 shape retained for focused compatibility tests. Adds the issue #139
 * self-consistency rule on top of the structural schema: the entry must carry
 * exactly the `wake:<its own wakeId>` evidence self-reference and no `wake:`
 * reference to any OTHER id. The `wake:` namespace is reserved for this single
 * self-reference — cite a prior wake via `ledger:previous`, never `wake:<other>`.
 * A steward was observed copying a PRIOR wake's UUID suffix into the top-level
 * wakeId while its evidence still referenced the active wake — a contradictory
 * entry that finalized a phantom id (issue #139). This rule is write-strict
 * only; the lenient structural schema above still reads pre-#139 history.
 */
export const stewardDecisionLedgerEntryV2Schema = stewardDecisionLedgerEntryV2StructuralSchema
  .superRefine((entry, ctx) => {
    const wakeRefs = entry.completion.evidenceRefs
      .filter((ref) => typeof ref === 'string' && ref.startsWith('wake:'))
      .map((ref) => ref.slice('wake:'.length));
    if (!wakeRefs.includes(entry.wakeId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['completion', 'evidenceRefs'],
        message: `completion.evidenceRefs must include the self-reference "wake:${entry.wakeId}" matching the entry's top-level wakeId`,
      });
    }
    const contradictory = [...new Set(wakeRefs.filter((id) => id !== entry.wakeId))];
    if (contradictory.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['completion', 'evidenceRefs'],
        message: `completion.evidenceRefs references a different wake (${contradictory.join(', ')}) than the entry's top-level wakeId (${entry.wakeId}); a copied or contradictory wake id is invalid`,
      });
    }
  });
export type StewardDecisionLedgerEntryV2 = z.infer<typeof stewardDecisionLedgerEntryV2Schema>;

/** LEGACY v1 entry — read-only, for pre-#125 history. `actions` stay
 *  `unknown[]` (never re-typed, never written). */
export const stewardDecisionLedgerEntryV1Schema = z.object({
  version: z.literal(DECISION_LEDGER_SCHEMA_VERSION_V1),
  ...legacyDecisionLedgerCommonShape,
  actions: z.array(z.unknown()),
}).passthrough();
export type StewardDecisionLedgerEntryV1 = z.infer<typeof stewardDecisionLedgerEntryV1Schema>;

/** Strict v3 entry: the only accepted new write shape. Snapshot file/hash and
 *  thesis-coverage checks require workspace context and are enforced by the
 *  generated validator immediately before its atomic commit. */
export const stewardDecisionLedgerEntryV3Schema = z.object({
  version: z.literal(DECISION_LEDGER_SCHEMA_VERSION),
  wakeId: nonEmptyStringSchema,
  at: isoTimestampSchema,
  accountId: nonEmptyStringSchema,
  decision: stewardDecisionV3Schema,
  status: stewardLedgerStatusSchema,
  context: stewardContextRefSchema.optional(),
  completion: stewardCompletionSchema,
  checklist: stewardChecklistSchema,
  thesis: z.string(),
  actions: z.array(stewardLedgerActionSchema),
  pendingHash: nonEmptyStringSchema.nullable(),
  invalidation: z.string(),
  cost: stewardCostSchema,
  intent: stewardDecisionIntentSchema.nullable(),
  thesisDispositions: z.array(stewardThesisDispositionSchema),
}).strict().superRefine((entry, ctx) => {
  if (Date.parse(entry.at) > Date.now() + LEDGER_ENTRY_FUTURE_AT_TOLERANCE_MS) {
    ctx.addIssue({
      code: 'custom',
      path: ['at'],
      message: 'draft at is in the future -- set at to the actual current UTC time (it must not be ahead of the validator clock by more than 60s)',
    });
  }

  const dispositionIdentities = new Set<string>();
  entry.thesisDispositions.forEach((disposition, index) => {
    const identity = stewardThesisIdentity(disposition);
    if (dispositionIdentities.has(identity)) {
      ctx.addIssue({
        code: 'custom',
        path: ['thesisDispositions', index],
        message: `duplicate thesis disposition identity: ${disposition.wakeId}:${disposition.instrument}`,
      });
    }
    dispositionIdentities.add(identity);
  });

  const hasExecuted = entry.actions.some((action) => action.outcome === 'executed');
  if (hasExecuted && entry.pendingHash !== null) {
    ctx.addIssue({
      code: 'custom',
      path: ['pendingHash'],
      message: 'pendingHash must be null once an action has outcome "executed"',
    });
  }

  const selfRef = `wake:${entry.wakeId}`;
  const wakeRefs = entry.completion.evidenceRefs.filter((ref) => ref.startsWith('wake:'));
  const selfRefCount = wakeRefs.filter((ref) => ref === selfRef).length;
  if (selfRefCount !== 1) {
    ctx.addIssue({
      code: 'custom',
      path: ['completion', 'evidenceRefs'],
      message: `completion.evidenceRefs must contain exactly one ${selfRef}`,
    });
  }
  const contradictory = [...new Set(wakeRefs.filter((ref) => ref !== selfRef))];
  if (contradictory.length > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['completion', 'evidenceRefs'],
      message: `contradictory wake references: ${contradictory.join(', ')}`,
    });
  }

  const requiresIntent = entry.decision === 'propose_change' || entry.decision === 'reduce_risk';
  if (requiresIntent && entry.intent === null) {
    ctx.addIssue({ code: 'custom', path: ['intent'], message: `${entry.decision} requires a non-null intent` });
  }
  if (!requiresIntent && entry.intent !== null) {
    ctx.addIssue({ code: 'custom', path: ['intent'], message: `${entry.decision} requires intent to be null` });
  }
  if (entry.decision !== 'propose_change' || entry.intent === null) return;

  const invalidationSets = entry.intent.kind === 'single'
    ? [entry.intent.invalidation]
    : entry.intent.targets.map((target) => target.invalidation);
  invalidationSets.forEach((invalidations, index) => {
    if (invalidations.some((item) => item.kind === 'price_below' || item.kind === 'price_above')) return;
    ctx.addIssue({
      code: 'custom',
      path: entry.intent?.kind === 'portfolio'
        ? ['intent', 'targets', index, 'invalidation']
        : ['intent', 'invalidation'],
      message: 'propose_change requires a price invalidation for every target',
    });
  });
});
export type StewardDecisionLedgerEntryV3 = z.infer<typeof stewardDecisionLedgerEntryV3Schema>;

/** LENIENT read schema: strict current v3 plus historical structural v2 (without
 *  the later #139 self-ref requirement) and v1. Version literals are mutually
 *  exclusive. New writes still go through the strict-v3 parser and generated
 *  validator; a lenient-readable historical line cannot finalize a current wake
 *  without a strict-validated marker. */
export const stewardDecisionLedgerEntrySchema = z.union([
  stewardDecisionLedgerEntryV3Schema,
  stewardDecisionLedgerEntryV2StructuralSchema,
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

/** STRICT v3 parse — the write path. Rejects legacy v1/v2 shapes. */
export function parseStewardDecisionLedgerEntry(value: unknown): StewardDecisionLedgerEntryV3 {
  return stewardDecisionLedgerEntryV3Schema.parse(value);
}

/** LENIENT parse — the read path. Accepts v3 and historical v1/v2 history. */
export function parseStewardDecisionLedgerEntryLenient(value: unknown): StewardDecisionLedgerEntry {
  return stewardDecisionLedgerEntrySchema.parse(value);
}

export function parseStewardLockRecord(value: unknown): StewardLockRecord {
  return stewardLockRecordSchema.parse(value);
}

export function parseStewardState(value: unknown): StewardState {
  return stewardStateSchema.parse(value);
}
