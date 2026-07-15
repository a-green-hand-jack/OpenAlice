import Decimal from 'decimal.js';
import { z } from 'zod';
import {
  compareStewardSizingSourceVersions,
  stewardSizingAccountViewSchema,
  stewardSizingRiskViewSchema,
  stewardBrokerProtectionCapabilitiesSchema,
  stewardDeterministicOperationSchema,
  stewardProtectiveEntryPlanSchema,
  stewardSizingSourceVersionsSchema,
  type StewardDeterministicOperation,
  type StewardSizingAccountView,
  type StewardSizingRiskView,
  type StewardBrokerProtectionCapabilities,
  type StewardProtectiveEntryPlan,
  type StewardSizingSourceVersions,
  type StewardSourceVersionBarrierResult,
} from '@traderalice/uta-protocol';

import { canonicalIntentFingerprint } from './ledger-receipt.js';
import { stewardDecisionIntentSchema, type StewardDecisionIntent } from './types.js';

export const STEWARD_SIZING_OUTCOME_SCHEMA_VERSION = 1;
export const PORTFOLIO_PROPOSAL_ONLY_CODE = 'portfolio_proposal_only';

const nonEmptyStringSchema = z.string().trim().min(1);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

function decimalStringSchema(options: { readonly positive?: boolean } = {}) {
  return z.string().refine((value) => {
    if (!/^-?(?:\d+|\d+\.\d+|\.\d+)$/.test(value)) return false;
    try {
      const parsed = new Decimal(value);
      return parsed.isFinite() && (!options.positive || parsed.gt(0));
    } catch {
      return false;
    }
  }, options.positive
    ? { message: 'expected a finite positive decimal string' }
    : { message: 'expected a finite decimal string' });
}

const positiveDecimalSchema = decimalStringSchema({ positive: true });

export {
  stewardSizingAccountViewSchema,
  stewardSizingRiskViewSchema,
  stewardBrokerProtectionCapabilitiesSchema,
};
export type {
  StewardSizingAccountView,
  StewardSizingRiskView,
  StewardBrokerProtectionCapabilities,
};

const protectionRequestSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('future_protective_entry'),
    operationId: nonEmptyStringSchema,
    instrument: nonEmptyStringSchema,
    entrySide: z.enum(['BUY', 'SELL']),
    triggerPrice: positiveDecimalSchema,
  }).strict(),
  z.object({
    kind: z.literal('immediate_reduce_risk'),
    operationId: nonEmptyStringSchema,
    instrument: nonEmptyStringSchema,
    side: z.enum(['BUY', 'SELL']),
  }).strict(),
]);
export type StewardProtectionRequest = z.infer<typeof protectionRequestSchema>;

const marketReductionPlanSchema = z.object({
  kind: z.literal('selected'),
  operationId: nonEmptyStringSchema,
  instrument: nonEmptyStringSchema,
  side: z.enum(['BUY', 'SELL']),
  orderType: z.literal('MKT'),
}).strict();

const protectionRejectionSchema = z.object({
  kind: z.literal('rejected'),
  operationId: nonEmptyStringSchema,
  instrument: nonEmptyStringSchema,
  code: z.enum(['protective_order_unsupported', 'market_reduce_risk_unsupported']),
}).strict();

export const stewardProtectionSelectionSchema = z.union([
  stewardProtectiveEntryPlanSchema,
  marketReductionPlanSchema,
  protectionRejectionSchema,
]);
export type StewardProtectionSelection = z.infer<typeof stewardProtectionSelectionSchema>;

/** Deterministic protection selection. No unsupported capability degrades to a
 * naked order; STP wins over STP_LMT, whose limit price uses an explicit offset. */
