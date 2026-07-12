import { createHash } from 'node:crypto';

import { z } from 'zod';

import {
  decisionIntentSchema,
  type DecisionIntent as D2DecisionIntent,
} from './d2-contracts.js';

export type DecisionIntent = D2DecisionIntent;
export type SingleDecisionIntent = Extract<DecisionIntent, { kind: 'single' }>;
export type PortfolioDecisionIntent = Extract<DecisionIntent, { kind: 'portfolio' }>;
export type DecisionTarget = PortfolioDecisionIntent['targets'][number];
export type DecisionDirection = DecisionTarget['direction'];
export type DecisionConfidence = DecisionIntent['confidence'];
export type TargetExposure = DecisionTarget['targetExposure'];
export type DecisionInvalidation = DecisionTarget['invalidation'][number];

export interface ReferenceBar {
  readonly at: string;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
}

export interface DecisionReferenceInput {
  readonly intent: unknown;
  readonly decisionAt: string;
  readonly initialEquity: number;
  readonly tape: Readonly<Record<string, readonly ReferenceBar[]>>;
}

export const DECISION_REFERENCE_POLICY = Object.freeze({
  id: 'decision-reference-midpoint-next-open',
  version: 2,
  targetExposure: 'range_midpoint',
  entryPrice: 'first_bar_open_strictly_after_decision_at',
  markPrice: 'bar_close',
  stopFill: 'trigger_or_worse_gap_open',
  horizonClock: 'hour=1h,day=24h,week=7d,month=30d',
  horizonExit: 'first_subsequent_bar_open_at_or_after_expiry',
  exitPriority: 'horizon_before_intrabar_price_stop',
  timeExpiryInvalidation: 'represented_by_time_horizon',
  thesisInvalidation: 'reported_not_machine_evaluated',
  confidenceAffectsExposure: false,
} as const);

export interface DecisionReferenceOperation {
  readonly at: string;
  readonly instrument: string;
  readonly action: 'enter' | 'stop_exit' | 'horizon_exit';
  readonly quantityDelta: number;
  readonly price: number;
}

export interface DecisionReferencePoint {
  readonly at: string;
  readonly cash: number;
  readonly equity: number;
  readonly positions: readonly {
    readonly instrument: string;
    readonly quantity: number;
    readonly markPrice: number;
    readonly marketValue: number;
    readonly stopped: boolean;
  }[];
  readonly operations: readonly DecisionReferenceOperation[];
}

export interface DecisionReferenceTrajectory {
  readonly schema: 'decision-reference-trajectory/1';
  readonly policy: typeof DECISION_REFERENCE_POLICY;
  readonly policyHash: string;
  readonly inputHash: string;
  readonly intentKind: DecisionIntent['kind'];
  readonly decisionAt: string;
  readonly horizonExpiresAt: string;
  readonly nonPriceInvalidations: readonly {
    readonly instrument: string;
    readonly kind: 'time_expiry' | 'thesis';
    readonly handling: 'represented_by_time_horizon' | 'not_machine_evaluated';
    readonly note: string;
  }[];
  readonly points: readonly DecisionReferencePoint[];
  readonly metrics: {
    readonly startEquity: number;
    readonly endEquity: number;
    readonly totalReturn: number;
    readonly maxDrawdown: number;
    readonly turnover: number;
    readonly targetGrossExposurePct: number;
  };
  readonly trajectoryHash: string;
}

export interface PairedOneShotEvidence {
  readonly snapshotBytes: string | Uint8Array;
  readonly evaluatorInputBytes: string | Uint8Array;
}

export interface PairedOneShotProof {
  readonly mode: 'paired_one_shot';
  readonly valid: boolean;
  readonly mismatches: readonly ('snapshot_bytes' | 'evaluator_input_bytes')[];
  readonly hashes: {
    readonly leftSnapshot: string;
    readonly rightSnapshot: string;
    readonly leftEvaluatorInput: string;
    readonly rightEvaluatorInput: string;
  };
}

