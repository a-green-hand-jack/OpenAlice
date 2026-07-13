import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  aggregateFourHourBars,
  anonymizeBars,
  canonicalBarsBytes,
  d4CanonicalRoster,
  d4DecisionSlices,
  d4ProfileTotalBars,
  decisionSnapshotBytes,
  reverseFutureSplitAdjustments,
  sha256,
  stableJson,
  D4_PROFILES,
} from '../tools/campaigns/d4-smoke-data.mjs';
import {
  D4_SMOKE_CANDIDATES,
  D4_SMOKE_CREDENTIAL_SOURCES,
  D4_SMOKE_INSTRUCTION_REF,
  D4_SMOKE_PROFILES,
  D4_SMOKE_REPETITIONS,
  D4_SMOKE_RUNTIME_POLICY_REF,
  d4SmokeStageManifestSchema,
  d4SmokeWakeIdPlaceholder,
  validateD4SmokeStage,
} from '../src/workspaces/steward/d4-smoke-stage-manifest.js';
import {
  deriveD4SmokeQuotaForecastBounds,
} from '../src/workspaces/steward/d4-smoke-runner.js';
import {
  validateStewardEvaluationDataManifest,
} from '../src/workspaces/steward/evaluation-data-manifest.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_ROOT = resolve(REPO_ROOT, 'tools/campaigns/data/d4-smoke-dev-a');
const STAGE_PATH = resolve(PACKAGE_ROOT, 'stage-manifest.json');

function fixtureBar(hour: number, values: readonly number[]) {
  const timestamp = Date.UTC(2026, 0, 1, hour);
  return {
    timestamp: new Date(timestamp).toISOString(),
    availableAt: new Date(timestamp + 60 * 60 * 1000).toISOString(),
    open: values[0],
    high: values[1],
    low: values[2],
    close: values[3],
    volume: values[4],
  };
}

function readJson(path: string) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function repoPath(ref: string) {
  return resolve(REPO_ROOT, ref);
}

function stageContentByRef() {
  const stage = d4SmokeStageManifestSchema.parse(readJson(STAGE_PATH));
  const contentByRef: Record<string, Uint8Array> = {};
  const bind = (ref: string) => { contentByRef[ref] = readFileSync(repoPath(ref)); };
  bind(stage.content.baseline.instruction.ref);
  bind(stage.content.baseline.runtimePolicy.ref);
  bind(stage.content.baseline.quotaForecastEvidence.ref);
  const quota = readJson(repoPath(stage.content.baseline.quotaForecastEvidence.ref));
  for (const observation of quota.observations) {
    bind(observation.before.raw.ref);
    bind(observation.after.raw.ref);
  }
  for (const cell of stage.content.cells) {
    bind(cell.evidence.candidatePayload.ref);
    bind(cell.evidence.audit.ref);
    bind(cell.evidence.samplingPlan.ref);
  }
  return contentByRef;
}