export function selectStewardProtection(
  capabilitiesInput: unknown,
  requestInput: unknown,
): StewardProtectionSelection {
  const capabilities = stewardBrokerProtectionCapabilitiesSchema.parse(capabilitiesInput);
  const request = protectionRequestSchema.parse(requestInput);

  if (request.kind === 'immediate_reduce_risk') {
    return capabilities.market
      ? {
          kind: 'selected',
          operationId: request.operationId,
          instrument: request.instrument,
          side: request.side,
          orderType: 'MKT',
        }
      : {
          kind: 'rejected',
          operationId: request.operationId,
          instrument: request.instrument,
          code: 'market_reduce_risk_unsupported',
        };
  }

  const exitSide = request.entrySide === 'BUY' ? 'SELL' : 'BUY';
  if (capabilities.stop) {
    return {
      kind: 'selected',
      operationId: request.operationId,
      instrument: request.instrument,
      exitSide,
      orderType: 'STP',
      triggerPrice: request.triggerPrice,
    };
  }
  if (capabilities.stopLimit.supported) {
    const trigger = new Decimal(request.triggerPrice);
    const offset = new Decimal(capabilities.stopLimit.limitOffsetBps).div(10_000);
    const limitPrice = exitSide === 'SELL'
      ? trigger.mul(new Decimal(1).minus(offset))
      : trigger.mul(new Decimal(1).plus(offset));
    return {
      kind: 'selected',
      operationId: request.operationId,
      instrument: request.instrument,
      exitSide,
      orderType: 'STP_LMT',
      triggerPrice: request.triggerPrice,
      limitPrice: toDecimalString(limitPrice),
      limitOffsetBps: capabilities.stopLimit.limitOffsetBps,
    };
  }
  return {
    kind: 'rejected',
    operationId: request.operationId,
    instrument: request.instrument,
    code: 'protective_order_unsupported',
  };
}

export {
  compareStewardSizingSourceVersions,
  stewardDeterministicOperationSchema,
  stewardProtectiveEntryPlanSchema,
  stewardSizingSourceVersionsSchema,
};
export type {
  StewardDeterministicOperation,
  StewardProtectiveEntryPlan,
  StewardSizingSourceVersions,
  StewardSourceVersionBarrierResult,
};

const sizingIdentityShape = {
  version: z.literal(STEWARD_SIZING_OUTCOME_SCHEMA_VERSION),
  decisionWakeId: nonEmptyStringSchema,
  accountId: nonEmptyStringSchema,
  snapshotId: z.string().startsWith('snap:'),
  snapshotSha256: sha256Schema,
  intentFingerprint: sha256Schema,
  sourceStateVersions: stewardSizingSourceVersionsSchema,
};

const executableSizingShape = {
  ...sizingIdentityShape,
  operations: z.array(stewardDeterministicOperationSchema).min(1),
  appliedCaps: z.array(nonEmptyStringSchema),
  protections: z.array(stewardProtectiveEntryPlanSchema),
};

export const stewardSizingOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('proposal'), ...executableSizingShape }).strict(),
  z.object({
    kind: z.literal('clipped'),
    ...executableSizingShape,
    clippedFrom: z.object({
      minPct: z.number().finite().min(0).max(100),
      maxPct: z.number().finite().min(0).max(100),
    }).strict(),
  }).strict(),
  z.object({
    kind: z.literal('portfolio_shadow'),
    ...sizingIdentityShape,
    code: z.literal(PORTFOLIO_PROPOSAL_ONLY_CODE),
    targetCount: z.number().int().min(2),
  }).strict(),
  z.object({
    kind: z.literal('rejected'),
    ...sizingIdentityShape,
    code: z.enum([
      'agent_quantity_forbidden',
      'invalid_intent',
      'identity_mismatch',
      'envelope_missing',
      'scope_violation',
      'reduce_only',
      'budget_exhausted',
      'unpriceable',
      'no_priceable_invalidation',
      'empty_feasible_quantity',
      'protective_order_unsupported',
      'market_reduce_risk_unsupported',
    ]),
    violations: z.array(nonEmptyStringSchema).min(1),
  }).strict(),
]).superRefine((outcome, ctx) => {
  if (outcome.kind !== 'proposal' && outcome.kind !== 'clipped') return;
  const operations = new Map<string, StewardDeterministicOperation>();
  outcome.operations.forEach((operation, index) => {
    if (operations.has(operation.operationId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['operations', index, 'operationId'],
        message: 'operationId must be unique',
      });
    }
    operations.set(operation.operationId, operation);
  });
  const protectionCounts = new Map<string, number>();
  outcome.protections.forEach((protection, index) => {
    protectionCounts.set(protection.operationId, (protectionCounts.get(protection.operationId) ?? 0) + 1);
    const operation = operations.get(protection.operationId);
    if (!operation) {
      ctx.addIssue({
        code: 'custom',
        path: ['protections', index, 'operationId'],
        message: 'protection references an unknown operationId',
      });
      return;
    }
    if (operation.effect !== 'increase') {
      ctx.addIssue({
        code: 'custom',
        path: ['protections', index, 'operationId'],
        message: 'reduce operations must not carry entry protection',
      });
    }
    if (protection.instrument !== operation.instrument) {
      ctx.addIssue({ code: 'custom', path: ['protections', index, 'instrument'], message: 'protection instrument mismatch' });
    }
    const expectedExitSide = operation.side === 'BUY' ? 'SELL' : 'BUY';
    if (protection.exitSide !== expectedExitSide) {
      ctx.addIssue({ code: 'custom', path: ['protections', index, 'exitSide'], message: 'protection must oppose entry side' });
    }
  });
  outcome.operations.forEach((operation, index) => {
    const expected = operation.effect === 'increase' ? 1 : 0;
    const actual = protectionCounts.get(operation.operationId) ?? 0;
    if (actual !== expected) {
      ctx.addIssue({
        code: 'custom',
        path: ['operations', index, 'operationId'],
        message: `${operation.effect} operation requires ${expected} matching protections; got ${actual}`,
      });
    }
  });
});
export type StewardSizingOutcome = z.infer<typeof stewardSizingOutcomeSchema>;