export function provePairedOneShot(
  left: PairedOneShotEvidence,
  right: PairedOneShotEvidence,
): PairedOneShotProof {
  const mismatches: Array<'snapshot_bytes' | 'evaluator_input_bytes'> = [];
  if (!bytesEqual(left.snapshotBytes, right.snapshotBytes)) mismatches.push('snapshot_bytes');
  if (!bytesEqual(left.evaluatorInputBytes, right.evaluatorInputBytes)) {
    mismatches.push('evaluator_input_bytes');
  }
  return {
    mode: 'paired_one_shot',
    valid: mismatches.length === 0,
    mismatches,
    hashes: {
      leftSnapshot: sha256Bytes(left.snapshotBytes),
      rightSnapshot: sha256Bytes(right.snapshotBytes),
      leftEvaluatorInput: sha256Bytes(left.evaluatorInputBytes),
      rightEvaluatorInput: sha256Bytes(right.evaluatorInputBytes),
    },
  };
}

export interface StatefulEpisodeEvidence {
  readonly initialSnapshotBytes: string | Uint8Array;
  readonly tapeBytes: string | Uint8Array;
  readonly wakeScheduleBytes: string | Uint8Array;
  readonly costAssumptionsBytes: string | Uint8Array;
  readonly evaluator: { readonly id: string; readonly version: number };
  readonly laterStateChain: readonly {
    readonly wake: number;
    readonly portfolioHash: string;
    readonly historyHash: string;
  }[];
}

export interface StatefulEpisodeProof {
  readonly mode: 'stateful_episode';
  readonly valid: boolean;
  readonly basisMismatches: readonly string[];
  readonly laterStateDiverged: boolean;
}

export function proveStatefulEpisode(
  left: StatefulEpisodeEvidence,
  right: StatefulEpisodeEvidence,
): StatefulEpisodeProof {
  const basisMismatches: string[] = [];
  if (!bytesEqual(left.initialSnapshotBytes, right.initialSnapshotBytes)) {
    basisMismatches.push('initial_snapshot_bytes');
  }
  if (!bytesEqual(left.tapeBytes, right.tapeBytes)) basisMismatches.push('external_tape_bytes');
  if (!bytesEqual(left.wakeScheduleBytes, right.wakeScheduleBytes)) {
    basisMismatches.push('wake_schedule_bytes');
  }
  if (!bytesEqual(left.costAssumptionsBytes, right.costAssumptionsBytes)) {
    basisMismatches.push('cost_assumptions_bytes');
  }
  if (left.evaluator.id !== right.evaluator.id || left.evaluator.version !== right.evaluator.version) {
    basisMismatches.push('evaluator_version');
  }
  const leftSchedule = parseWakeSchedule(left.wakeScheduleBytes);
  const rightSchedule = parseWakeSchedule(right.wakeScheduleBytes);
  if (leftSchedule === null) basisMismatches.push('left_wake_schedule_invalid');
  if (rightSchedule === null) basisMismatches.push('right_wake_schedule_invalid');
  if (leftSchedule !== null && !chainMatchesWakeSchedule(left.laterStateChain, leftSchedule)) {
    basisMismatches.push('left_later_state_schedule_mismatch');
  }
  if (rightSchedule !== null && !chainMatchesWakeSchedule(right.laterStateChain, rightSchedule)) {
    basisMismatches.push('right_later_state_schedule_mismatch');
  }
  const comparableLaterState = basisMismatches.length === 0;
  return {
    mode: 'stateful_episode',
    valid: basisMismatches.length === 0,
    basisMismatches,
    laterStateDiverged: comparableLaterState && left.laterStateChain.some((leftState, index) => {
      const rightState = right.laterStateChain[index];
      return leftState.portfolioHash !== rightState.portfolioHash ||
        leftState.historyHash !== rightState.historyHash;
    }),
  };
}

interface MutablePosition {
  readonly target: DecisionTarget;
  quantity: number;
  stopped: boolean;
}

