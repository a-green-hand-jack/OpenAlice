import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { decisionIntentSchema } from '../../../tools/steward-contract-proof/d2-contracts.js';
import {
  evaluateDecisionReference,
  proveDataManifestSet,
  provePairedOneShot,
  proveStatefulEpisode,
  validateDataManifest,
  type DecisionIntent,
  type DecisionReferenceInput,
  type PairedOneShotEvidence,
  type ReferenceBar,
  type StatefulEpisodeEvidence,
  type StewardDataManifest,
} from '../../../tools/steward-contract-proof/d3-evaluator.js';

const FIXTURE_ROOT = new URL('../../../tools/steward-contract-proof/fixtures/d3/', import.meta.url);

interface EqualityFixture {
  readonly paired: {
    readonly left: PairedOneShotEvidence;
    readonly right: PairedOneShotEvidence;
    readonly semanticButNotByteEqual: PairedOneShotEvidence;
    readonly differentEvaluatorInput: PairedOneShotEvidence;
  };
  readonly stateful: {
    readonly left: StatefulEpisodeEvidence;
    readonly right: StatefulEpisodeEvidence;
    readonly differentTape: StatefulEpisodeEvidence;
    readonly missingWake: StatefulEpisodeEvidence;
    readonly reorderedWakes: StatefulEpisodeEvidence;
  };
}

interface ReferenceFixture {
  readonly decisionAt: string;
  readonly initialEquity: number;
  readonly singleIntent: DecisionIntent;
  readonly portfolioIntent: DecisionIntent;
  readonly shortHorizonIntent: DecisionIntent;
  readonly expiredBeforeEntryIntent: DecisionIntent;
  readonly longHorizonIntent: DecisionIntent;
  readonly tape: DecisionReferenceInput['tape'];
  readonly horizonTape: DecisionReferenceInput['tape'];
  readonly golden: {
    readonly single: unknown;
    readonly portfolio: unknown;
    readonly shortHorizon: unknown;
    readonly expiredBeforeEntry: unknown;
    readonly longHorizon: unknown;
  };
}

interface DataManifestFixture {
  readonly contents: Readonly<Record<string, string>>;
  readonly validManifests: readonly StewardDataManifest[];
  readonly invalidPatches: {
    readonly overlapValidationSplit: Partial<StewardDataManifest['split']>;
    readonly futureCorporateAction: Pick<StewardDataManifest, 'adjustment' | 'corporateActions'>;
    readonly futurePublication: StewardDataManifest['publications'];
    readonly survivorshipUniverse: StewardDataManifest['universe'];
    readonly badContentHash: string;
  };
}