export const stewardDeterministicSizingInputSchema = z.object({
  decisionWakeId: nonEmptyStringSchema,
  accountId: nonEmptyStringSchema,
  decision: z.enum(['propose_change', 'reduce_risk']),
  rawIntent: z.unknown(),
  snapshot: z.object({
    snapshotId: z.string().startsWith('snap:'),
    snapshotSha256: sha256Schema,
  }).strict(),
  account: stewardSizingAccountViewSchema,
  risk: stewardSizingRiskViewSchema,
  brokerCapabilities: stewardBrokerProtectionCapabilitiesSchema,
}).strict();
export type StewardDeterministicSizingInput = z.infer<typeof stewardDeterministicSizingInputSchema>;

type RejectionCode = Extract<StewardSizingOutcome, { kind: 'rejected' }>['code'];
type SizingIdentity = Pick<
  StewardSizingOutcome,
  'version' | 'decisionWakeId' | 'accountId' | 'snapshotId' | 'snapshotSha256' | 'intentFingerprint' | 'sourceStateVersions'
>;

/** Sole source of executable quantity for D2. Agent-authored totalQuantity is
 * rejected before intent parsing and never participates in arithmetic. */
export function sizeStewardDecision(inputValue: unknown): StewardSizingOutcome {
  const input = stewardDeterministicSizingInputSchema.parse(inputValue);
  const identity = sizingIdentity(input);

  if (containsKey(input.rawIntent, 'totalQuantity')) {
    return reject(identity, 'agent_quantity_forbidden', ['Decision Intent must not contain totalQuantity']);
  }
  const parsedIntent = stewardDecisionIntentSchema.safeParse(input.rawIntent);
  if (!parsedIntent.success) {
    return reject(identity, 'invalid_intent', parsedIntent.error.issues.map((issue) => issue.message));
  }
  const intent = parsedIntent.data;
  const identityViolations = validateSizingIdentity(input, intent);
  if (identityViolations.length > 0) return reject(identity, 'identity_mismatch', identityViolations);

  if (intent.kind === 'portfolio') {
    return stewardSizingOutcomeSchema.parse({
      kind: 'portfolio_shadow',
      ...identity,
      code: PORTFOLIO_PROPOSAL_ONLY_CODE,
      targetCount: intent.targets.length,
    });
  }
  if (input.risk.envelope.kind === 'missing') {
    return reject(identity, 'envelope_missing', ['A versioned Risk Envelope is required for sizing']);
  }

  return sizeSingleIntent(input, intent, identity);
}

