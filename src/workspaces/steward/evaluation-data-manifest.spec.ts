import { describe, expect, it } from 'vitest';

import {
  sha256StewardEvaluationContent,
  validateStewardEvaluationDataManifest,
  validateStewardEvaluationManifestSet,
  type StewardEvaluationDataManifest,
} from './evaluation-data-manifest.js';

const SOURCE_TEST_CATEGORIES = ['market', 'portfolio', 'risk', 'events', 'history'] as const;

const CONTENTS: Record<string, string> = {
  'fixture:snapshot': 'snapshot-v1',
  'fixture:dataset': 'dataset-v1',
  'fixture:market': 'market-v1',
  'fixture:portfolio': 'portfolio-v1',
  'fixture:risk': 'risk-v1',
  'fixture:events': 'events-v1',
  'fixture:history': 'history-v1',
  'fixture:publication': 'publication-v1',
  'fixture:action': 'action-v1',
  'fixture:universe': 'universe-v1',
  'fixture:sampling': 'sampling-v1',
  'fixture:dataset-validation': 'dataset-validation-v1',
  'fixture:universe-validation': 'universe-validation-v1',
  'fixture:sampling-validation': 'sampling-validation-v1',
};

function identity(ref: string): { ref: string; sha256: string } {
  const content = CONTENTS[ref];
  if (content === undefined) throw new Error(`missing fixture content: ${ref}`);
  return { ref, sha256: sha256StewardEvaluationContent(content) };
}

function manifest(): StewardEvaluationDataManifest {
  const source = (ref: string) => ({
    required: true,
    provided: true,
    items: [{
      ...identity(ref),
      observedAt: '2026-01-04T10:00:00.000Z',
      availableAt: '2026-01-04T10:05:00.000Z',
    }],
    note: null,
  });
  return {
    schema: 'steward-eval-data-manifest/1',
    version: 1,
    wakeId: 'wake-1',
    datasetId: 'dataset-dev',
    asOf: '2026-01-05T00:00:00.000Z',
    snapshot: identity('fixture:snapshot'),
    dataset: {
      provider: 'fixture',
      name: 'historical-bars',
      rawSymbol: 'ASSET-A',
      assetClass: 'equity',
      timezone: 'America/New_York',
      exchangeCalendar: 'XNYS',
      content: identity('fixture:dataset'),
    },
    adjustment: {
      mode: 'adjusted',
      corporateActionRefs: ['fixture:action'],
    },
    sources: {
      market: source('fixture:market'),
      portfolio: source('fixture:portfolio'),
      risk: source('fixture:risk'),
      events: source('fixture:events'),
      history: source('fixture:history'),
    },
    publications: [{
      ...identity('fixture:publication'),
      kind: 'report',
      eventAt: '2026-01-03T00:00:00.000Z',
      publishedAt: '2026-01-04T00:00:00.000Z',
    }],
    corporateActions: [{
      ...identity('fixture:action'),
      kind: 'split',
      announcedAt: '2025-12-01T00:00:00.000Z',
      effectiveAt: '2026-01-02T00:00:00.000Z',
      appliedToData: true,
    }],
    universe: {
      selectionBasis: 'point_in_time',
      membershipAsOf: '2025-12-31T00:00:00.000Z',
      effectiveFrom: '2020-01-01T00:00:00.000Z',
      effectiveTo: null,
      source: identity('fixture:universe'),
    },
    sampling: {
      kind: 'continuous_walk_forward',
      frozenAt: '2026-07-01T00:00:00.000Z',
      plan: identity('fixture:sampling'),
    },
    audit: {
      manifestCreatedAt: '2026-07-02T00:00:00.000Z',
      evaluationStartedAt: '2026-07-03T00:00:00.000Z',
    },
    split: {
      name: 'dev',
      identity: 'split:dev:a',
      leakageGroups: ['family:equity-a'],
      inputStart: '2026-01-01T00:00:00.000Z',
      decisionStart: '2026-01-02T00:00:00.000Z',
      decisionEnd: '2026-01-10T00:00:00.000Z',
      outcomeEnd: '2026-01-15T00:00:00.000Z',
      embargoMs: 86_400_000,
    },
  };
}