const equality = fixture<EqualityFixture>('equality-cases.json');
const reference = fixture<ReferenceFixture>('reference-policy-cases.json');
const data = fixture<DataManifestFixture>('data-manifest-cases.json');

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => {
    throw new Error('AUTH-CP-D3 proof must not use the network');
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AUTH-CP-D3 input equality proof', () => {
  it('requires byte-identical snapshot and evaluator input for paired one-shot', () => {
    expect(provePairedOneShot(equality.paired.left, equality.paired.right)).toMatchObject({
      mode: 'paired_one_shot',
      valid: true,
      mismatches: [],
    });
  });

  it('rejects semantically equal JSON whose snapshot bytes differ', () => {
    expect(provePairedOneShot(
      equality.paired.left,
      equality.paired.semanticButNotByteEqual,
    )).toMatchObject({
      valid: false,
      mismatches: ['snapshot_bytes'],
    });
  });

  it('rejects a changed evaluator input even when snapshot bytes match', () => {
    expect(provePairedOneShot(
      equality.paired.left,
      equality.paired.differentEvaluatorInput,
    )).toMatchObject({
      valid: false,
      mismatches: ['evaluator_input_bytes'],
    });
  });

  it('permits later model-specific portfolio/history divergence in a stateful episode', () => {
    expect(proveStatefulEpisode(equality.stateful.left, equality.stateful.right)).toEqual({
      mode: 'stateful_episode',
      valid: true,
      basisMismatches: [],
      laterStateDiverged: true,
    });
  });

  it('rejects stateful comparison when an exogenous tape byte changes', () => {
    expect(proveStatefulEpisode(equality.stateful.left, equality.stateful.differentTape)).toEqual({
      mode: 'stateful_episode',
      valid: false,
      basisMismatches: ['external_tape_bytes'],
      laterStateDiverged: false,
    });
  });

  it('treats missing or reordered later wakes as a basis mismatch', () => {
    for (const candidate of [equality.stateful.missingWake, equality.stateful.reorderedWakes]) {
      expect(proveStatefulEpisode(equality.stateful.left, candidate)).toEqual({
        mode: 'stateful_episode',
        valid: false,
        basisMismatches: ['right_later_state_schedule_mismatch'],
        laterStateDiverged: false,
      });
    }
  });

  it('rejects symmetrically empty, duplicated, or reordered chains against the frozen schedule', () => {
    const leftChain = equality.stateful.left.laterStateChain;
    const rightChain = equality.stateful.right.laterStateChain;
    const candidatePairs: Array<[StatefulEpisodeEvidence, StatefulEpisodeEvidence]> = [
      [
        { ...equality.stateful.left, laterStateChain: [] },
        { ...equality.stateful.right, laterStateChain: [] },
      ],
      [
        { ...equality.stateful.left, laterStateChain: [leftChain[0], leftChain[0]] },
        { ...equality.stateful.right, laterStateChain: [rightChain[0], rightChain[0]] },
      ],
      [
        { ...equality.stateful.left, laterStateChain: [leftChain[1], leftChain[0]] },
        { ...equality.stateful.right, laterStateChain: [rightChain[1], rightChain[0]] },
      ],
    ];

    for (const [left, right] of candidatePairs) {
      expect(proveStatefulEpisode(left, right)).toEqual({
        mode: 'stateful_episode',
        valid: false,
        basisMismatches: [
          'left_later_state_schedule_mismatch',
          'right_later_state_schedule_mismatch',
        ],
        laterStateDiverged: false,
      });
    }
  });

  it('fails closed when both candidates carry the same invalid schedule bytes', () => {
    const invalidSchedule = '{"schema":"steward-wake-schedule/1","wakes":"not-a-list"}\n';
    expect(proveStatefulEpisode(
      { ...equality.stateful.left, wakeScheduleBytes: invalidSchedule },
      { ...equality.stateful.right, wakeScheduleBytes: invalidSchedule },
    )).toEqual({
      mode: 'stateful_episode',
      valid: false,
      basisMismatches: ['left_wake_schedule_invalid', 'right_wake_schedule_invalid'],
      laterStateDiverged: false,
    });
  });
});