function sizeSingleIntent(
  input: StewardDeterministicSizingInput,
  intent: Extract<StewardDecisionIntent, { kind: 'single' }>,
  identity: SizingIdentity,
): StewardSizingOutcome {
  const accountInstrument = input.account.instrument;
  const envelope = input.risk.envelope;
  if (envelope.kind !== 'available') {
    return reject(identity, 'envelope_missing', ['A versioned Risk Envelope is required for sizing']);
  }
  const currentQuantity = new Decimal(accountInstrument.positionQuantity);
  const currentAbs = currentQuantity.abs();
  const currentSign = currentQuantity.comparedTo(0);
  const targetSign = intent.direction === 'long' ? 1 : intent.direction === 'short' ? -1 : 0;

  if (targetSign === 0) {
    if (currentQuantity.isZero()) return reject(identity, 'empty_feasible_quantity', ['Position is already flat']);
    return executableOutcome({
      input,
      intent,
      identity,
      finalQuantity: new Decimal(0),
      appliedCaps: [],
      clipped: false,
      triggerPrice: null,
    });
  }

  const markPriceRaw = accountInstrument.markPrice;
  if (markPriceRaw === null) {
    return reject(identity, 'unpriceable', ['A positive deterministic mark price is required for a non-flat target']);
  }
  const equity = new Decimal(input.account.equity);
  const markPrice = new Decimal(markPriceRaw);
  const multiplier = new Decimal(accountInstrument.contractMultiplier);
  const unitNotional = markPrice.mul(multiplier);
  const targetMin = pctOf(equity, intent.targetExposure.minPct).div(unitNotional);
  const targetMax = pctOf(equity, intent.targetExposure.maxPct).div(unitNotional);
  const maxOrderDelta = pctOf(equity, envelope.caps.maxSingleOrderPctOfEquity).div(unitNotional);
  const positionCap = pctOf(equity, envelope.caps.maxPositionPctOfEquity).div(unitNotional);
  const sameDirection = currentSign === targetSign;
  const reductionOnly = input.decision === 'reduce_risk' || !envelope.increaseAllowed;

  if (!envelope.scopeAllowed && !(sameDirection && targetMax.lte(currentAbs))) {
    return reject(identity, 'scope_violation', [`Risk Envelope scope excludes ${intent.instrument}`]);
  }
  if (reductionOnly && (!sameDirection || currentAbs.isZero() || targetMin.gte(currentAbs))) {
    return reject(identity, 'reduce_only', ['The target has no feasible risk-reducing quantity']);
  }

  let lower = targetMin;
  let upper = targetMax;
  const appliedCaps: string[] = [];

  if (sameDirection) {
    lower = Decimal.max(lower, Decimal.max(new Decimal(0), currentAbs.minus(maxOrderDelta)));
    const orderUpper = currentAbs.plus(maxOrderDelta);
    if (upper.gt(orderUpper)) appliedCaps.push('riskEnvelope.maxSingleOrderPctOfEquity');
    upper = Decimal.min(upper, orderUpper);
  } else {
    const orderUpper = Decimal.max(new Decimal(0), maxOrderDelta.minus(currentAbs));
    if (upper.gt(orderUpper)) appliedCaps.push('riskEnvelope.maxSingleOrderPctOfEquity');
    upper = Decimal.min(upper, orderUpper);
  }

  const positionCeiling = sameDirection && currentAbs.gt(positionCap) ? currentAbs : positionCap;
  if (upper.gt(positionCeiling)) appliedCaps.push('riskEnvelope.maxPositionPctOfEquity');
  upper = Decimal.min(upper, positionCeiling);

  let triggerPrice: Decimal | null = null;
  const couldIncrease = !sameDirection || upper.gt(currentAbs);
  if (couldIncrease && !reductionOnly) {
    triggerPrice = selectPriceInvalidation(intent, markPrice);
    if (triggerPrice === null) {
      return reject(identity, 'no_priceable_invalidation', [
        `${intent.direction} exposure requires a correctly sided price invalidation relative to ${markPriceRaw}`,
      ]);
    }
    const intentLossPct = new Decimal(String(intent.maxAcceptableLossPct));
    const remainingLossPct = new Decimal(envelope.caps.remainingLossPctOfEquity);
    const effectiveLossPct = Decimal.min(intentLossPct, remainingLossPct);
    if (effectiveLossPct.lte(0)) {
      return reject(identity, 'budget_exhausted', ['No deterministic loss budget remains']);
    }
    const lossPerUnit = markPrice.minus(triggerPrice).abs().mul(multiplier);
    const lossCeiling = pctOf(equity, effectiveLossPct).div(lossPerUnit);
    const nonWorseningLossCeiling = sameDirection && currentAbs.gt(lossCeiling) ? currentAbs : lossCeiling;
    if (upper.gt(nonWorseningLossCeiling)) {
      if (intentLossPct.lte(remainingLossPct)) appliedCaps.push('intent.maxAcceptableLossPct');
      if (remainingLossPct.lte(intentLossPct)) appliedCaps.push('riskEnvelope.remainingLossPctOfEquity');
    }
    upper = Decimal.min(upper, nonWorseningLossCeiling);
  }

  if (reductionOnly) {
    if (upper.gt(currentAbs)) appliedCaps.push('riskEnvelope.increaseAllowed');
    upper = Decimal.min(upper, currentAbs);
  }

  if (lower.gt(upper)) {
    return reject(identity, 'empty_feasible_quantity', ['Target exposure and deterministic risk constraints do not intersect']);
  }
  const increment = new Decimal(accountInstrument.quantityIncrement);
  const selectedAbs = roundDownToIncrement(upper, increment);
  if (selectedAbs.lt(lower) || selectedAbs.lte(0)) {
    return reject(identity, 'empty_feasible_quantity', ['No positive broker quantity increment fits the feasible interval']);
  }
  if (!selectedAbs.eq(upper)) appliedCaps.push('broker.quantityIncrement');

  const finalQuantity = selectedAbs.mul(targetSign);
  if (finalQuantity.eq(currentQuantity)) {
    return reject(identity, 'empty_feasible_quantity', ['The feasible target produces no executable quantity']);
  }
  const clipped = selectedAbs.lt(targetMax);
  return executableOutcome({
    input,
    intent,
    identity,
    finalQuantity,
    appliedCaps: [...new Set(appliedCaps)],
    clipped,
    triggerPrice,
  });
}