export function evaluateDecisionReference(input: DecisionReferenceInput): DecisionReferenceTrajectory {
  const intent = decisionIntentSchema.parse(input.intent);
  const { decisionAt, initialEquity, tape } = input;
  if (!isoTimestampSchema.safeParse(decisionAt).success) {
    throw new Error('decisionAt must be an ISO timestamp');
  }
  const decisionAtMs = Date.parse(decisionAt);
  if (!Number.isFinite(initialEquity) || initialEquity <= 0) {
    throw new Error('initialEquity must be a positive finite number');
  }
  const targets = intent.kind === 'single' ? [intent] : [...intent.targets];
  const barsByTarget = targets.map((target) => {
    const bars = tape[target.instrument];
    if (!bars || bars.length === 0) throw new Error(`missing tape for ${target.instrument}`);
    return bars;
  });
  const timeline = barsByTarget[0].map((bar) => bar.at);
  for (const bars of barsByTarget) {
    if (bars.length !== timeline.length || bars.some((bar, index) => bar.at !== timeline[index])) {
      throw new Error('all target tapes must share one timestamp-aligned timeline');
    }
    let priorAt = decisionAtMs;
    for (const bar of bars) {
      validateBar(bar);
      const barAt = Date.parse(bar.at);
      if (barAt <= decisionAtMs) {
        throw new Error(`reference tape bar must be strictly after decisionAt: ${bar.at}`);
      }
      if (barAt <= priorAt) throw new Error(`reference tape must be strictly increasing: ${bar.at}`);
      priorAt = barAt;
    }
  }

  const horizonExpiresAtMs = decisionAtMs + horizonDurationMs(intent.timeHorizon);
  const horizonExpiresAt = new Date(horizonExpiresAtMs).toISOString();
  const nonPriceInvalidations: Array<DecisionReferenceTrajectory['nonPriceInvalidations'][number]> = [];
  for (const target of targets) {
    for (const invalidation of target.invalidation) {
      if (invalidation.kind === 'time_expiry') {
        nonPriceInvalidations.push({
          instrument: target.instrument,
          kind: invalidation.kind,
          handling: 'represented_by_time_horizon',
          note: invalidation.note,
        });
      } else if (invalidation.kind === 'thesis') {
        nonPriceInvalidations.push({
          instrument: target.instrument,
          kind: invalidation.kind,
          handling: 'not_machine_evaluated',
          note: invalidation.note,
        });
      }
    }
  }

  let cash = initialEquity;
  let turnoverNotional = 0;
  const positions: MutablePosition[] = [];
  const entryOperations: DecisionReferenceOperation[] = [];
  const entryIsBeforeExpiry = Date.parse(timeline[0]) < horizonExpiresAtMs;
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];
    const entryPrice = barsByTarget[index][0].open;
    const targetPct = midpoint(target.targetExposure);
    const sign = target.direction === 'long' ? 1 : target.direction === 'short' ? -1 : 0;
    const quantity = entryIsBeforeExpiry
      ? sign * initialEquity * (targetPct / 100) / entryPrice
      : 0;
    cash -= quantity * entryPrice;
    turnoverNotional += Math.abs(quantity * entryPrice);
    positions.push({ target, quantity, stopped: false });
    if (quantity !== 0) {
      entryOperations.push({
        at: timeline[0],
        instrument: target.instrument,
        action: 'enter',
        quantityDelta: round(quantity),
        price: round(entryPrice),
      });
    }
  }

  const points: DecisionReferencePoint[] = [];
  for (let barIndex = 0; barIndex < timeline.length; barIndex += 1) {
    const operations = barIndex === 0 ? [...entryOperations] : [];
    for (let targetIndex = 0; targetIndex < positions.length; targetIndex += 1) {
      const position = positions[targetIndex];
      if (position.quantity === 0) continue;
      const bar = barsByTarget[targetIndex][barIndex];
      if (barIndex > 0 && Date.parse(bar.at) >= horizonExpiresAtMs) {
        const exitedQuantity = position.quantity;
        cash += exitedQuantity * bar.open;
        turnoverNotional += Math.abs(exitedQuantity * bar.open);
        position.quantity = 0;
        operations.push({
          at: bar.at,
          instrument: position.target.instrument,
          action: 'horizon_exit',
          quantityDelta: round(-exitedQuantity),
          price: round(bar.open),
        });
        continue;
      }
      const exitPrice = stopExitPrice(position.target, position.quantity, bar);
      if (exitPrice === null) continue;
      const exitedQuantity = position.quantity;
      cash += exitedQuantity * exitPrice;
      turnoverNotional += Math.abs(exitedQuantity * exitPrice);
      position.quantity = 0;
      position.stopped = true;
      operations.push({
        at: bar.at,
        instrument: position.target.instrument,
        action: 'stop_exit',
        quantityDelta: round(-exitedQuantity),
        price: round(exitPrice),
      });
    }

    const markedPositions = positions.map((position, targetIndex) => {
      const markPrice = barsByTarget[targetIndex][barIndex].close;
      return {
        instrument: position.target.instrument,
        quantity: round(position.quantity),
        markPrice: round(markPrice),
        marketValue: round(position.quantity * markPrice),
        stopped: position.stopped,
      };
    });
    const equity = cash + markedPositions.reduce((sum, position) => sum + position.marketValue, 0);
    points.push({
      at: timeline[barIndex],
      cash: round(cash),
      equity: round(equity),
      positions: markedPositions,
      operations,
    });
  }

  const equities = [initialEquity, ...points.map((point) => point.equity)];
  const endEquity = equities[equities.length - 1];
  const withoutHash = {
    schema: 'decision-reference-trajectory/1' as const,
    policy: DECISION_REFERENCE_POLICY,
    policyHash: sha256Canonical(DECISION_REFERENCE_POLICY),
    inputHash: sha256Canonical({ intent, decisionAt, initialEquity, tape }),
    intentKind: intent.kind,
    decisionAt,
    horizonExpiresAt,
    nonPriceInvalidations,
    points,
    metrics: {
      startEquity: round(initialEquity),
      endEquity: round(endEquity),
      totalReturn: round((endEquity - initialEquity) / initialEquity),
      maxDrawdown: round(maxDrawdown(equities)),
      turnover: round(turnoverNotional / initialEquity),
      targetGrossExposurePct: round(targets.reduce(
        (sum, target) => sum + (target.direction === 'flat' ? 0 : midpoint(target.targetExposure)),
        0,
      )),
    },
  };
  return { ...withoutHash, trajectoryHash: sha256Canonical(withoutHash) };
}