describe('steward evaluation data manifest', () => {
  it('accepts a versioned per-wake manifest with complete hashed provenance', () => {
    expect(validateStewardEvaluationDataManifest(manifest(), CONTENTS, 'wake-1')).toMatchObject({
      valid: true,
      violations: [],
      manifest: { schema: 'steward-eval-data-manifest/1', version: 1, wakeId: 'wake-1' },
    });
  });

  it('fails closed on a future source observation or availability timestamp', () => {
    const candidate = manifest();
    candidate.sources.market.items[0] = {
      ...candidate.sources.market.items[0],
      observedAt: '2026-01-06T00:00:00.000Z',
      availableAt: '2026-01-07T00:00:00.000Z',
    };
    expect(validateStewardEvaluationDataManifest(candidate, CONTENTS).violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'future_source_observation' }),
        expect.objectContaining({ code: 'future_source_availability' }),
      ]),
    );
  });

  it('rejects missing hashes, missing referenced bytes, and wake identity mismatch', () => {
    const malformed = structuredClone(manifest()) as unknown as Record<string, unknown>;
    const snapshot = malformed['snapshot'] as Record<string, unknown>;
    delete snapshot['sha256'];
    expect(validateStewardEvaluationDataManifest(malformed, CONTENTS).violations).toContainEqual(
      expect.objectContaining({ code: 'manifest_shape_invalid', detail: expect.stringContaining('snapshot.sha256') }),
    );

    const missing = manifest();
    missing.sources.risk.items[0] = {
      ...missing.sources.risk.items[0],
      ref: 'fixture:missing-risk',
    };
    expect(validateStewardEvaluationDataManifest(missing, CONTENTS, 'another-wake').violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'content_missing' }),
        expect.objectContaining({ code: 'wake_id_mismatch' }),
      ]),
    );
  });

  it('enforces publication lag without rejecting a previously announced future scheduled event', () => {
    const futureReport = manifest();
    futureReport.publications[0] = {
      ...futureReport.publications[0],
      eventAt: '2026-01-08T00:00:00.000Z',
      publishedAt: '2026-01-07T00:00:00.000Z',
    };
    expect(validateStewardEvaluationDataManifest(futureReport, CONTENTS).violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'publication_chronology_invalid' }),
        expect.objectContaining({ code: 'future_publication' }),
      ]),
    );

    const scheduled = manifest();
    scheduled.publications[0] = {
      ...scheduled.publications[0],
      kind: 'scheduled_event',
      eventAt: '2026-01-08T00:00:00.000Z',
      publishedAt: '2026-01-04T00:00:00.000Z',
    };
    expect(validateStewardEvaluationDataManifest(scheduled, CONTENTS).valid).toBe(true);
  });

  it('rejects corporate-action data adjusted with a future-effective action', () => {
    const candidate = manifest();
    candidate.corporateActions[0] = {
      ...candidate.corporateActions[0],
      effectiveAt: '2026-01-06T00:00:00.000Z',
    };
    expect(validateStewardEvaluationDataManifest(candidate, CONTENTS).violations).toContainEqual(
      expect.objectContaining({ code: 'corporate_action_future_leak' }),
    );

    const unlinked = manifest();
    unlinked.adjustment.corporateActionRefs = ['fixture:unrecorded-action'];
    expect(validateStewardEvaluationDataManifest(unlinked, CONTENTS).violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'corporate_action_reference_missing' }),
        expect.objectContaining({ code: 'corporate_action_reference_inconsistent' }),
      ]),
    );
  });

  it('requires point-in-time universe membership valid at the wake cutoff', () => {
    const candidate = manifest();
    candidate.universe = {
      ...candidate.universe,
      selectionBasis: 'current_members',
      membershipAsOf: '2026-07-01T00:00:00.000Z',
      effectiveTo: '2026-01-04T00:00:00.000Z',
    };
    expect(validateStewardEvaluationDataManifest(candidate, CONTENTS).violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'survivorship_bias' }),
        expect.objectContaining({ code: 'future_universe_membership' }),
        expect.objectContaining({ code: 'outside_universe_membership' }),
      ]),
    );
  });

  it('fails closed when a required source is explicitly unavailable', () => {
    const candidate = manifest();
    candidate.sources.portfolio = {
      required: true,
      provided: false,
      items: [],
      note: 'portfolio source unavailable',
    };
    expect(validateStewardEvaluationDataManifest(candidate, CONTENTS).violations).toContainEqual(
      expect.objectContaining({ code: 'required_source_unavailable', detail: 'portfolio' }),
    );
  });

  it('rejects a sampling plan frozen after evaluation starts', () => {
    const candidate = manifest();
    candidate.sampling.frozenAt = '2026-07-04T00:00:00.000Z';
    expect(validateStewardEvaluationDataManifest(candidate, CONTENTS).violations).toContainEqual(
      expect.objectContaining({ code: 'sampling_audit_order_invalid' }),
    );
  });

  it('detects shared-identity split leakage after embargo expansion', () => {
    const dev = manifest();
    const validation = manifest();
    validation.wakeId = 'wake-validation-1';
    validation.datasetId = 'dataset-validation';
    validation.asOf = '2026-01-18T00:00:00.000Z';
    validation.dataset = {
      ...validation.dataset,
      rawSymbol: 'ASSET-B',
      content: identity('fixture:dataset-validation'),
    };
    validation.sources = Object.fromEntries(Object.entries(validation.sources).map(([key, value]) => [
      key,
      {
        ...value,
        items: value.items.map((item) => ({
          ...item,
          observedAt: '2026-01-17T00:00:00.000Z',
          availableAt: '2026-01-17T00:05:00.000Z',
        })),
      },
    ])) as StewardEvaluationDataManifest['sources'];
    validation.split = {
      ...validation.split,
      name: 'validation',
      identity: 'split:validation:b',
      inputStart: '2026-01-16T00:00:00.000Z',
      decisionStart: '2026-01-17T00:00:00.000Z',
      decisionEnd: '2026-01-20T00:00:00.000Z',
      outcomeEnd: '2026-01-25T00:00:00.000Z',
    };

    const proof = validateStewardEvaluationManifestSet([dev, validation], CONTENTS);
    expect(proof.valid).toBe(false);
    expect(proof.violations).toContainEqual(expect.objectContaining({ code: 'split_embargo_overlap' }));
    expect(proof.overlaps[0]?.identities).toContain('declared:family:equity-a');
    expect(proof.overlaps[0]?.identities).toEqual(expect.arrayContaining([
      `snapshot-ref:${dev.snapshot.ref}`,
      `snapshot-sha256:${dev.snapshot.sha256}`,
      ...SOURCE_TEST_CATEGORIES.flatMap((category) => [
        `source-${category}-ref:${dev.sources[category].items[0]!.ref}`,
        `source-${category}-sha256:${dev.sources[category].items[0]!.sha256}`,
      ]),
      `publication-ref:${dev.publications[0]!.ref}`,
      `publication-sha256:${dev.publications[0]!.sha256}`,
      `corporate-action-ref:${dev.corporateActions[0]!.ref}`,
      `corporate-action-sha256:${dev.corporateActions[0]!.sha256}`,
    ]));
  });

  it('rejects overlapping relabeled evidence across snapshots, all source slices, publications, and corporate actions', () => {
    const dev = manifest();
    const validation = manifest();
    const contents = { ...CONTENTS };
    const relabel = (current: { ref: string; sha256: string }, ref: string) => {
      contents[ref] = CONTENTS[current.ref]!;
      return { ...current, ref };
    };

    validation.wakeId = 'wake-validation-relabelled';
    validation.datasetId = 'dataset-validation-relabelled';
    validation.asOf = '2026-01-18T00:00:00.000Z';
    validation.snapshot = relabel(validation.snapshot, 'validation:snapshot-alias');
    validation.dataset = {
      ...validation.dataset,
      provider: 'validation-provider',
      name: 'validation-bars',
      rawSymbol: 'ASSET-B',
      content: identity('fixture:dataset-validation'),
    };
    validation.sources = Object.fromEntries(SOURCE_TEST_CATEGORIES.map((category) => [
      category,
      {
        ...validation.sources[category],
        items: validation.sources[category].items.map((item, index) => ({
          ...relabel(item, `validation:${category}:${index}`),
          observedAt: '2026-01-17T00:00:00.000Z',
          availableAt: '2026-01-17T00:05:00.000Z',
        })),
      },
    ])) as StewardEvaluationDataManifest['sources'];
    validation.publications = validation.publications.map((publication, index) => ({
      ...relabel(publication, `validation:publication:${index}`),
      kind: publication.kind,
      eventAt: publication.eventAt,
      publishedAt: publication.publishedAt,
    }));
    validation.corporateActions = validation.corporateActions.map((action, index) => ({
      ...relabel(action, `validation:corporate-action:${index}`),
      kind: action.kind,
      announcedAt: action.announcedAt,
      effectiveAt: action.effectiveAt,
      appliedToData: action.appliedToData,
    }));
    validation.adjustment.corporateActionRefs = validation.corporateActions.map((action) => action.ref);
    validation.universe.source = identity('fixture:universe-validation');
    validation.sampling.plan = identity('fixture:sampling-validation');
    validation.split = {
      ...validation.split,
      name: 'validation',
      identity: 'split:validation:relabelled',
      leakageGroups: ['family:validation-only'],
      inputStart: '2026-01-16T00:00:00.000Z',
      decisionStart: '2026-01-17T00:00:00.000Z',
      decisionEnd: '2026-01-20T00:00:00.000Z',
      outcomeEnd: '2026-01-25T00:00:00.000Z',
    };

    const proof = validateStewardEvaluationManifestSet([dev, validation], contents);
    expect(proof.valid).toBe(false);
    expect(proof.violations).toContainEqual(expect.objectContaining({ code: 'split_embargo_overlap' }));
    expect(proof.overlaps[0]?.identities).toEqual(expect.arrayContaining([
      `snapshot-sha256:${dev.snapshot.sha256}`,
      ...SOURCE_TEST_CATEGORIES.map((category) =>
        `source-${category}-sha256:${dev.sources[category].items[0]!.sha256}`),
      `publication-sha256:${dev.publications[0]!.sha256}`,
      `corporate-action-sha256:${dev.corporateActions[0]!.sha256}`,
    ]));
    expect(proof.overlaps[0]?.identities.some((item) => item.endsWith('-ref:fixture:snapshot'))).toBe(false);
  });

  it('allows multiple wakes to share one stable split identity but rejects conflicting reuse', () => {
    const first = manifest();
    const second = manifest();
    second.wakeId = 'wake-2';
    second.asOf = '2026-01-06T00:00:00.000Z';
    expect(validateStewardEvaluationManifestSet([first, second], CONTENTS)).toMatchObject({
      valid: true,
      violations: [],
    });

    second.split = { ...second.split, outcomeEnd: '2026-01-16T00:00:00.000Z' };
    expect(validateStewardEvaluationManifestSet([first, second], CONTENTS).violations).toContainEqual(
      expect.objectContaining({ code: 'split_identity_conflict' }),
    );
  });

  it('returns shape violations rather than throwing on malformed input', () => {
    expect(() => validateStewardEvaluationDataManifest({ version: 99 }, CONTENTS)).not.toThrow();
    expect(validateStewardEvaluationDataManifest({ version: 99 }, CONTENTS)).toMatchObject({
      valid: false,
      manifest: null,
      violations: expect.arrayContaining([
        expect.objectContaining({ code: 'manifest_shape_invalid' }),
      ]),
    });
  });
});