function executableOutcome(input: {
  readonly input: StewardDeterministicSizingInput;
  readonly intent: Extract<StewardDecisionIntent, { kind: 'single' }>;
  readonly identity: SizingIdentity;
  readonly finalQuantity: Decimal;
  readonly appliedCaps: readonly string[];
  readonly clipped: boolean;
  readonly triggerPrice: Decimal | null;
}): StewardSizingOutcome {
  const current = new Decimal(input.input.account.instrument.positionQuantity);
  const quantityIncrement = new Decimal(input.input.account.instrument.quantityIncrement);
  const operations: StewardDeterministicOperation[] = [];
  const protections: StewardProtectiveEntryPlan[] = [];
  let ordinal = 0;

  const addReduction = (quantity: Decimal, closesPosition: boolean): RejectionCode | null => {
    if (quantity.lte(0)) return null;
    if (!quantity.div(quantityIncrement).isInteger()) return 'empty_feasible_quantity';
    const operationId = makeOperationId(input.input.decisionWakeId, 'reduce', ordinal++);
    const side = current.gt(0) ? 'SELL' : 'BUY';
    const selection = selectStewardProtection(input.input.brokerCapabilities, {
      kind: 'immediate_reduce_risk',
      operationId,
      instrument: input.intent.instrument,
      side,
    });
    if (selection.kind === 'rejected') return selection.code;
    operations.push({
      operationId,
      kind: closesPosition ? 'position_close' : 'order_place',
      effect: 'reduce',
      instrument: input.intent.instrument,
      side,
      totalQuantity: toDecimalString(quantity),
    });
    return null;
  };

  const addIncrease = (quantity: Decimal): RejectionCode | null => {
    if (quantity.lte(0)) return null;
    if (!quantity.div(quantityIncrement).isInteger()) return 'empty_feasible_quantity';
    if (input.triggerPrice === null) return 'no_priceable_invalidation';
    const operationId = makeOperationId(input.input.decisionWakeId, 'increase', ordinal++);
    const side = input.finalQuantity.gt(0) ? 'BUY' : 'SELL';
    const selection = selectStewardProtection(input.input.brokerCapabilities, {
      kind: 'future_protective_entry',
      operationId,
      instrument: input.intent.instrument,
      entrySide: side,
      triggerPrice: toDecimalString(input.triggerPrice),
    });
    if (selection.kind === 'rejected') return selection.code;
    if (selection.orderType === 'MKT') return 'protective_order_unsupported';
    operations.push({
      operationId,
      kind: 'order_place',
      effect: 'increase',
      instrument: input.intent.instrument,
      side,
      totalQuantity: toDecimalString(quantity),
    });
    protections.push(selection);
    return null;
  };

  const sameSide = current.comparedTo(0) === input.finalQuantity.comparedTo(0);
  let error: RejectionCode | null = null;
  if (input.finalQuantity.isZero()) {
    error = addReduction(current.abs(), true);
  } else if (current.isZero()) {
    error = addIncrease(input.finalQuantity.abs());
  } else if (sameSide && input.finalQuantity.abs().lt(current.abs())) {
    error = addReduction(current.abs().minus(input.finalQuantity.abs()), false);
  } else if (sameSide) {
    error = addIncrease(input.finalQuantity.abs().minus(current.abs()));
  } else {
    error = addReduction(current.abs(), true);
    if (error === null) error = addIncrease(input.finalQuantity.abs());
  }

  if (error !== null) {
    return reject(input.identity, error, [`Deterministic broker constraints cannot safely realize ${input.intent.instrument}`]);
  }
  const base = {
    ...input.identity,
    operations,
    appliedCaps: [...input.appliedCaps],
    protections,
  };
  return stewardSizingOutcomeSchema.parse(input.clipped
    ? { kind: 'clipped', ...base, clippedFrom: input.intent.targetExposure }
    : { kind: 'proposal', ...base });
}