describe('D4 Smoke deterministic transforms', () => {
  it('aggregates only complete chronological four-hour buckets with a golden identity', () => {
    const hourly = [
      fixtureBar(0, [10, 12, 9, 11, 5]),
      fixtureBar(1, [11, 13, 10, 12, 6]),
      fixtureBar(2, [12, 14, 11, 13, 7]),
      fixtureBar(3, [13, 15, 12, 14, 8]),
      fixtureBar(4, [14, 16, 13, 15, 9]),
      fixtureBar(5, [15, 17, 14, 16, 10]),
      fixtureBar(6, [16, 18, 15, 17, 11]),
      fixtureBar(7, [17, 19, 16, 18, 12]),
    ];

    const derived = aggregateFourHourBars(hourly);
    expect(derived).toEqual([
      {
        timestamp: '2026-01-01T00:00:00.000Z',
        availableAt: '2026-01-01T04:00:00.000Z',
        open: 10,
        high: 15,
        low: 9,
        close: 14,
        volume: 26,
        sourceTimestamps: [
          '2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z',
          '2026-01-01T02:00:00.000Z', '2026-01-01T03:00:00.000Z',
        ],
      },
      {
        timestamp: '2026-01-01T04:00:00.000Z',
        availableAt: '2026-01-01T08:00:00.000Z',
        open: 14,
        high: 19,
        low: 13,
        close: 18,
        volume: 42,
        sourceTimestamps: [
          '2026-01-01T04:00:00.000Z', '2026-01-01T05:00:00.000Z',
          '2026-01-01T06:00:00.000Z', '2026-01-01T07:00:00.000Z',
        ],
      },
    ]);
    expect(sha256(canonicalBarsBytes(derived))).toBe('73ecd17768d53c8e50d76cb4ae495a9ef63d47d141ed64a0f0c2abf309e446c3');

    const withGap = hourly.filter((bar) => bar.timestamp !== '2026-01-01T06:00:00.000Z');
    expect(aggregateFourHourBars(withGap)).toHaveLength(1);
    expect(() => aggregateFourHourBars([...hourly].reverse())).toThrow('strictly chronological');
  });

  it('rebases daily OHLCV without retaining price or volume scale', () => {
    const daily = [
      fixtureBar(0, [40, 44, 36, 40, 200]),
      fixtureBar(1, [44, 52, 42, 50, 300]),
      fixtureBar(2, [50, 51, 38, 40, 100]),
    ];
    expect(anonymizeBars(daily)).toEqual([
      { index: 0, open: 100, high: 110, low: 90, close: 100, volume: 100 },
      { index: 1, open: 110, high: 130, low: 105, close: 125, volume: 150 },
      { index: 2, open: 125, high: 127.5, low: 95, close: 100, volume: 50 },
    ]);
    expect(sha256(`${stableJson(anonymizeBars(daily))}\n`)).toBe('b5a338be90ab6212c2867b1825c4b000ab4b29edb94fe8ceb882056f5884969d');
  });

  it('makes a not-yet-effective 10:1 provider split factor byte-invariant', () => {
    const providerAdjusted = [
      {
        timestamp: '2023-01-03T14:30:00.000Z', availableAt: '2023-01-04T14:30:00.000Z',
        open: 10, high: 11, low: 9, close: 10, volume: 1_000,
      },
      {
        timestamp: '2023-01-04T14:30:00.000Z', availableAt: '2023-01-05T14:30:00.000Z',
        open: 10, high: 13, low: 10, close: 12, volume: 1_500,
      },
    ];
    const deadjusted = reverseFutureSplitAdjustments(providerAdjusted, [{
      effectiveAt: '2024-06-10T13:30:00.000Z', numerator: 10, denominator: 1,
    }], '2023-01-05T14:30:00.000Z');
    expect(deadjusted[0]).toMatchObject({ open: 100, high: 110, low: 90, close: 100, volume: 100 });
    expect(`${stableJson(anonymizeBars(deadjusted))}\n`)
      .toBe(`${stableJson(anonymizeBars(providerAdjusted))}\n`);
  });
});

