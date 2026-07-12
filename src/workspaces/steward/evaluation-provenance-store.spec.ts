import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  sha256StewardEvaluationContent,
  type StewardEvaluationDataManifest,
} from './evaluation-data-manifest.js';
import {
  createStewardEvaluationProvenanceStore,
  type StewardEvaluationProvenanceStore,
} from './evaluation-provenance-store.js';

const CONTENT_KEYS = [
  'snapshot',
  'dataset',
  'market',
  'portfolio',
  'risk',
  'events',
  'history',
  'universe',
  'sampling',
] as const;

interface Fixture {
  readonly manifest: StewardEvaluationDataManifest;
  readonly contents: Readonly<Record<string, string>>;
}

let workspace: string;
let store: StewardEvaluationProvenanceStore;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'openalice-steward-provenance-'));
  store = createStewardEvaluationProvenanceStore(workspace);
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe('Steward evaluation provenance store', () => {
  it('publishes exact content bytes by sha256 and survives restart with idempotent retry', async () => {
    const callerBytes = new Uint8Array([0, 1, 2, 255]);
    const expected = new Uint8Array(callerBytes);
    const publication = store.publishContent('fixture:binary', callerBytes);
    callerBytes.fill(9);

    const identity = await publication;
    expect(identity).toEqual({
      ref: 'fixture:binary',
      sha256: sha256StewardEvaluationContent(expected),
    });
    expect(await store.readContent(identity)).toEqual(expected);
    expect(await readFile(store.objectPath(identity.sha256))).toEqual(Buffer.from(expected));

    const restarted = createStewardEvaluationProvenanceStore(workspace);
    await expect(restarted.publishContent(identity.ref, expected)).resolves.toEqual(identity);
    expect(await restarted.readContent(identity)).toEqual(expected);
  });

  it('refuses a different byte payload for an already-bound logical ref', async () => {
    const identity = await store.publishContent('fixture:stable', 'first-bytes');
    await expect(store.publishContent('fixture:stable', 'first-bytes')).resolves.toEqual(identity);
    await expect(store.publishContent('fixture:stable', 'different-bytes')).rejects.toMatchObject({
      code: 'content_ref_conflict',
    });
    expect(Buffer.from(await store.readContent(identity)).toString('utf8')).toBe('first-bytes');
  });

  it('persists exact strict manifest bytes, binds the wake path, and rejects path conflicts', async () => {
    const fixture = makeFixture({ prefix: 'dev:', wakeId: 'wake-dev', splitName: 'dev' });
    await publishFixtureContents(store, fixture);
    const manifestBytes = `${JSON.stringify(fixture.manifest, null, 2)}\n`;

    const published = await store.publishManifest('wake-dev', manifestBytes);
    expect(Buffer.from(published.bytes).toString('utf8')).toBe(manifestBytes);
    const restarted = createStewardEvaluationProvenanceStore(workspace);
    const loaded = await restarted.loadManifest('wake-dev');
    expect(Buffer.from(loaded.bytes).toString('utf8')).toBe(manifestBytes);
    expect(loaded.manifest).toEqual(fixture.manifest);
    await expect(restarted.publishManifest('wake-dev', manifestBytes)).resolves.toMatchObject({
      manifest: { wakeId: 'wake-dev' },
    });

    await expect(restarted.publishManifest(
      'wake-dev',
      `${JSON.stringify(fixture.manifest)}\n`,
    )).rejects.toMatchObject({ code: 'manifest_conflict' });
    await expect(restarted.publishManifest('wake-other', manifestBytes)).rejects.toMatchObject({
      code: 'manifest_wake_mismatch',
    });
  });

  it('fails closed on missing content and malformed persisted ref records', async () => {
    await expect(store.loadManifest('wake-absent')).rejects.toMatchObject({
      code: 'manifest_missing',
    });
    const fixture = makeFixture({ prefix: 'missing:', wakeId: 'wake-missing', splitName: 'dev' });
    for (const [ref, content] of Object.entries(fixture.contents)) {
      if (ref !== 'missing:risk') await store.publishContent(ref, content);
    }
    await expect(store.publishManifest(
      fixture.manifest.wakeId,
      `${JSON.stringify(fixture.manifest)}\n`,
    )).rejects.toMatchObject({ code: 'content_ref_missing' });

    const riskIdentity = await store.publishContent('missing:risk', fixture.contents['missing:risk']!);
    await writeFile(store.refPath(riskIdentity.ref), '{not-json', 'utf8');
    await expect(store.readContent(riskIdentity)).rejects.toMatchObject({
      code: 'content_record_corrupt',
    });
  });

  it('fails closed on corrupt blobs and malformed persisted manifests', async () => {
    const fixture = makeFixture({ prefix: 'corrupt:', wakeId: 'wake-corrupt', splitName: 'dev' });
    await publishFixtureContents(store, fixture);
    await store.publishManifest(
      fixture.manifest.wakeId,
      `${JSON.stringify(fixture.manifest, null, 2)}\n`,
    );

    const datasetIdentity = fixture.manifest.dataset.content;
    await writeFile(store.objectPath(datasetIdentity.sha256), 'tampered-bytes', 'utf8');
    await expect(store.loadManifest(fixture.manifest.wakeId)).rejects.toMatchObject({
      code: 'content_hash_mismatch',
    });

    await writeFile(store.manifestPath(fixture.manifest.wakeId), '{bad-json', 'utf8');
    await expect(store.loadManifest(fixture.manifest.wakeId)).rejects.toMatchObject({
      code: 'manifest_corrupt',
    });
  });

  it('anchors split duplication and embargo leakage to store-resolved content identities', async () => {
    const dev = makeFixture({
      prefix: 'dev:',
      wakeId: 'wake-dev',
      splitName: 'dev',
      datasetBytes: 'shared-dataset-bytes',
    });
    const validation = makeFixture({
      prefix: 'validation:',
      wakeId: 'wake-validation',
      splitName: 'validation',
      datasetBytes: 'shared-dataset-bytes',
    });
    await publishFixtureContents(store, dev);
    await publishFixtureContents(store, validation);
    await store.publishManifest('wake-dev', `${JSON.stringify(dev.manifest)}\n`);
    await store.publishManifest('wake-validation', `${JSON.stringify(validation.manifest)}\n`);

    const result = await createStewardEvaluationProvenanceStore(workspace)
      .validateManifestSet(['wake-dev', 'wake-validation']);
    expect(result.valid).toBe(false);
    expect(result.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'duplicate_content_across_splits' }),
      expect.objectContaining({ code: 'split_embargo_overlap' }),
    ]));
    expect(result.overlaps[0]?.identities).toContain(
      `dataset-content-sha256:${dev.manifest.dataset.content.sha256}`,
    );
  });
});