function sizingIdentity(input: StewardDeterministicSizingInput): SizingIdentity {
  return {
    version: STEWARD_SIZING_OUTCOME_SCHEMA_VERSION,
    decisionWakeId: input.decisionWakeId,
    accountId: input.accountId,
    snapshotId: input.snapshot.snapshotId,
    snapshotSha256: input.snapshot.snapshotSha256,
    intentFingerprint: canonicalIntentFingerprint(input.rawIntent),
    sourceStateVersions: {
      accountState: input.account.accountStateVersion,
      riskState: input.risk.riskStateVersion,
      riskEnvelope: input.risk.envelope.kind === 'available' ? input.risk.envelope.envelopeVersion : null,
      brokerCapabilities: input.brokerCapabilities.capabilitiesStateVersion,
    },
  };
}

function validateSizingIdentity(
  input: StewardDeterministicSizingInput,
  intent: StewardDecisionIntent,
): string[] {
  const violations: string[] = [];
  if (input.account.accountId !== input.accountId) violations.push('account_view_account_id_mismatch');
  if (input.risk.accountId !== input.accountId) violations.push('risk_view_account_id_mismatch');
  if (intent.snapshotId !== input.snapshot.snapshotId) violations.push('snapshot_id_mismatch');
  if (intent.snapshotSha256 !== input.snapshot.snapshotSha256) violations.push('snapshot_hash_mismatch');
  if (intent.kind === 'single' && intent.instrument !== input.account.instrument.instrument) {
    violations.push('account_instrument_mismatch');
  }
  return violations;
}

function selectPriceInvalidation(
  intent: Extract<StewardDecisionIntent, { kind: 'single' }>,
  markPrice: Decimal,
): Decimal | null {
  const candidates = intent.invalidation.flatMap((item) => {
    if (intent.direction === 'long' && item.kind === 'price_below') {
      const value = new Decimal(item.value);
      return value.lt(markPrice) ? [value] : [];
    }
    if (intent.direction === 'short' && item.kind === 'price_above') {
      const value = new Decimal(item.value);
      return value.gt(markPrice) ? [value] : [];
    }
    return [];
  });
  if (candidates.length === 0) return null;
  return intent.direction === 'long' ? Decimal.max(...candidates) : Decimal.min(...candidates);
}

function reject(identity: SizingIdentity, code: RejectionCode, violations: readonly string[]): StewardSizingOutcome {
  return stewardSizingOutcomeSchema.parse({ kind: 'rejected', ...identity, code, violations: [...violations] });
}

function containsKey(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((item) => containsKey(item, key));
  if (value === null || typeof value !== 'object') return false;
  const source = value as Record<string, unknown>;
  return Object.prototype.hasOwnProperty.call(source, key)
    || Object.values(source).some((item) => containsKey(item, key));
}

function pctOf(value: Decimal, pct: Decimal.Value): Decimal {
  return value.mul(new Decimal(pct)).div(100);
}

function roundDownToIncrement(value: Decimal, increment: Decimal): Decimal {
  return value.div(increment).floor().mul(increment);
}

function makeOperationId(wakeId: string, effect: 'increase' | 'reduce', ordinal: number): string {
  return `operation:${encodeURIComponent(wakeId)}:${effect}:${ordinal}`;
}

function toDecimalString(value: Decimal): string {
  const fixed = value.toFixed();
  return fixed === '-0' ? '0' : fixed;
}