describe('checked-in D4 Smoke dev package', () => {
  const manifest = d4SmokeStageManifestSchema.parse(readJson(STAGE_PATH));
  const content = manifest.content;

  it('freezes exactly 12 unique cells in canonical order without a closed-split identity', () => {
    expect(content.cells).toHaveLength(12);
    expect(content.cells.map((cell) => cell.id)).toEqual(d4CanonicalRoster().map((item) => item.cellId));
    expect(new Set(content.cells.map((cell) => cell.id)).size).toBe(12);
    expect(content.candidates).toEqual(D4_SMOKE_CANDIDATES);
    expect(content.credentialSources).toEqual(D4_SMOKE_CREDENTIAL_SOURCES);
    expect(content.repetitions).toEqual(D4_SMOKE_REPETITIONS);

    const packageFiles = [
      'README.md',
      'stage-manifest.json',
      'stage-manifest.sha256',
      'sampling-plan.json',
      ...readdirSync(resolve(PACKAGE_ROOT, 'quota')).map((name) => `quota/${name}`),
      ...readdirSync(resolve(PACKAGE_ROOT, 'candidate')).map((name) => `candidate/${name}`),
      ...readdirSync(resolve(PACKAGE_ROOT, 'audit')).map((name) => `audit/${name}`),
    ];
    const closedSplitToken = ['hold', 'out'].join('');
    for (const file of packageFiles) {
      expect(file.toLowerCase()).not.toContain(closedSplitToken);
      expect(readFileSync(resolve(PACKAGE_ROOT, file), 'utf8').toLowerCase()).not.toContain(closedSplitToken);
    }
  });

  it('binds every checked-in file, embedded receipt, and frozen raw/derived byte receipt', () => {
    const stageBytes = readFileSync(STAGE_PATH);
    expect(sha256(readFileSync(repoPath(content.baseline.instruction.ref))))
      .toBe(content.baseline.instruction.sha256);
    expect(sha256(readFileSync(repoPath(content.baseline.runtimePolicy.ref))))
      .toBe(content.baseline.runtimePolicy.sha256);
    expect(content.baseline.instruction.ref).toBe(D4_SMOKE_INSTRUCTION_REF);
    expect(content.baseline.runtimePolicy.ref).toBe(D4_SMOKE_RUNTIME_POLICY_REF);
    expect(readFileSync(resolve(PACKAGE_ROOT, 'stage-manifest.sha256'), 'utf8'))
      .toBe(`${sha256(stageBytes)}  stage-manifest.json\n`);

    for (const cell of content.cells) {
      const auditBytes = readFileSync(repoPath(cell.evidence.audit.ref));
      const candidateBytes = readFileSync(repoPath(cell.evidence.candidatePayload.ref));
      const samplingBytes = readFileSync(repoPath(cell.evidence.samplingPlan.ref));
      expect(sha256(auditBytes)).toBe(cell.evidence.audit.sha256);
      expect(sha256(candidateBytes)).toBe(cell.evidence.candidatePayload.sha256);
      expect(sha256(samplingBytes)).toBe(cell.evidence.samplingPlan.sha256);

      const audit = JSON.parse(auditBytes.toString('utf8'));
      expect(sha256(`${stableJson(audit.sourceReceipt)}\n`)).toBe(cell.evidence.sourceReceipt.sha256);
      expect(sha256(`${stableJson(audit.splitEvidence)}\n`)).toBe(cell.evidence.splitEvidence.sha256);
      expect(audit.sourceReceipt.splitEvidence).toEqual(cell.evidence.splitEvidence);
      expect(audit.sourceReceipt.providerAdjustmentMode).toBe(cell.instrument.providerAdjustmentMode);
      expect(audit.sourceReceipt.candidateAdjustmentMode).toBe('unadjusted_split_invariant_rebase');
      expect(audit.sourceReceipt.futureSplitInvariance).toEqual(audit.futureSplitInvariance);
      for (const action of audit.splitEvidence.actions) {
        expect(sha256(`${stableJson(action.artifact)}\n`)).toBe(action.content.sha256);
      }
      expect(audit.sourceReceipt.selectedRaw).toEqual(cell.evidence.selectedRaw);
      expect(audit.sourceReceipt.selectedDerived).toEqual(cell.evidence.selectedDerived);
      for (const receipt of [audit.sourceReceipt.acquisition, audit.sourceReceipt.derivedPool,
        audit.sourceReceipt.selectedRaw, audit.sourceReceipt.selectedDerived]) {
        expect(receipt.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(receipt.canonicalByteLength).toBeGreaterThan(0);
        expect(receipt.barCount).toBeGreaterThan(0);
      }
      expect(audit.sourceReceipt.recipe.failClosed).toContain('drift is an error');
      for (const identity of audit.sourceReceipt.recipe.implementation) {
        expect(sha256(readFileSync(repoPath(identity.ref)))).toBe(identity.sha256);
      }
    }
  });

  it('passes the merged stage validator and derives conservative full-layer quota bounds', async () => {
    const manifestBytes = readFileSync(STAGE_PATH);
    const stage = await validateD4SmokeStage({
      manifestBytes,
      receipt: {
        schema: 'steward-d4-critic-receipt/1',
        version: 1,
        manifestSha256: sha256(manifestBytes),
        reviewerIdentity: 'test-only-unapproved-shape-check',
        verdict: 'APPROVE',
        reviewedCommit: 'deadbee',
      },
      repoRoot: REPO_ROOT,
      contentByRef: stageContentByRef(),
      gitVerifier: async () => ({
        head: 'feedface',
        reviewedCommitIsAncestor: true,
        reviewedManifestMatches: true,
        headManifestMatches: true,
        reviewedRuntimeTreeMatches: true,
        headRuntimeTreeMatches: true,
        worktreeRuntimeTreeMatches: true,
      }),
    });
    const bounds = deriveD4SmokeQuotaForecastBounds({ stage, contentByRef: stageContentByRef() });
    expect(bounds['codex-general-weekly'].observedDeltaUpperBoundPercentPerModelTurn).toBe(0.25);
    expect(bounds['codex-spark'].observedDeltaUpperBoundPercentPerModelTurn).toBe(1);
    expect(bounds['claude-all-model-weekly'].observedDeltaUpperBoundPercentPerModelTurn).toBe(0.25);
    expect(bounds['claude-fable-weekly'].observedDeltaUpperBoundPercentPerModelTurn).toBe(1);
    expect(bounds['claude-current-short'].observedDeltaUpperBoundPercentPerModelTurn).toBe(0.25);
    expect(Object.values(bounds).every((bound) =>
      bound.observedDeltaUpperBoundPercentPerModelTurn * bound.applicableModelTurnCount >= 100)).toBe(true);
  });

  it('refuses an accidental rebuild of the immutable checked-in manifest', () => {
    const before = sha256(readFileSync(STAGE_PATH));
    const result = spawnSync('pnpm', [
      'exec', 'tsx', resolve(REPO_ROOT, 'tools/campaigns/build-d4-smoke-data.mjs'),
      '--build',
    ], { cwd: REPO_ROOT, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('refusing to replace the checked-in stage manifest');
    expect(sha256(readFileSync(STAGE_PATH))).toBe(before);
  });

  it('uses exact half-open decision prefixes and keeps the final cadence outcome-only', () => {
    for (const cell of content.cells) {
      const profile = D4_PROFILES[cell.profile as keyof typeof D4_PROFILES];
      const candidate = readJson(repoPath(cell.evidence.candidatePayload.ref));
      const audit = readJson(repoPath(cell.evidence.audit.ref));
      const totalBars = d4ProfileTotalBars(profile);
      const candidateText = JSON.stringify(candidate);
      expect(candidateText).not.toContain(cell.instrument.symbol);
      expect(candidateText).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(candidate).not.toHaveProperty('_provenance');
      expect(candidate.bars[0].close).toBe(100);
      expect(candidate.bars).toHaveLength(totalBars);
      expect(candidate.decisions).toEqual(d4DecisionSlices(profile));
      expect(audit.sourceReceipt.selectedDerived.barCount).toBe(totalBars);
      expect(audit.sourceReceipt.selectedRaw.barCount)
        .toBe(profile.barInterval === '4h' ? totalBars * 4 : totalBars);
      expect(Math.sign(audit.sourceReceipt.selection.logReturn)).toBe(cell.profile === 'bull' ? 1 : -1);

      const finalDecision = candidate.decisions.at(-1)!;
      expect(totalBars - finalDecision.visibleEndExclusive).toBe(profile.cadenceBars);
      const tailIndices = candidate.bars.slice(finalDecision.visibleEndExclusive).map((bar: { index: number }) => bar.index);
      expect(tailIndices).toEqual(Array.from(
        { length: profile.cadenceBars },
        (_, index) => finalDecision.visibleEndExclusive + index,
      ));

      for (const [index, decision] of candidate.decisions.entries()) {
        expect(decision.visibleStart).toBe(0);
        expect(decision.visibleEndExclusive).toBe(profile.lookbackBars + index * profile.cadenceBars);
        expect(decision.asOfBarIndex).toBe(decision.visibleEndExclusive - 1);
        const snapshot = JSON.parse(decisionSnapshotBytes(candidate, decision));
        expect(snapshot).not.toHaveProperty('cellId');
        expect(JSON.stringify(snapshot)).not.toContain(cell.profile);
        expect(snapshot.bars).toEqual(candidate.bars.slice(0, decision.visibleEndExclusive));
        expect(Math.max(...snapshot.bars.map((bar: { index: number }) => bar.index))).toBe(decision.asOfBarIndex);
        expect(snapshot.bars.some((bar: { index: number }) => tailIndices.includes(bar.index))).toBe(false);
      }
    }
  });

  it('proves the NVDA 2024 10:1 future split cannot alter pre-effective snapshots', () => {
    const bullCell = content.cells.find((cell) => cell.id === 'd4-us-single-bull-a')!;
    const bearCell = content.cells.find((cell) => cell.id === 'd4-us-single-bear-a')!;
    const bullAudit = readJson(repoPath(bullCell.evidence.audit.ref));
    const bearAudit = readJson(repoPath(bearCell.evidence.audit.ref));
    const futureSplit = bullAudit.splitEvidence.actions.find((action: { artifact: { splitRatio: string } }) =>
      action.artifact.splitRatio === '10:1');
    expect(futureSplit.artifact.effectiveAt).toBe('2024-06-10T13:30:00.000Z');
    expect(futureSplit.artifact.announcedAt).toBe('2024-05-23T00:00:00.000Z');
    expect(futureSplit.artifact.announcementEvidence).toEqual(expect.objectContaining({
      publisher: 'NVIDIA Newsroom',
      publishedDate: '2024-05-22',
      ref: 'https://nvidianews.nvidia.com/news/nvidia-announces-financial-results-for-first-quarter-fiscal-2025',
    }));
    expect(bullAudit.decisionManifests.every((dataManifest: { asOf: string }) =>
      Date.parse(dataManifest.asOf) < Date.parse(futureSplit.artifact.announcedAt))).toBe(true);
    expect(bullAudit.decisionManifests.every((dataManifest: { corporateActions: Array<{ ref: string }> }) =>
      dataManifest.corporateActions.every((action) => action.ref !== futureSplit.content.ref))).toBe(true);
    expect(bullAudit.futureSplitInvariance).toHaveLength(12);
    for (const proof of bullAudit.futureSplitInvariance) {
      expect(proof.futureSplitRefs).toContain(futureSplit.content.ref);
      expect(proof.providerVisibleBarsSha256).toBe(proof.deadjustedVisibleBarsSha256);
      expect(proof.invariant).toBe(true);
    }

    const bearFutureSplit = bearAudit.splitEvidence.actions.find((action: { artifact: { splitRatio: string } }) =>
      action.artifact.splitRatio === '10:1');
    expect(bearAudit.decisionManifests[0].corporateActions).toContainEqual(
      expect.objectContaining({ ref: bearFutureSplit.content.ref, appliedToData: false }),
    );
  });

  it('validates every per-decision D3 manifest and proves no later bar enters an as-of snapshot', () => {
    const samplingBytes = readFileSync(resolve(PACKAGE_ROOT, 'sampling-plan.json'), 'utf8');
    for (const cell of content.cells) {
      const candidateBytes = readFileSync(repoPath(cell.evidence.candidatePayload.ref), 'utf8');
      const candidate = JSON.parse(candidateBytes);
      const audit = readJson(repoPath(cell.evidence.audit.ref));
      const contentByRef: Record<string, string> = {
        [cell.evidence.candidatePayload.ref]: candidateBytes,
        [cell.evidence.samplingPlan.ref]: samplingBytes,
        [audit.decisionManifests[0].universe.source.ref]: `${stableJson(audit.universeEvidence)}\n`,
      };
      for (const [index, decision] of candidate.decisions.entries()) {
        contentByRef[audit.decisionManifests[index].snapshot.ref] = decisionSnapshotBytes(candidate, decision);
      }
      for (const action of audit.splitEvidence.actions) {
        contentByRef[action.content.ref] = `${stableJson(action.artifact)}\n`;
      }

      const asOfs: number[] = [];
      for (const [index, dataManifest] of audit.decisionManifests.entries()) {
        const candidateSurface = [
          dataManifest.wakeId,
          dataManifest.snapshot.ref,
          contentByRef[dataManifest.snapshot.ref],
        ].join('\n');
        expect(dataManifest.wakeId).toBe(d4SmokeWakeIdPlaceholder(index));
        expect(dataManifest.snapshot.ref).toMatch(/^[0-9a-f]{40}$/);
        for (const semanticToken of [
          cell.id,
          cell.profile,
          cell.market,
          cell.instrument.symbol,
          cell.instrument.provider,
        ]) {
          expect(candidateSurface).not.toContain(semanticToken);
        }
        const validation = validateStewardEvaluationDataManifest(dataManifest, contentByRef, dataManifest.wakeId);
        expect(validation.violations, `${cell.id} decision ${index + 1}`).toEqual([]);
        expect(validation.valid).toBe(true);
        expect(dataManifest.publications).toEqual([]);
        expect(dataManifest.adjustment).toEqual({ mode: 'unadjusted', corporateActionRefs: [] });
        expect(dataManifest.corporateActions.every((action: { effectiveAt: string; appliedToData: boolean }) =>
          Date.parse(action.effectiveAt) <= Date.parse(dataManifest.asOf) && action.appliedToData === false)).toBe(true);
        expect(dataManifest.dataset.content).toEqual(dataManifest.snapshot);
        expect(dataManifest.sources.market.items[0].availableAt).toBe(dataManifest.asOf);
        asOfs.push(Date.parse(dataManifest.asOf));
      }
      expect(asOfs.every((asOf, index) => index === 0 || asOf > asOfs[index - 1])).toBe(true);
      expect(audit.decisionManifests[0].asOf).toBe(cell.asOf.decisionStart);
      expect(audit.decisionManifests.at(-1).asOf).toBe(cell.asOf.decisionEnd);
      expect(Date.parse(cell.asOf.decisionEnd)).toBeLessThan(Date.parse(cell.asOf.outcomeEnd));
      expect(cell.temporal).toEqual(D4_SMOKE_PROFILES[cell.profile]);
    }
  });
});
