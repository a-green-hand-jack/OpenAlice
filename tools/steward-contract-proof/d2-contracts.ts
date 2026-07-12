import { createHash } from "node:crypto";

import { z } from "zod";

import {
  stewardChecklistSchema,
  stewardCompletionSchema,
  stewardContextRefSchema,
  stewardCostSchema,
  stewardLedgerActionSchema,
} from "../../src/workspaces/steward/types.js";

/**
 * AUTH-CP-D2 test oracle only. Nothing in the production runtime may import
 * this module; Wave 0.5 freezes executable contract examples before D2 code is
 * authorized.
 */

export const LEGACY_V2_GOLDEN_FINGERPRINT =
  "a00e0bc4ff92f38b3e7bfab09e797e73d5f9248664cee740ac1efedf4849ef9f";
export const PORTFOLIO_PROPOSAL_ONLY_CODE = "portfolio_proposal_only";

const nonEmptyString = z.string().trim().min(1);
const percentageSchema = z.number().finite().min(0).max(100);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const isoTimestampSchema = z.iso.datetime({ offset: true });
const positiveDecimalStringSchema = z
  .string()
  .refine(
    (value) =>
      /^(?:\d+|\d+\.\d+|\.\d+)$/.test(value) &&
      Number.isFinite(Number(value)) &&
      Number(value) > 0,
    { message: "expected a finite positive decimal string" },
  );

export const confidenceSchema = z.enum(["low", "medium", "high"]);
export const decisionV3Schema = z.enum([
  "no_trade",
  "propose_change",
  "reduce_risk",
  "blocked",
]);

export const targetExposureSchema = z
  .object({
    minPct: percentageSchema,
    maxPct: percentageSchema,
  })
  .strict()
  .superRefine((exposure, ctx) => {
    if (exposure.minPct > exposure.maxPct) {
      ctx.addIssue({
        code: "custom",
        path: ["minPct"],
        message: "minPct must be less than or equal to maxPct",
      });
    }
  });

const priceInvalidationSchema = z
  .object({
    kind: z.enum(["price_below", "price_above"]),
    value: positiveDecimalStringSchema,
    note: nonEmptyString,
  })
  .strict();

const nonPriceInvalidationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("time_expiry"), note: nonEmptyString }).strict(),
  z.object({ kind: z.literal("thesis"), note: nonEmptyString }).strict(),
]);

export const intentInvalidationSchema = z.union([
  priceInvalidationSchema,
  nonPriceInvalidationSchema,
]);
export type IntentInvalidation = z.infer<typeof intentInvalidationSchema>;

const evidenceSchema = z
  .object({
    ref: nonEmptyString,
    note: nonEmptyString,
  })
  .strict();

const timeHorizonSchema = z
  .object({
    unit: z.enum(["hour", "day", "week", "month"]),
    value: z.number().int().positive(),
  })
  .strict();

const targetShape = {
  direction: z.enum(["long", "short", "flat"]),
  instrument: nonEmptyString,
  targetExposure: targetExposureSchema,
  invalidation: z.array(intentInvalidationSchema).min(1),
};

const commonIntentShape = {
  confidence: confidenceSchema,
  maxAcceptableLossPct: percentageSchema,
  timeHorizon: timeHorizonSchema,
  evidence: z.array(evidenceSchema).min(1),
  snapshotId: z.string().startsWith("snap:"),
  snapshotSha256: sha256Schema,
};

const singleIntentSchema = z
  .object({
    kind: z.literal("single"),
    ...targetShape,
    ...commonIntentShape,
  })
  .strict();

const portfolioTargetSchema = z.object(targetShape).strict();

const portfolioIntentSchema = z
  .object({
    kind: z.literal("portfolio"),
    targets: z.array(portfolioTargetSchema).min(2),
    ...commonIntentShape,
  })
  .strict();

export const decisionIntentSchema = z
  .discriminatedUnion("kind", [singleIntentSchema, portfolioIntentSchema])
  .superRefine((intent, ctx) => {
    if (intent.kind !== "portfolio") return;
    const seen = new Set<string>();
    for (const [index, target] of intent.targets.entries()) {
      if (seen.has(target.instrument)) {
        ctx.addIssue({
          code: "custom",
          path: ["targets", index, "instrument"],
          message: "portfolio target instruments must be unique",
        });
      }
      seen.add(target.instrument);
    }
  });