describe('AUTH-CP-D3 DecisionReferencePolicy proof', () => {
  const singleInput: DecisionReferenceInput = {
    intent: reference.singleIntent,
    decisionAt: reference.decisionAt,
    initialEquity: reference.initialEquity,
    tape: reference.tape,
  };
  const portfolioInput: DecisionReferenceInput = {
    intent: reference.portfolioIntent,
    decisionAt: reference.decisionAt,
    initialEquity: reference.initialEquity,
    tape: reference.tape,
  };

  it('keeps direct D2 schema parity for both single and portfolio fixtures', () => {
    expect(decisionIntentSchema.parse(reference.singleIntent)).toEqual(reference.singleIntent);
    expect(decisionIntentSchema.parse(reference.portfolioIntent)).toEqual(reference.portfolioIntent);
  });

  it('rejects a malformed D2 intent before evaluating other reference inputs', () => {
    const malformed = structuredClone(reference.singleIntent) as unknown as Record<string, unknown>;
    delete malformed['snapshotSha256'];
    expect(() => evaluateDecisionReference({
      ...singleInput,
      intent: malformed,
      decisionAt: 'not-an-iso-timestamp',
    })).toThrow('snapshotSha256');
  });

  it('pins the single-target counterfactual trajectory and gap-stop metrics', () => {
    expect(evaluateDecisionReference(singleInput)).toEqual(reference.golden.single);
  });

  it('pins the portfolio-capable v3 counterfactual trajectory', () => {
    expect(evaluateDecisionReference(portfolioInput)).toEqual(reference.golden.portfolio);
  });

  it('uses the versioned time horizon to produce different deterministic trajectories', () => {
    const short = evaluateDecisionReference({
      intent: reference.shortHorizonIntent,
      decisionAt: reference.decisionAt,
      initialEquity: reference.initialEquity,
      tape: reference.horizonTape,
    });
    const long = evaluateDecisionReference({
      intent: reference.longHorizonIntent,
      decisionAt: reference.decisionAt,
      initialEquity: reference.initialEquity,
      tape: reference.horizonTape,
    });
    expect(short).toEqual(reference.golden.shortHorizon);
    expect(long).toEqual(reference.golden.longHorizon);
    expect(short.trajectoryHash).not.toBe(long.trajectoryHash);
    expect(short.points[1].operations).toContainEqual(expect.objectContaining({ action: 'horizon_exit' }));
  });

  it('does not enter when the intent expires before the first actionable next-open', () => {
    const expired = evaluateDecisionReference({
      intent: reference.expiredBeforeEntryIntent,
      decisionAt: reference.decisionAt,
      initialEquity: reference.initialEquity,
      tape: reference.horizonTape,
    });
    expect(expired).toEqual(reference.golden.expiredBeforeEntry);
    expect(expired.points.flatMap((point) => point.operations)).toEqual([]);
    expect(expired.metrics).toMatchObject({ endEquity: 1000, turnover: 0 });
  });

  it('reports non-price invalidation handling instead of silently ignoring it', () => {
    expect(evaluateDecisionReference(singleInput).nonPriceInvalidations).toEqual([
      expect.objectContaining({ kind: 'time_expiry', handling: 'represented_by_time_horizon' }),
      expect.objectContaining({ kind: 'thesis', handling: 'not_machine_evaluated' }),
    ]);
  });

  it('rejects any reference tape bar at or before the decision cutoff', () => {
    const tape = structuredClone(reference.tape) as Record<string, ReferenceBar[]>;
    const bars = tape['fixture/ASSET-A'];
    if (!bars) throw new Error('fixture tape missing ASSET-A');
    tape['fixture/ASSET-A'] = [{ ...bars[0], at: reference.decisionAt }, ...bars.slice(1)];
    expect(() => evaluateDecisionReference({ ...singleInput, tape })).toThrow(
      'reference tape bar must be strictly after decisionAt',
    );
  });

  it('rejects permissive Date.parse inputs for decisionAt', () => {
    expect(() => evaluateDecisionReference({ ...singleInput, decisionAt: '2026-01-01' })).toThrow(
      'decisionAt must be an ISO timestamp',
    );
  });

  it('cannot improve decision metrics from guard, envelope, sizing, or broker outcomes', () => {
    const observedAllowed = {
      ...singleInput,
      observedExecution: {
        guardOutcome: 'allowed',
        envelopeClippedPct: 30,
        actualQuantity: 3,
        brokerOutcome: 'filled',
      },
    } as unknown as DecisionReferenceInput;
    const observedDenied = {
      ...singleInput,
      observedExecution: {
        guardOutcome: 'policy_denied',
        envelopeClippedPct: 0,
        actualQuantity: 0,
        brokerOutcome: 'not_dispatched',
      },
    } as unknown as DecisionReferenceInput;

    expect(evaluateDecisionReference(observedAllowed)).toEqual(reference.golden.single);
    expect(evaluateDecisionReference(observedDenied)).toEqual(reference.golden.single);
  });

  it('rejects duplicate instruments in a portfolio fixture', () => {
    const portfolio = structuredClone(reference.portfolioIntent);
    if (portfolio.kind !== 'portfolio') throw new Error('fixture must be portfolio');
    const duplicate = {
      ...portfolio,
      targets: [portfolio.targets[0], { ...portfolio.targets[1], instrument: portfolio.targets[0].instrument }],
    };
    expect(() => evaluateDecisionReference({ ...portfolioInput, intent: duplicate })).toThrow(
      'portfolio target instruments must be unique',
    );
  });
});