const nonEmptyStringSchema = z.string().trim().min(1);
const isoTimestampSchema = z.string().datetime({ offset: true });
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const wakeOrdinalSchema = z.number().int().positive();
const contentIdentitySchema = z.object({
  ref: nonEmptyStringSchema,
  sha256: sha256Schema,
}).strict();

const wakeScheduleSchema = z.object({
  schema: z.literal('steward-wake-schedule/1'),
  wakes: z.array(z.object({
    ordinal: wakeOrdinalSchema,
    at: isoTimestampSchema,
  }).strict()).min(1),
}).strict();

const publicationSchema = z.object({
  ref: nonEmptyStringSchema,
  eventAt: isoTimestampSchema,
  publishedAt: isoTimestampSchema,
  usedAtWakes: z.array(wakeOrdinalSchema).min(1),
}).strict();

const corporateActionSchema = z.object({
  ref: nonEmptyStringSchema,
  kind: z.enum(['split', 'dividend', 'merger', 'spinoff']),
  effectiveAt: isoTimestampSchema,
  publishedAt: isoTimestampSchema,
  usedAtWakes: z.array(wakeOrdinalSchema).min(1),
}).strict();

export const stewardDataManifestSchema = z.object({
  schema: z.literal('steward-eval-data-manifest/1'),
  datasetId: nonEmptyStringSchema,
  source: z.object({
    provider: nonEmptyStringSchema,
    dataset: nonEmptyStringSchema,
    rawSymbol: nonEmptyStringSchema,
    assetClass: nonEmptyStringSchema,
  }).strict(),
  decisionCutoffs: z.array(z.object({
    wake: wakeOrdinalSchema,
    asOf: isoTimestampSchema,
    snapshot: contentIdentitySchema,
  }).strict()).min(1),
  timezone: nonEmptyStringSchema,
  exchangeCalendar: nonEmptyStringSchema,
  adjustment: z.object({
    mode: z.enum(['adjusted', 'unadjusted']),
    corporateActionRefs: z.array(nonEmptyStringSchema),
  }).strict(),
  publications: z.object({
    provided: z.boolean(),
    items: z.array(publicationSchema),
  }).strict(),
  corporateActions: z.array(corporateActionSchema),
  universe: z.object({
    selectionBasis: z.enum(['point_in_time', 'current_members']),
    membershipAsOf: isoTimestampSchema,
    effectiveFrom: isoTimestampSchema,
    effectiveTo: isoTimestampSchema.nullable(),
    sourceRef: nonEmptyStringSchema,
  }).strict(),
  delisting: z.object({
    status: z.enum(['active', 'delisted']),
    handling: z.enum(['not_applicable', 'terminal_return', 'cash_recovery']),
    delistedAt: isoTimestampSchema.nullable(),
  }).strict(),
  sampling: z.object({
    kind: z.enum(['continuous_walk_forward', 'regime_labeled']),
    frozenAt: isoTimestampSchema,
    plan: contentIdentitySchema,
  }).strict(),
  audit: z.object({
    manifestCreatedAt: isoTimestampSchema,
    evaluationStartedAt: isoTimestampSchema,
  }).strict(),
  content: contentIdentitySchema,
  split: z.object({
    name: z.enum(['dev', 'validation', 'holdout']),
    identity: nonEmptyStringSchema,
    leakageGroups: z.array(nonEmptyStringSchema),
    inputStart: isoTimestampSchema,
    decisionStart: isoTimestampSchema,
    decisionEnd: isoTimestampSchema,
    outcomeEnd: isoTimestampSchema,
    embargoMs: z.number().finite().nonnegative(),
  }).strict(),
}).strict();