export type DecisionIntent = z.infer<typeof decisionIntentSchema>;

export const thesisDispositionSchema = z
  .object({
    wakeId: nonEmptyString,
    disposition: z.enum(["supersede", "invalidate", "expire", "keep"]),
    note: nonEmptyString,
  })
  .strict();

export const decisionLedgerV3Schema = z
  .object({
    version: z.literal(3),
    wakeId: nonEmptyString,
    at: isoTimestampSchema,
    accountId: nonEmptyString,
    decision: decisionV3Schema,
    status: z.enum(["done", "blocked", "error"]),
    context: stewardContextRefSchema.optional(),
    completion: stewardCompletionSchema,
    checklist: stewardChecklistSchema,
    thesis: z.string(),
    actions: z.array(stewardLedgerActionSchema),
    pendingHash: nonEmptyString.nullable(),
    invalidation: z.string(),
    cost: stewardCostSchema,
    intent: decisionIntentSchema.nullable(),
    thesisDispositions: z.array(thesisDispositionSchema),
  })
  .strict()
  .superRefine((entry, ctx) => {
    const hasExecuted = entry.actions.some(
      (action) => action.outcome === "executed",
    );
    if (hasExecuted && entry.pendingHash !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["pendingHash"],
        message:
          'pendingHash must be null once an action has outcome "executed"',
      });
    }

    const wakeRefs = entry.completion.evidenceRefs.filter((ref) =>
      ref.startsWith("wake:"),
    );
    const selfRef = `wake:${entry.wakeId}`;
    const selfRefCount = wakeRefs.filter((ref) => ref === selfRef).length;
    if (selfRefCount !== 1) {
      ctx.addIssue({
        code: "custom",
        path: ["completion", "evidenceRefs"],
        message: `completion.evidenceRefs must contain exactly one ${selfRef}`,
      });
    }
    const contradictoryWakeRefs = [
      ...new Set(wakeRefs.filter((ref) => ref !== selfRef)),
    ];
    if (contradictoryWakeRefs.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["completion", "evidenceRefs"],
        message: `contradictory wake references: ${contradictoryWakeRefs.join(", ")}`,
      });
    }

    const requiresIntent =
      entry.decision === "propose_change" || entry.decision === "reduce_risk";
    if (requiresIntent && entry.intent === null) {
      ctx.addIssue({
        code: "custom",
        path: ["intent"],
        message: `${entry.decision} requires a non-null intent`,
      });
    }
    if (!requiresIntent && entry.intent !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["intent"],
        message: `${entry.decision} requires intent to be null`,
      });
    }
    if (entry.decision !== "propose_change" || entry.intent === null) return;

    const invalidationSets =
      entry.intent.kind === "single"
        ? [entry.intent.invalidation]
        : entry.intent.targets.map((target) => target.invalidation);
    invalidationSets.forEach((invalidations, index) => {
      const hasPriceInvalidation = invalidations.some(
        (item) => item.kind === "price_below" || item.kind === "price_above",
      );
      if (!hasPriceInvalidation) {
        ctx.addIssue({
          code: "custom",
          path:
            entry.intent?.kind === "portfolio"
              ? ["intent", "targets", index, "invalidation"]
              : ["intent", "invalidation"],
          message:
            "propose_change requires a price invalidation for every target",
        });
      }
    });
  });
export type DecisionLedgerV3 = z.infer<typeof decisionLedgerV3Schema>;

const snapshotRefSchema = z
  .object({
    ref: nonEmptyString,
    sha256: sha256Schema,
    asOf: isoTimestampSchema,
    freshness: nonEmptyString.optional(),
  })
  .strict();

const providedRefsSchema = z.discriminatedUnion("provided", [
  z
    .object({
      provided: z.literal(true),
      refs: z.array(snapshotRefSchema).min(1),
    })
    .strict(),
  z.object({ provided: z.literal(false), note: nonEmptyString }).strict(),
]);

const riskSnapshotSchema = z.discriminatedUnion("provided", [
  z
    .object({
      provided: z.literal(true),
      envelopeVersion: z.number().int().positive(),
      refs: z.array(snapshotRefSchema).min(1),
    })
    .strict(),
  z
    .object({
      provided: z.literal(false),
      envelopeVersion: z.null(),
      note: nonEmptyString,
    })
    .strict(),
]);