async function publishFixtureContents(
  target: StewardEvaluationProvenanceStore,
  fixture: Fixture,
): Promise<void> {
  for (const [ref, content] of Object.entries(fixture.contents)) {
    await target.publishContent(ref, content);
  }
}

function makeFixture(input: {
  readonly prefix: string;
  readonly wakeId: string;
  readonly splitName: 'dev' | 'validation';
  readonly datasetBytes?: string;
}): Fixture {
  const contents = Object.fromEntries(CONTENT_KEYS.map((key) => [
    `${input.prefix}${key}`,
    key === 'dataset' && input.datasetBytes !== undefined
      ? input.datasetBytes
      : `${input.prefix}${key}-bytes`,
  ]));
  const identity = (key: typeof CONTENT_KEYS[number]) => {
    const ref = `${input.prefix}${key}`;
    return { ref, sha256: sha256StewardEvaluationContent(contents[ref]!) };
  };
  const source = (key: 'market' | 'portfolio' | 'risk' | 'events' | 'history') => ({
    required: true,
    provided: true,
    items: [{
      ...identity(key),
      observedAt: '2026-01-02T00:00:00.000Z',
      availableAt: '2026-01-02T00:05:00.000Z',
    }],
    note: null,
  });
  const validation = input.splitName === 'validation';
  const manifest: StewardEvaluationDataManifest = {
    schema: 'steward-eval-data-manifest/1',
    version: 1,
    wakeId: input.wakeId,
    datasetId: `dataset-${input.splitName}`,
    asOf: validation ? '2026-01-06T00:00:00.000Z' : '2026-01-03T00:00:00.000Z',
    snapshot: identity('snapshot'),
    dataset: {
      provider: 'fixture',
      name: 'bars',
      rawSymbol: 'ASSET-A',
      assetClass: 'equity',
      timezone: 'UTC',
      exchangeCalendar: '24x7',
      content: identity('dataset'),
    },
    adjustment: { mode: 'unadjusted', corporateActionRefs: [] },
    sources: {
      market: source('market'),
      portfolio: source('portfolio'),
      risk: source('risk'),
      events: source('events'),
      history: source('history'),
    },
    publications: [],
    corporateActions: [],
    universe: {
      selectionBasis: 'point_in_time',
      membershipAsOf: '2026-01-01T00:00:00.000Z',
      effectiveFrom: '2020-01-01T00:00:00.000Z',
      effectiveTo: null,
      source: identity('universe'),
    },
    sampling: {
      kind: 'continuous_walk_forward',
      frozenAt: '2026-07-01T00:00:00.000Z',
      plan: identity('sampling'),
    },
    audit: {
      manifestCreatedAt: '2026-07-02T00:00:00.000Z',
      evaluationStartedAt: '2026-07-03T00:00:00.000Z',
    },
    split: validation ? {
      name: 'validation',
      identity: 'split:validation:1',
      leakageGroups: ['family:validation'],
      inputStart: '2026-01-05T00:00:00.000Z',
      decisionStart: '2026-01-06T00:00:00.000Z',
      decisionEnd: '2026-01-07T00:00:00.000Z',
      outcomeEnd: '2026-01-08T00:00:00.000Z',
      embargoMs: 172_800_000,
    } : {
      name: 'dev',
      identity: 'split:dev:1',
      leakageGroups: ['family:dev'],
      inputStart: '2026-01-01T00:00:00.000Z',
      decisionStart: '2026-01-02T00:00:00.000Z',
      decisionEnd: '2026-01-04T00:00:00.000Z',
      outcomeEnd: '2026-01-05T00:00:00.000Z',
      embargoMs: 86_400_000,
    },
  };
  return { manifest, contents };
}