export type StewardDataManifest = z.infer<typeof stewardDataManifestSchema>;

export interface ManifestViolation {
  readonly datasetId: string;
  readonly code: string;
  readonly detail: string;
}

export interface ManifestSetProof {
  readonly valid: boolean;
  readonly violations: readonly ManifestViolation[];
  readonly overlaps: readonly {
    readonly left: string;
    readonly right: string;
    readonly leakageGroups: readonly string[];
  }[];
}

export function validateDataManifest(
  manifest: unknown,
  contentByRef: Readonly<Record<string, string | Uint8Array>>,
): ManifestViolation[] {
  const parsed = stewardDataManifestSchema.safeParse(manifest);
  if (!parsed.success) {
    const datasetId = rawDatasetId(manifest);
    return parsed.error.issues.map((issue) => ({
      datasetId,
      code: 'manifest_shape_invalid',
      detail: `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    }));
  }
  return validateParsedDataManifest(parsed.data, contentByRef);
}

function validateParsedDataManifest(
  manifest: StewardDataManifest,
  contentByRef: Readonly<Record<string, string | Uint8Array>>,
): ManifestViolation[] {
  const violations: ManifestViolation[] = [];
  const add = (code: string, detail: string) => violations.push({ datasetId: manifest.datasetId, code, detail });
  const inputStart = Date.parse(manifest.split.inputStart);
  const decisionStart = Date.parse(manifest.split.decisionStart);
  const decisionEnd = Date.parse(manifest.split.decisionEnd);
  const outcomeEnd = Date.parse(manifest.split.outcomeEnd);
  if (!(inputStart <= decisionStart && decisionStart <= decisionEnd && decisionEnd <= outcomeEnd)) {
    add('split_time_order_invalid', 'expected inputStart <= decisionStart <= decisionEnd <= outcomeEnd');
  }

  const cutoffByWake = new Map<number, StewardDataManifest['decisionCutoffs'][number]>();
  let previousCutoff = Number.NEGATIVE_INFINITY;
  for (const [index, cutoff] of manifest.decisionCutoffs.entries()) {
    const cutoffAt = Date.parse(cutoff.asOf);
    if (cutoff.wake !== index + 1 || cutoffByWake.has(cutoff.wake)) {
      add(
        'decision_cutoff_wake_order_invalid',
        `wake ${cutoff.wake} must appear exactly once at ordinal ${index + 1}`,
      );
    }
    if (cutoffAt <= previousCutoff) {
      add('decision_cutoff_time_order_invalid', `wake ${cutoff.wake} cutoff must be strictly increasing`);
    }
    if (cutoffAt < decisionStart || cutoffAt > decisionEnd) {
      add('decision_cutoff_outside_split', `wake ${cutoff.wake} is outside decisionStart..decisionEnd`);
    }
    const snapshot = contentByRef[cutoff.snapshot.ref];
    if (snapshot === undefined) {
      add('decision_snapshot_missing', `wake ${cutoff.wake}: ${cutoff.snapshot.ref}`);
    } else if (sha256Bytes(snapshot) !== cutoff.snapshot.sha256) {
      add('decision_snapshot_hash_mismatch', `wake ${cutoff.wake}: ${cutoff.snapshot.ref}`);
    }
    cutoffByWake.set(cutoff.wake, cutoff);
    previousCutoff = cutoffAt;
  }

  const frozenAt = Date.parse(manifest.sampling.frozenAt);
  const manifestCreatedAt = Date.parse(manifest.audit.manifestCreatedAt);
  const evaluationStartedAt = Date.parse(manifest.audit.evaluationStartedAt);
  if (!(frozenAt <= manifestCreatedAt && manifestCreatedAt <= evaluationStartedAt)) {
    add(
      'sampling_audit_order_invalid',
      'sampling.frozenAt <= audit.manifestCreatedAt <= audit.evaluationStartedAt is required',
    );
  }
  const samplingPlan = contentByRef[manifest.sampling.plan.ref];
  if (samplingPlan === undefined) {
    add('sampling_plan_missing', manifest.sampling.plan.ref);
  } else if (sha256Bytes(samplingPlan) !== manifest.sampling.plan.sha256) {
    add('sampling_plan_hash_mismatch', manifest.sampling.plan.ref);
  }

  if (manifest.universe.selectionBasis !== 'point_in_time') {
    add('survivorship_bias', 'universe selection must use point-in-time membership');
  }
  const membershipAsOf = Date.parse(manifest.universe.membershipAsOf);
  const effectiveFrom = Date.parse(manifest.universe.effectiveFrom);
  const effectiveTo = manifest.universe.effectiveTo === null ? null : Date.parse(manifest.universe.effectiveTo);
  for (const cutoff of manifest.decisionCutoffs) {
    const cutoffAt = Date.parse(cutoff.asOf);
    if (membershipAsOf > cutoffAt) {
      add('future_universe_membership', `membershipAsOf is later than wake ${cutoff.wake}`);
    }
    if (effectiveFrom > cutoffAt) {
      add('outside_universe_membership', `instrument was not yet a member at wake ${cutoff.wake}`);
    }
    if (effectiveTo !== null && effectiveTo <= cutoffAt) {
      add('outside_universe_membership', `instrument membership ended before wake ${cutoff.wake}`);
    }
  }

  const publicationItems = manifest.publications.items;
  if (manifest.publications.provided !== (publicationItems.length > 0)) {
    add('publication_identity_invalid', 'provided must match whether publication items exist');
  }
  for (const item of publicationItems) {
    const seenWakes = new Set<number>();
    for (const wake of item.usedAtWakes) {
      if (seenWakes.has(wake)) {
        add('information_wake_binding_invalid', `${item.ref} duplicates wake ${wake}`);
        continue;
      }
      seenWakes.add(wake);
      const cutoff = cutoffByWake.get(wake);
      if (!cutoff) {
        add('information_wake_binding_invalid', `${item.ref} references unknown wake ${wake}`);
      } else if (Date.parse(item.publishedAt) > Date.parse(cutoff.asOf)) {
        add('future_publication', `${item.ref} was not published for wake ${wake}`);
      }
    }
  }

  const actionRefs = new Set(manifest.adjustment.corporateActionRefs);
  for (const action of manifest.corporateActions) {
    if (!actionRefs.has(action.ref)) add('corporate_action_unlinked', action.ref);
    const seenWakes = new Set<number>();
    for (const wake of action.usedAtWakes) {
      if (seenWakes.has(wake)) {
        add('information_wake_binding_invalid', `${action.ref} duplicates wake ${wake}`);
        continue;
      }
      seenWakes.add(wake);
      const cutoff = cutoffByWake.get(wake);
      if (!cutoff) {
        add('information_wake_binding_invalid', `${action.ref} references unknown wake ${wake}`);
        continue;
      }
      if (Date.parse(action.publishedAt) > Date.parse(cutoff.asOf)) {
        add('corporate_action_future_leak', `${action.ref} was not published for wake ${wake}`);
      }
      if (Date.parse(action.effectiveAt) > Date.parse(cutoff.asOf)) {
        add('corporate_action_future_leak', `${action.ref} was not effective for wake ${wake}`);
      }
    }
  }
  for (const ref of actionRefs) {
    if (!manifest.corporateActions.some((action) => action.ref === ref)) {
      add('corporate_action_missing', ref);
    }
  }

  if (manifest.delisting.status === 'active') {
    if (manifest.delisting.handling !== 'not_applicable' || manifest.delisting.delistedAt !== null) {
      add('delisting_handling_invalid', 'active instruments require not_applicable and null delistedAt');
    }
  } else {
    if (!['terminal_return', 'cash_recovery'].includes(manifest.delisting.handling) || !manifest.delisting.delistedAt) {
      add('delisting_handling_invalid', 'delisted instruments require terminal handling and delistedAt');
    } else {
      const delistedAt = Date.parse(manifest.delisting.delistedAt);
      if (delistedAt < inputStart || delistedAt > outcomeEnd) {
        add('delisting_time_invalid', 'delistedAt must fall within the evidence interval');
      }
    }
  }

  const content = contentByRef[manifest.content.ref];
  if (content === undefined) {
    add('content_missing', manifest.content.ref);
  } else if (sha256Bytes(content) !== manifest.content.sha256) {
    add('content_hash_mismatch', manifest.content.ref);
  }
  if (manifest.split.leakageGroups.length === 0) {
    add('leakage_group_missing', 'at least one leakage group is required');
  }
  return violations;
}

export function proveDataManifestSet(
  manifests: readonly unknown[],
  contentByRef: Readonly<Record<string, string | Uint8Array>>,
): ManifestSetProof {
  const violations: ManifestViolation[] = [];
  const parsedManifests: StewardDataManifest[] = [];
  for (const manifest of manifests) {
    const parsed = stewardDataManifestSchema.safeParse(manifest);
    if (!parsed.success) {
      violations.push(...validateDataManifest(manifest, contentByRef));
      continue;
    }
    parsedManifests.push(parsed.data);
    violations.push(...validateParsedDataManifest(parsed.data, contentByRef));
  }
  const identities = new Set<string>();
  for (const manifest of parsedManifests) {
    if (identities.has(manifest.split.identity)) {
      violations.push({
        datasetId: manifest.datasetId,
        code: 'split_identity_duplicate',
        detail: manifest.split.identity,
      });
    }
    identities.add(manifest.split.identity);
  }
  for (const required of ['dev', 'validation', 'holdout'] as const) {
    if (!parsedManifests.some((manifest) => manifest.split.name === required)) {
      violations.push({ datasetId: '(set)', code: 'required_split_missing', detail: required });
    }
  }
  if (!parsedManifests.some((manifest) => manifest.sampling.kind === 'continuous_walk_forward')) {
    violations.push({
      datasetId: '(set)',
      code: 'continuous_walk_forward_missing',
      detail: 'at least one audit-frozen continuous walk-forward manifest is required',
    });
  }

  const overlaps: Array<{ left: string; right: string; leakageGroups: string[] }> = [];
  for (let leftIndex = 0; leftIndex < parsedManifests.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < parsedManifests.length; rightIndex += 1) {
      const left = parsedManifests[leftIndex];
      const right = parsedManifests[rightIndex];
      if (left.split.name === right.split.name) continue;
      const duplicateContent = left.content.ref === right.content.ref || left.content.sha256 === right.content.sha256;
      if (duplicateContent) {
        violations.push({
          datasetId: `${left.datasetId}|${right.datasetId}`,
          code: 'duplicate_content_across_splits',
          detail: left.content.ref === right.content.ref ? left.content.ref : left.content.sha256,
        });
      }
      const leftIdentities = derivedLeakageIdentities(left);
      const rightIdentities = new Set(derivedLeakageIdentities(right));
      const sharedGroups = leftIdentities.filter((identity) => rightIdentities.has(identity));
      if (sharedGroups.length === 0) continue;
      if (expandedRangesOverlap(left, right)) {
        overlaps.push({ left: left.datasetId, right: right.datasetId, leakageGroups: sharedGroups });
      }
    }
  }
  for (const overlap of overlaps) {
    violations.push({
      datasetId: `${overlap.left}|${overlap.right}`,
      code: 'split_overlap',
      detail: overlap.leakageGroups.join(','),
    });
  }
  return { valid: violations.length === 0, violations, overlaps };
}

function parseWakeSchedule(
  value: string | Uint8Array,
): z.infer<typeof wakeScheduleSchema> | null {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(bytes(value)).toString('utf8')) as unknown;
  } catch {
    return null;
  }
  const parsed = wakeScheduleSchema.safeParse(raw);
  if (!parsed.success) return null;
  let previousOrdinal = 0;
  let previousAt = Number.NEGATIVE_INFINITY;
  for (const wake of parsed.data.wakes) {
    const at = Date.parse(wake.at);
    if (wake.ordinal <= previousOrdinal || at <= previousAt) return null;
    previousOrdinal = wake.ordinal;
    previousAt = at;
  }
  return parsed.data;
}

function chainMatchesWakeSchedule(
  chain: StatefulEpisodeEvidence['laterStateChain'],
  schedule: z.infer<typeof wakeScheduleSchema>,
): boolean {
  if (chain.length !== schedule.wakes.length) return false;
  const chainWakes = chain.map((state) => state.wake);
  if (new Set(chainWakes).size !== chainWakes.length) return false;
  return chainWakes.every((wake, index) => wake === schedule.wakes[index].ordinal);
}

function midpoint(exposure: TargetExposure): number {
  return (exposure.minPct + exposure.maxPct) / 2;
}

function horizonDurationMs(horizon: DecisionIntent['timeHorizon']): number {
  const unitMs = horizon.unit === 'hour' ? 60 * 60 * 1000
    : horizon.unit === 'day' ? 24 * 60 * 60 * 1000
      : horizon.unit === 'week' ? 7 * 24 * 60 * 60 * 1000
        : 30 * 24 * 60 * 60 * 1000;
  return horizon.value * unitMs;
}

function validateBar(bar: ReferenceBar): void {
  if (!Number.isFinite(Date.parse(bar.at))) throw new Error(`invalid bar timestamp: ${bar.at}`);
  for (const field of ['open', 'high', 'low', 'close'] as const) {
    if (!Number.isFinite(bar[field]) || bar[field] <= 0) throw new Error(`invalid bar ${field}: ${bar[field]}`);
  }
  if (bar.low > bar.high || bar.open < bar.low || bar.open > bar.high ||
      bar.close < bar.low || bar.close > bar.high) {
    throw new Error(`incoherent OHLC bar at ${bar.at}`);
  }
}

function stopExitPrice(target: DecisionTarget, quantity: number, bar: ReferenceBar): number | null {
  const wantedKind = quantity > 0 ? 'price_below' : 'price_above';
  const invalidation = target.invalidation.find(
    (item): item is Extract<DecisionInvalidation, { kind: 'price_below' | 'price_above' }> =>
      item.kind === wantedKind,
  );
  if (!invalidation) return null;
  const trigger = Number(invalidation.value);
  if (!Number.isFinite(trigger) || trigger <= 0) throw new Error(`invalid stop trigger for ${target.instrument}`);
  if (quantity > 0 && bar.low <= trigger) return Math.min(trigger, bar.open);
  if (quantity < 0 && bar.high >= trigger) return Math.max(trigger, bar.open);
  return null;
}

function maxDrawdown(values: readonly number[]): number {
  let peak = values[0] ?? 0;
  let result = 0;
  for (const value of values) {
    if (value > peak) peak = value;
    if (peak > 0) result = Math.max(result, (peak - value) / peak);
  }
  return result;
}

function rawDatasetId(manifest: unknown): string {
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) return '(malformed)';
  const datasetId = (manifest as Record<string, unknown>)['datasetId'];
  return typeof datasetId === 'string' && datasetId !== '' ? datasetId : '(malformed)';
}

function derivedLeakageIdentities(manifest: StewardDataManifest): string[] {
  return [...new Set([
    ...manifest.split.leakageGroups.map((group) => `declared:${group}`),
    `content-ref:${manifest.content.ref}`,
    `content-sha256:${manifest.content.sha256}`,
    `source:${manifest.source.provider}|${manifest.source.dataset}|${manifest.source.rawSymbol}`,
    `universe:${manifest.universe.sourceRef}`,
    `sampling-plan-ref:${manifest.sampling.plan.ref}`,
    `sampling-plan-sha256:${manifest.sampling.plan.sha256}`,
    ...manifest.decisionCutoffs.flatMap((cutoff) => [
      `decision-snapshot-ref:${cutoff.snapshot.ref}`,
      `decision-snapshot-sha256:${cutoff.snapshot.sha256}`,
    ]),
    ...manifest.corporateActions.map((action) => `corporate-action:${action.ref}`),
    ...manifest.publications.items.map((item) => `publication:${item.ref}`),
  ])];
}

function expandedRangesOverlap(left: StewardDataManifest, right: StewardDataManifest): boolean {
  const leftStart = Date.parse(left.split.inputStart) - left.split.embargoMs;
  const leftEnd = Date.parse(left.split.outcomeEnd) + left.split.embargoMs;
  const rightStart = Date.parse(right.split.inputStart) - right.split.embargoMs;
  const rightEnd = Date.parse(right.split.outcomeEnd) + right.split.embargoMs;
  return leftStart < rightEnd && rightStart < leftEnd;
}

function round(value: number): number {
  return Number(value.toFixed(12));
}

function bytes(value: string | Uint8Array): Uint8Array {
  return typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
}

function bytesEqual(left: string | Uint8Array, right: string | Uint8Array): boolean {
  return Buffer.from(bytes(left)).equals(Buffer.from(bytes(right)));
}

export function sha256Bytes(value: string | Uint8Array): string {
  return createHash('sha256').update(bytes(value)).digest('hex');
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function sha256Canonical(value: unknown): string {
  return sha256Bytes(canonicalJson(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object' && value !== null) {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = canonicalize(source[key]);
    return out;
  }
  return value;
}