const openThesisSchema = z
  .object({
    wakeId: nonEmptyString,
    fingerprint: sha256Schema,
    instrument: nonEmptyString,
    expiresAt: isoTimestampSchema,
  })
  .strict();

const historySnapshotSchema = z.discriminatedUnion("provided", [
  z
    .object({
      provided: z.literal(true),
      openTheses: z.array(openThesisSchema),
      refs: z.array(snapshotRefSchema).min(1),
    })
    .strict(),
  z.object({ provided: z.literal(false), note: nonEmptyString }).strict(),
]);

export const informationSnapshotSchema = z
  .object({
    version: z.literal(1),
    snapshotId: z.string().startsWith("snap:"),
    wakeId: nonEmptyString,
    accountId: nonEmptyString,
    asOf: isoTimestampSchema,
    market: providedRefsSchema,
    portfolio: providedRefsSchema,
    risk: riskSnapshotSchema,
    events: providedRefsSchema,
    history: historySnapshotSchema,
  })
  .strict()
  .superRefine((snapshot, ctx) => {
    if (snapshot.snapshotId !== `snap:${snapshot.wakeId}`) {
      ctx.addIssue({
        code: "custom",
        path: ["snapshotId"],
        message: 'snapshotId must equal "snap:" + wakeId',
      });
    }
  });
export type InformationSnapshot = z.infer<typeof informationSnapshotSchema>;

export const m2ToolReceiptSchema = z
  .object({
    version: z.literal(1),
    producer: z.literal("tool_surface"),
    wakeId: nonEmptyString,
    snapshotId: z.string().startsWith("snap:"),
    accountId: nonEmptyString,
    toolCallId: nonEmptyString,
    toolName: nonEmptyString,
    invokedAt: isoTimestampSchema,
    completedAt: isoTimestampSchema,
    response: z
      .object({
        ref: nonEmptyString,
        sha256: sha256Schema,
      })
      .strict(),
  })
  .strict()
  .superRefine((receipt, ctx) => {
    if (receipt.snapshotId !== `snap:${receipt.wakeId}`) {
      ctx.addIssue({
        code: "custom",
        path: ["snapshotId"],
        message: "tool receipt snapshotId must bind to its wakeId",
      });
    }
    if (Date.parse(receipt.completedAt) < Date.parse(receipt.invokedAt)) {
      ctx.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "tool receipt cannot complete before invocation",
      });
    }
  });
export type M2ToolReceipt = z.infer<typeof m2ToolReceiptSchema>;

export type M2ToolReceiptAppendContext = {
  readonly wakeId: string;
  readonly snapshotId: string;
  readonly accountId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly responseBytes: Uint8Array;
};

function m2ToolReceiptIdentity(receipt: M2ToolReceipt): string {
  return [receipt.wakeId, receipt.snapshotId, receipt.toolCallId].join(
    "\u0000",
  );
}

export function validateM2ToolReceiptContext(
  receipt: M2ToolReceipt,
  context: M2ToolReceiptAppendContext,
): string[] {
  const errors: string[] = [];
  if (receipt.wakeId !== context.wakeId) errors.push("wake_id_mismatch");
  if (receipt.snapshotId !== context.snapshotId)
    errors.push("snapshot_id_mismatch");
  if (receipt.accountId !== context.accountId)
    errors.push("account_id_mismatch");
  if (receipt.toolCallId !== context.toolCallId)
    errors.push("tool_call_id_mismatch");
  if (receipt.toolName !== context.toolName) errors.push("tool_name_mismatch");
  const responseSha256 = createHash("sha256")
    .update(context.responseBytes)
    .digest("hex");
  if (receipt.response.sha256 !== responseSha256)
    errors.push("response_sha256_mismatch");
  return errors;
}

export function appendM2ToolReceipt(
  existing: readonly M2ToolReceipt[],
  candidate: unknown,
  context: M2ToolReceiptAppendContext,
): M2ToolReceipt[] {
  const parsed = m2ToolReceiptSchema.parse(candidate);
  const contextErrors = validateM2ToolReceiptContext(parsed, context);
  if (contextErrors.length > 0) {
    throw new Error(`m2_tool_receipt_context:${contextErrors.join(",")}`);
  }
  const identity = m2ToolReceiptIdentity(parsed);
  const prior = existing.find(
    (receipt) => m2ToolReceiptIdentity(receipt) === identity,
  );
  if (!prior) return [...existing, parsed];
  if (
    JSON.stringify(canonicalizeJson(prior)) !==
    JSON.stringify(canonicalizeJson(parsed))
  ) {
    throw new Error(`m2_tool_receipt_conflict:${identity}`);
  }
  return [...existing];
}

const riskScopeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("whitelist"),
      symbols: z.array(nonEmptyString).min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("asset_class"),
      assetClasses: z.array(nonEmptyString).min(1),
    })
    .strict(),
]);

export const riskEnvelopeSchema = z
  .object({
    version: z.number().int().positive(),
    maxPositionPctOfEquity: percentageSchema,
    maxSingleOrderPctOfEquity: percentageSchema,
    maxDailyLossPct: percentageSchema,
    maxDrawdownPct: percentageSchema,
    scope: riskScopeSchema,
    autonomyCeiling: z.enum([
      "read_only",
      "paper",
      "small_live",
      "limited_autonomy",
    ]),
    revoked: z.boolean(),
    revokedReason: nonEmptyString.nullable(),
  })
  .strict()
  .superRefine((envelope, ctx) => {
    const scopeValues =
      envelope.scope.kind === "whitelist"
        ? envelope.scope.symbols
        : envelope.scope.assetClasses;
    if (new Set(scopeValues).size !== scopeValues.length) {
      ctx.addIssue({
        code: "custom",
        path: ["scope"],
        message: "risk envelope scope values must be unique",
      });
    }
    if (envelope.revoked && envelope.revokedReason === null) {
      ctx.addIssue({
        code: "custom",
        path: ["revokedReason"],
        message: "a revoked envelope requires a reason",
      });
    }
    if (!envelope.revoked && envelope.revokedReason !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["revokedReason"],
        message: "a non-revoked envelope requires revokedReason to be null",
      });
    }
  });
export type RiskEnvelope = z.infer<typeof riskEnvelopeSchema>;

export const brokerProtectionCapabilitiesSchema = z
  .object({
    market: z.boolean(),
    stop: z.boolean(),
    stopLimit: z.discriminatedUnion("supported", [
      z.object({ supported: z.literal(false) }).strict(),
      z
        .object({
          supported: z.literal(true),
          limitOffsetBps: z.number().finite().positive().lt(10_000),
        })
        .strict(),
    ]),
  })
  .strict();
export type BrokerProtectionCapabilities = z.infer<
  typeof brokerProtectionCapabilitiesSchema
>;

export const protectionRequestSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("future_protective_entry"),
      operationId: nonEmptyString,
      instrument: nonEmptyString,
      entrySide: z.enum(["BUY", "SELL"]),
      triggerPrice: positiveDecimalStringSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("immediate_reduce_risk"),
      operationId: nonEmptyString,
      instrument: nonEmptyString,
      side: z.enum(["BUY", "SELL"]),
    })
    .strict(),
]);
export type ProtectionRequest = z.infer<typeof protectionRequestSchema>;

const protectiveEntryPlanSchema = z.discriminatedUnion("orderType", [
  z
    .object({
      kind: z.literal("selected"),
      operationId: nonEmptyString,
      instrument: nonEmptyString,
      exitSide: z.enum(["BUY", "SELL"]),
      orderType: z.literal("STP"),
      triggerPrice: positiveDecimalStringSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("selected"),
      operationId: nonEmptyString,
      instrument: nonEmptyString,
      exitSide: z.enum(["BUY", "SELL"]),
      orderType: z.literal("STP_LMT"),
      triggerPrice: positiveDecimalStringSchema,
      limitPrice: positiveDecimalStringSchema,
      limitOffsetBps: z.number().finite().positive(),
    })
    .strict(),
]);

const marketReductionPlanSchema = z
  .object({
    kind: z.literal("selected"),
    operationId: nonEmptyString,
    instrument: nonEmptyString,
    side: z.enum(["BUY", "SELL"]),
    orderType: z.literal("MKT"),
  })
  .strict();

const protectionRejectionSchema = z
  .object({
    kind: z.literal("rejected"),
    operationId: nonEmptyString,
    instrument: nonEmptyString,
    code: z.enum([
      "protective_order_unsupported",
      "market_reduce_risk_unsupported",
    ]),
  })
  .strict();