describe('AUTH-CP-D3 data-manifest and split proof', () => {
  it('accepts strict dev/validation/holdout provenance with continuous walk-forward and delisting evidence', () => {
    expect(proveDataManifestSet(data.validManifests, data.contents)).toEqual({
      valid: true,
      violations: [],
      overlaps: [],
    });
  });

  it('detects dev-validation leakage after embargo expansion', () => {
    const manifests = cloneManifests();
    manifests[1] = {
      ...manifests[1],
      split: { ...manifests[1].split, ...data.invalidPatches.overlapValidationSplit },
      decisionCutoffs: [
        { ...manifests[1].decisionCutoffs[0], asOf: '2026-01-09T00:00:00.000Z' },
        { ...manifests[1].decisionCutoffs[1], asOf: '2026-01-12T00:00:00.000Z' },
      ],
    };
    const proof = proveDataManifestSet(manifests, data.contents);
    expect(proof.valid).toBe(false);
    expect(proof.violations).toContainEqual(expect.objectContaining({ code: 'split_overlap' }));
  });

  it('derives leakage identity when caller-declared groups try to evade overlap detection', () => {
    const manifests = cloneManifests();
    manifests[1] = {
      ...manifests[1],
      source: manifests[0].source,
      split: {
        ...manifests[1].split,
        ...data.invalidPatches.overlapValidationSplit,
        leakageGroups: ['caller-claims-unrelated'],
      },
      decisionCutoffs: [
        { ...manifests[1].decisionCutoffs[0], asOf: '2026-01-09T00:00:00.000Z' },
        { ...manifests[1].decisionCutoffs[1], asOf: '2026-01-12T00:00:00.000Z' },
      ],
    };
    const proof = proveDataManifestSet(manifests, data.contents);
    expect(proof.violations).toContainEqual(expect.objectContaining({ code: 'split_overlap' }));
    expect(proof.overlaps[0]?.leakageGroups).toContain(
      'source:fixture|synthetic-bars|ASSET-A',
    );
  });

  it('rejects duplicate content across splits even when declared groups and dates differ', () => {
    const manifests = cloneManifests();
    manifests[1] = {
      ...manifests[1],
      content: manifests[0].content,
      split: { ...manifests[1].split, leakageGroups: ['caller-claims-unrelated'] },
    };
    expect(proveDataManifestSet(manifests, data.contents).violations).toContainEqual(
      expect.objectContaining({ code: 'duplicate_content_across_splits' }),
    );
  });

  it('rejects a corporate action that was unpublished and ineffective at as-of', () => {
    const manifest = {
      ...structuredClone(data.validManifests[0]),
      ...data.invalidPatches.futureCorporateAction,
    };
    expect(validateDataManifest(manifest, data.contents)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'corporate_action_future_leak' }),
    ]));
  });

  it('rejects an event publication that was unavailable at as-of', () => {
    const manifest = {
      ...structuredClone(data.validManifests[0]),
      publications: data.invalidPatches.futurePublication,
    };
    expect(validateDataManifest(manifest, data.contents)).toContainEqual(
      expect.objectContaining({ code: 'future_publication' }),
    );
  });

  it('allows a published scheduled event whose event time is after the decision cutoff', () => {
    const base = structuredClone(data.validManifests[0]);
    const firstPublication = base.publications.items[0];
    if (!firstPublication) throw new Error('fixture must include one publication');
    const manifest = {
      ...base,
      publications: {
        provided: true,
        items: [{
          ...firstPublication,
          eventAt: '2026-01-04T00:00:00.000Z',
          publishedAt: '2026-01-02T00:00:00.000Z',
          usedAtWakes: [1],
        }],
      },
    };
    expect(validateDataManifest(manifest, data.contents)).toEqual([]);
  });

  it('allows information first available between wakes when it is only used by the later wake', () => {
    const base = structuredClone(data.validManifests[0]);
    const manifest = {
      ...base,
      adjustment: { mode: 'adjusted' as const, corporateActionRefs: ['fixture:action:between-wakes'] },
      publications: {
        provided: true,
        items: [{
          ref: 'fixture:event:between-wakes',
          eventAt: '2026-01-08T00:00:00.000Z',
          publishedAt: '2026-01-04T00:00:00.000Z',
          usedAtWakes: [2],
        }],
      },
      corporateActions: [{
        ref: 'fixture:action:between-wakes',
        kind: 'split' as const,
        effectiveAt: '2026-01-04T00:00:00.000Z',
        publishedAt: '2026-01-04T00:00:00.000Z',
        usedAtWakes: [2],
      }],
    };
    expect(validateDataManifest(manifest, data.contents)).toEqual([]);
  });

  it('rejects missing per-wake decision snapshot evidence', () => {
    const base = structuredClone(data.validManifests[0]);
    const manifest = {
      ...base,
      decisionCutoffs: [
        ...base.decisionCutoffs.slice(0, 1),
        {
          ...base.decisionCutoffs[1],
          snapshot: { ...base.decisionCutoffs[1].snapshot, ref: 'fixture:snapshot:missing' },
        },
      ],
    };
    expect(validateDataManifest(manifest, data.contents)).toContainEqual(
      expect.objectContaining({ code: 'decision_snapshot_missing', detail: expect.stringContaining('wake 2') }),
    );
  });

  it('rejects duplicate or reordered per-wake decision cutoffs', () => {
    const base = structuredClone(data.validManifests[0]);
    const manifest = {
      ...base,
      decisionCutoffs: [base.decisionCutoffs[1], base.decisionCutoffs[0]],
    };
    expect(validateDataManifest(manifest, data.contents)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'decision_cutoff_wake_order_invalid' }),
      expect.objectContaining({ code: 'decision_cutoff_time_order_invalid' }),
    ]));
  });

  it('rejects a silently omitted decision wake ordinal', () => {
    const base = structuredClone(data.validManifests[0]);
    const manifest = {
      ...base,
      decisionCutoffs: [
        base.decisionCutoffs[0],
        { ...base.decisionCutoffs[1], wake: 3 },
      ],
    };
    expect(validateDataManifest(manifest, data.contents)).toContainEqual(
      expect.objectContaining({ code: 'decision_cutoff_wake_order_invalid' }),
    );
  });

  it('rejects a current-members universe as survivorship-biased', () => {
    const manifest = {
      ...structuredClone(data.validManifests[1]),
      universe: data.invalidPatches.survivorshipUniverse,
    };
    expect(validateDataManifest(manifest, data.contents)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'survivorship_bias' }),
      expect.objectContaining({ code: 'future_universe_membership' }),
    ]));
  });

  it('checks point-in-time universe membership at every decision wake', () => {
    const base = structuredClone(data.validManifests[0]);
    const manifest = {
      ...base,
      universe: { ...base.universe, effectiveTo: '2026-01-05T00:00:00.000Z' },
    };
    expect(validateDataManifest(manifest, data.contents)).toContainEqual(
      expect.objectContaining({
        code: 'outside_universe_membership',
        detail: expect.stringContaining('wake 2'),
      }),
    );
  });

  it('rejects raw content whose bytes do not match the manifest hash', () => {
    const base = structuredClone(data.validManifests[0]);
    const manifest = { ...base, content: { ...base.content, sha256: data.invalidPatches.badContentHash } };
    expect(validateDataManifest(manifest, data.contents)).toContainEqual(
      expect.objectContaining({ code: 'content_hash_mismatch' }),
    );
  });

  it('requires strict timezone/calendar identity', () => {
    const manifest = { ...structuredClone(data.validManifests[0]), timezone: '' };
    expect(validateDataManifest(manifest, data.contents)).toContainEqual(
      expect.objectContaining({ code: 'manifest_shape_invalid', detail: expect.stringContaining('timezone') }),
    );
  });

  it('requires source identity and a parseable per-wake cutoff timestamp', () => {
    const base = structuredClone(data.validManifests[0]);
    const manifest = {
      ...base,
      source: { ...base.source, provider: '' },
      decisionCutoffs: [
        { ...base.decisionCutoffs[0], asOf: 'not-a-timestamp' },
        ...base.decisionCutoffs.slice(1),
      ],
    };
    expect(validateDataManifest(manifest, data.contents)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'manifest_shape_invalid', detail: expect.stringContaining('source.provider') }),
      expect.objectContaining({
        code: 'manifest_shape_invalid',
        detail: expect.stringContaining('decisionCutoffs.0.asOf'),
      }),
    ]));
  });

  it('returns shape violations instead of throwing for malformed nested enums and timestamps', () => {
    const malformed = {
      ...structuredClone(data.validManifests[0]),
      adjustment: { mode: 'future_adjusted', corporateActionRefs: 'not-an-array' },
      publications: {
        provided: true,
        items: [{ ref: 'bad-event', eventAt: 'not-a-time', publishedAt: 42, usedAtWakes: ['first'] }],
      },
      delisting: { status: 'vanished', handling: 'magic', delistedAt: 'yesterday' },
    };
    expect(() => validateDataManifest(malformed, data.contents)).not.toThrow();
    const violations = validateDataManifest(malformed, data.contents);
    expect(violations.length).toBeGreaterThan(3);
    expect(violations.every((violation) => violation.code === 'manifest_shape_invalid')).toBe(true);
  });

  it('allows a historical market window to be preregistered today without backdating', () => {
    const base = structuredClone(data.validManifests[0]);
    expect(Date.parse(base.sampling.frozenAt)).toBeGreaterThan(Date.parse(base.split.outcomeEnd));
    expect(validateDataManifest(base, data.contents)).toEqual([]);
  });

  it('rejects a sampling plan frozen after the audited evaluation start', () => {
    const base = structuredClone(data.validManifests[0]);
    const manifest = {
      ...base,
      sampling: { ...base.sampling, frozenAt: '2026-07-12T10:00:00.000Z' },
    };
    expect(validateDataManifest(manifest, data.contents)).toContainEqual(
      expect.objectContaining({ code: 'sampling_audit_order_invalid' }),
    );
  });

  it('requires at least one audit-frozen continuous walk-forward sample', () => {
    const manifests = cloneManifests().map((manifest) => ({
      ...manifest,
      sampling: { ...manifest.sampling, kind: 'regime_labeled' as const },
    }));
    expect(proveDataManifestSet(manifests, data.contents).violations).toContainEqual(
      expect.objectContaining({ code: 'continuous_walk_forward_missing' }),
    );
  });
});

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(name, FIXTURE_ROOT), 'utf8')) as T;
}

function cloneManifests(): StewardDataManifest[] {
  return structuredClone(data.validManifests) as StewardDataManifest[];
}