export const protectionSelectionSchema = z.union([
  protectiveEntryPlanSchema,
  marketReductionPlanSchema,
  protectionRejectionSchema,
]);
export type ProtectionSelection = z.infer<typeof protectionSelectionSchema>;

function deterministicDecimal(value: number): string {
  return value.toFixed(12).replace(/\.?0+$/, "");
}

/**
 * Conservative Wave 0.5 proof selector, not a final D5 broker mapping.
 */
export function selectProtection(
  capabilitiesInput: unknown,
  requestInput: unknown,
): ProtectionSelection {
  const capabilities =
    brokerProtectionCapabilitiesSchema.parse(capabilitiesInput);
  const request = protectionRequestSchema.parse(requestInput);

  if (request.kind === "immediate_reduce_risk") {
    return capabilities.market
      ? {
          kind: "selected",
          operationId: request.operationId,
          instrument: request.instrument,
          side: request.side,
          orderType: "MKT",
        }
      : {
          kind: "rejected",
          operationId: request.operationId,
          instrument: request.instrument,
          code: "market_reduce_risk_unsupported",
        };
  }

  const exitSide = request.entrySide === "BUY" ? "SELL" : "BUY";

  if (capabilities.stop) {
    return {
      kind: "selected",
      operationId: request.operationId,
      instrument: request.instrument,
      exitSide,
      orderType: "STP",
      triggerPrice: request.triggerPrice,
    };
  }
  if (capabilities.stopLimit.supported) {
    const trigger = Number(request.triggerPrice);
    const offset = capabilities.stopLimit.limitOffsetBps / 10_000;
    const limit =
      exitSide === "SELL" ? trigger * (1 - offset) : trigger * (1 + offset);
    return {
      kind: "selected",
      operationId: request.operationId,
      instrument: request.instrument,
      exitSide,
      orderType: "STP_LMT",
      triggerPrice: request.triggerPrice,
      limitPrice: deterministicDecimal(limit),
      limitOffsetBps: capabilities.stopLimit.limitOffsetBps,
    };
  }
  return {
    kind: "rejected",
    operationId: request.operationId,
    instrument: request.instrument,
    code: "protective_order_unsupported",
  };
}

const deterministicOperationSchema = z
  .object({
    operationId: nonEmptyString,
    kind: z.enum(["order_place", "position_close"]),
    effect: z.enum(["increase", "reduce"]),
    instrument: nonEmptyString,
    side: z.enum(["BUY", "SELL"]),
    totalQuantity: nonEmptyString,
  })
  .strict();

export const sizingOutcomeSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("proposal"),
        operations: z.array(deterministicOperationSchema).min(1),
        appliedCaps: z.array(nonEmptyString),
        protections: z.array(protectiveEntryPlanSchema),
      })
      .strict(),
    z
      .object({
        kind: z.literal("clipped"),
        operations: z.array(deterministicOperationSchema).min(1),
        appliedCaps: z.array(nonEmptyString).min(1),
        protections: z.array(protectiveEntryPlanSchema),
        clippedFrom: targetExposureSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("rejected"),
        code: z.enum([
          "envelope_missing",
          "scope_violation",
          "budget_exhausted",
          "envelope_version_changed",
          "reduce_only",
          "no_priceable_invalidation",
          "protective_order_unsupported",
        ]),
        violations: z.array(nonEmptyString).min(1),
      })
      .strict(),
  ])
  .superRefine((outcome, ctx) => {
    if (outcome.kind === "rejected") return;
    const operations = new Map<string, (typeof outcome.operations)[number]>();
    for (const [index, operation] of outcome.operations.entries()) {
      if (operations.has(operation.operationId)) {
        ctx.addIssue({
          code: "custom",
          path: ["operations", index, "operationId"],
          message: "operationId must be unique",
        });
      }
      operations.set(operation.operationId, operation);
    }

    const protectionCounts = new Map<string, number>();
    for (const [index, protection] of outcome.protections.entries()) {
      protectionCounts.set(
        protection.operationId,
        (protectionCounts.get(protection.operationId) ?? 0) + 1,
      );
      const operation = operations.get(protection.operationId);
      if (!operation) {
        ctx.addIssue({
          code: "custom",
          path: ["protections", index, "operationId"],
          message: "protection references an unknown operationId",
        });
        continue;
      }
      if (operation.effect !== "increase") {
        ctx.addIssue({
          code: "custom",
          path: ["protections", index, "operationId"],
          message: "reduce-only operations must not carry entry protection",
        });
      }
      if (protection.instrument !== operation.instrument) {
        ctx.addIssue({
          code: "custom",
          path: ["protections", index, "instrument"],
          message: "protection instrument must match its operation",
        });
      }
      const expectedExitSide = operation.side === "BUY" ? "SELL" : "BUY";
      if (protection.exitSide !== expectedExitSide) {
        ctx.addIssue({
          code: "custom",
          path: ["protections", index, "exitSide"],
          message: "protection exitSide must oppose the operation side",
        });
      }
    }

    for (const [index, operation] of outcome.operations.entries()) {
      const count = protectionCounts.get(operation.operationId) ?? 0;
      const expected = operation.effect === "increase" ? 1 : 0;
      if (count !== expected) {
        ctx.addIssue({
          code: "custom",
          path: ["operations", index, "operationId"],
          message: `${operation.effect} operation requires ${expected} matching protections; got ${count}`,
        });
      }
    }
  });

export const deterministicExecutionRecordSchema = z
  .object({
    version: z.literal(1),
    recordId: nonEmptyString,
    decisionWakeId: nonEmptyString,
    accountId: nonEmptyString,
    snapshotId: z.string().startsWith("snap:"),
    snapshotSha256: sha256Schema,
    envelopeVersion: z.number().int().positive(),
    accountStateVersion: nonEmptyString,
    intentFingerprint: sha256Schema,
    sizingOutcome: sizingOutcomeSchema,
    venueOutcomes: z.array(z.unknown()),
    reconciliation: z
      .object({
        status: z.enum([
          "not_dispatched",
          "pending",
          "reconciled",
          "uncertain",
        ]),
        note: nonEmptyString,
      })
      .strict(),
    uncertainty: nonEmptyString.nullable(),
  })
  .strict();
export type DeterministicExecutionRecord = z.infer<
  typeof deterministicExecutionRecordSchema
>;

export type InitialExecutionAdmission =
  | { kind: "admitted" }
  | { kind: "proposal_only"; code: typeof PORTFOLIO_PROPOSAL_ONLY_CODE };

/**
 * The G0.2 intent-kind gate only. A single intent passing this proof is merely
 * eligible for later deterministic envelope/authz checks; this is not a full
 * production execution-admission decision.
 */
export function initialExecutionAdmission(
  intent: DecisionIntent,
): InitialExecutionAdmission {
  if (intent.kind === "portfolio") {
    return { kind: "proposal_only", code: PORTFOLIO_PROPOSAL_ONLY_CODE };
  }
  return { kind: "admitted" };
}

export const LEDGER_V3_SEMANTIC_KEYS = [
  "version",
  "wakeId",
  "at",
  "accountId",
  "decision",
  "status",
  "context",
  "completion",
  "checklist",
  "thesis",
  "actions",
  "pendingHash",
  "invalidation",
  "cost",
  "intent",
  "thesisDispositions",
] as const;

export function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      output[key] = canonicalizeJson(source[key]);
    }
    return output;
  }
  return value;
}

export function semanticLedgerV3Projection(
  entry: unknown,
): Record<string, unknown> {
  const source =
    entry && typeof entry === "object"
      ? (entry as Record<string, unknown>)
      : {};
  const output: Record<string, unknown> = {};
  for (const key of LEDGER_V3_SEMANTIC_KEYS) {
    if (key in source) output[key] = source[key];
  }
  return output;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function canonicalDecisionFingerprintV3(entry: unknown): string {
  return sha256(canonicalizeJson(semanticLedgerV3Projection(entry)));
}

export function canonicalIntentFingerprint(intent: unknown): string {
  return sha256(canonicalizeJson(intent));
}

export function canonicalInformationSnapshotHash(snapshot: unknown): string {
  return sha256(canonicalizeJson(snapshot));
}

export function validateSnapshotTemporalIntegrity(
  snapshot: InformationSnapshot,
): string[] {
  const errors: string[] = [];
  const categories = [
    ["market", snapshot.market],
    ["portfolio", snapshot.portfolio],
    ["risk", snapshot.risk],
    ["events", snapshot.events],
    ["history", snapshot.history],
  ] as const;
  for (const [categoryName, category] of categories) {
    if (!category.provided) continue;
    for (const ref of category.refs) {
      if (Date.parse(ref.asOf) > Date.parse(snapshot.asOf)) {
        errors.push(`future_ref:${categoryName}:${ref.ref}`);
      }
    }
  }
  return errors;
}

function intentInstruments(intent: DecisionIntent | null): Set<string> {
  if (intent === null) return new Set();
  if (intent.kind === "single") return new Set([intent.instrument]);
  return new Set(intent.targets.map((target) => target.instrument));
}

export function validateDecisionSnapshotBinding(
  entry: DecisionLedgerV3,
  snapshot: InformationSnapshot,
): string[] {
  const errors: string[] = [];
  if (entry.wakeId !== snapshot.wakeId) errors.push("wake_id_mismatch");
  if (entry.accountId !== snapshot.accountId)
    errors.push("account_id_mismatch");
  if (entry.intent && entry.intent.snapshotId !== snapshot.snapshotId) {
    errors.push("snapshot_id_mismatch");
  }
  if (
    entry.intent &&
    entry.intent.snapshotSha256 !== canonicalInformationSnapshotHash(snapshot)
  ) {
    errors.push("snapshot_hash_mismatch");
  }
  return errors;
}

export function validateThesisDispositionCoverage(
  entry: DecisionLedgerV3,
  snapshot: InformationSnapshot,
): string[] {
  if (!snapshot.history.provided) return [];

  const errors: string[] = [];
  const openByWakeId = new Map(
    snapshot.history.openTheses.map((thesis) => [thesis.wakeId, thesis]),
  );
  const touched = intentInstruments(entry.intent);
  const dispositionCounts = new Map<string, number>();

  for (const disposition of entry.thesisDispositions) {
    dispositionCounts.set(
      disposition.wakeId,
      (dispositionCounts.get(disposition.wakeId) ?? 0) + 1,
    );
    const thesis = openByWakeId.get(disposition.wakeId);
    if (!thesis) {
      errors.push(`unknown_thesis:${disposition.wakeId}`);
      continue;
    }
    if (
      disposition.disposition === "supersede" &&
      !touched.has(thesis.instrument)
    ) {
      errors.push(`supersede_without_replacement:${disposition.wakeId}`);
    }
    const expired = Date.parse(thesis.expiresAt) <= Date.parse(entry.at);
    if (expired && disposition.disposition === "keep") {
      errors.push(`expired_thesis_cannot_keep:${disposition.wakeId}`);
    }
  }

  for (const thesis of snapshot.history.openTheses) {
    const expired = Date.parse(thesis.expiresAt) <= Date.parse(entry.at);
    if (!expired && !touched.has(thesis.instrument)) continue;
    const count = dispositionCounts.get(thesis.wakeId) ?? 0;
    if (count !== 1) {
      errors.push(`required_disposition_count:${thesis.wakeId}:${count}`);
    }
  }

  return errors;
}

export function validateExecutionRecordLinkage(
  entry: DecisionLedgerV3,
  snapshot: InformationSnapshot,
  envelope: RiskEnvelope,
  record: DeterministicExecutionRecord,
): string[] {
  const errors = [
    ...validateDecisionSnapshotBinding(entry, snapshot),
    ...validateSnapshotTemporalIntegrity(snapshot),
  ];
  const snapshotSha256 = canonicalInformationSnapshotHash(snapshot);

  if (!snapshot.risk.provided) errors.push("snapshot_risk_missing");
  if (entry.intent === null) {
    errors.push("intent_missing");
  } else if (
    record.intentFingerprint !== canonicalIntentFingerprint(entry.intent)
  ) {
    errors.push("intent_fingerprint_mismatch");
  }
  if (record.decisionWakeId !== entry.wakeId)
    errors.push("record_wake_id_mismatch");
  if (record.accountId !== entry.accountId)
    errors.push("record_account_id_mismatch");
  if (record.snapshotId !== snapshot.snapshotId) {
    errors.push("record_snapshot_id_mismatch");
  }
  if (record.snapshotSha256 !== snapshotSha256) {
    errors.push("record_snapshot_hash_mismatch");
  }
  if (record.envelopeVersion !== envelope.version) {
    errors.push("envelope_version_mismatch");
  }
  if (
    snapshot.risk.provided &&
    snapshot.risk.envelopeVersion !== envelope.version
  ) {
    errors.push("snapshot_envelope_version_mismatch");
  }
  return errors;
}
