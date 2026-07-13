import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  D4_SMOKE_CANDIDATES,
  D4_SMOKE_CREDENTIAL_SOURCES,
  D4_SMOKE_INSTRUCTION_REF,
  D4_SMOKE_MARKETS,
  D4_SMOKE_PROFILES,
  D4_SMOKE_REPETITIONS,
  D4_SMOKE_RUNTIME_POLICY_REF,
  buildD4SmokeStageManifest,
  canonicalD4SmokeEmbeddedBytes,
  d4SmokeCandidateDecisionSnapshot,
  d4SmokeDecisionWindow,
  d4SmokeWakeIdPlaceholder,
  computeD4SmokeRuntimeTreeIdentity,
  type D4SmokeCandidateCell,
  type D4SmokeCriticReceipt,
  type D4SmokeStageManifest,
  type D4SmokeStageManifestArtifact,
  type D4SmokeGitVerifier,
  type D4SmokeStageManifestContent,
} from './d4-smoke-stage-manifest.js';

export const D4_SMOKE_TEST_REVIEWED_COMMIT = 'deadbee';
export const D4_SMOKE_TEST_GIT_VERIFIER: D4SmokeGitVerifier = async () => ({
  head: 'feedfacefeedfacefeedfacefeedfacefeedface',
  reviewedCommitIsAncestor: true,
  reviewedManifestMatches: true,
  headManifestMatches: true,
  reviewedRuntimeTreeMatches: true,
  headRuntimeTreeMatches: true,
  worktreeRuntimeTreeMatches: true,
});

const SYMBOLS: Readonly<Record<typeof D4_SMOKE_MARKETS[number], string>> = {
  'crypto-major': 'BTC-USD',
  'us-index-etf': 'SPY',
  'us-single': 'NVDA',
  'gcn-equity': '600519.SS',
  fx: 'EURUSD',
  'commodity-proxy': 'GLD',
};

const D4_TEST_REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const D4_TEST_RUNTIME_TREE = computeD4SmokeRuntimeTreeIdentity({ repoRoot: D4_TEST_REPO_ROOT });

function quotaCodexSnapshot(general: number, spark: number): unknown {
  const bucket = (limitId: string, usedPercent: number) => ({
    limitId,
    primary: { usedPercent, windowDurationMins: 10_080, resetsAt: 1_800_000_000 },
    secondary: null,
    credits: { hasCredits: false, unlimited: false, balance: '0' },
    individualLimit: null,
    planType: 'pro',
  });
  return {
    rateLimitsByLimitId: {
      codex: bucket('codex', general),
      codex_bengalfox: bucket('codex_bengalfox', spark),
    },
    rateLimitResetCredits: { availableCount: 0, credits: [] },
  };
}

function quotaClaudeSnapshot(allModel: number, fable: number, current: number): unknown {
  return {
    session: { total_cost_usd: 0, total_api_duration_ms: 0, model_usage: {} },
    subscription_type: 'max',
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: current, resets_at: '2026-07-14T00:00:00.000Z' },
      seven_day: { utilization: allModel, resets_at: '2026-07-20T00:00:00.000Z' },
      model_scoped: [{
        display_name: 'Fable',
        utilization: fable,
        resets_at: '2026-07-20T00:00:00.000Z',
      }],
      extra_usage: {
        is_enabled: false,
        monthly_limit: null,
        used_credits: null,
        utilization: null,
      },
      spend: {
        enabled: false,
        used: { amount_minor: 0 },
        can_purchase_credits: false,
      },
    },
  };
}

export interface D4SmokeFixture {
  readonly manifest: D4SmokeStageManifest;
  readonly manifestBytes: Uint8Array;
  readonly manifestSha256: string;
  readonly receipt: D4SmokeCriticReceipt;
  readonly contentByRef: Record<string, string>;
}

export async function createD4SmokeTestFixture(): Promise<D4SmokeFixture> {
  const contentByRef: Record<string, string> = {
    [D4_SMOKE_INSTRUCTION_REF]: await readFile(
      new URL('../templates/steward/files/instruction.md', import.meta.url),
      'utf8',
    ),
    [D4_SMOKE_RUNTIME_POLICY_REF]: await readFile(
      new URL('../templates/steward/files/d4-smoke-runtime-policy.md', import.meta.url),
      'utf8',
    ),
  };
  const samplingPlanRef = 'd4/dev/sampling-plan.json';
  const samplingPlanBytes = `${JSON.stringify({
    schema: 'steward-d4-sampling-plan/1',
    version: 1,
    frozenAt: '2026-07-13T00:00:00.000Z',
    split: 'dev',
    window: 'a',
  }, null, 2)}\n`;
  contentByRef[samplingPlanRef] = samplingPlanBytes;
  const samplingPlan = {
    ref: samplingPlanRef,
    sha256: createHash('sha256').update(samplingPlanBytes).digest('hex'),
  };
  const quotaObservations = [];
  for (const [index, provider] of (['codex', 'claude'] as const).entries()) {
    const observationId = `quota-observation-${provider}`;
    const beforeCapturedAt = `2026-07-${String(10 + index).padStart(2, '0')}T10:00:00.000Z`;
    const afterCapturedAt = `2026-07-${String(10 + index).padStart(2, '0')}T11:00:00.000Z`;
    const refs = {
      before: `d4/dev/quota/${observationId}/before.json`,
      after: `d4/dev/quota/${observationId}/after.json`,
    };
    const payload = provider === 'codex'
      ? `${JSON.stringify(quotaCodexSnapshot(10, 5), null, 2)}\n`
      : `${JSON.stringify(quotaClaudeSnapshot(20, 30, 10), null, 2)}\n`;
    const payloads = { before: payload, after: payload };
    for (const key of Object.keys(refs) as Array<keyof typeof refs>) {
      contentByRef[refs[key]] = payloads[key];
    }
    const identity = (key: keyof typeof refs) => ({
      ref: refs[key],
      sha256: createHash('sha256').update(payloads[key]).digest('hex'),
    });
    quotaObservations.push({
      id: observationId,
      provider,
      charges: provider === 'codex'
        ? [
            { id: 'codex-general-weekly', chargedTurnCount: 4, resolutionPercent: 1 },
            { id: 'codex-spark', chargedTurnCount: 1, resolutionPercent: 1 },
          ]
        : [
            { id: 'claude-all-model-weekly', chargedTurnCount: 4, resolutionPercent: 1 },
            { id: 'claude-fable-weekly', chargedTurnCount: 1, resolutionPercent: 1 },
            { id: 'claude-current-short', chargedTurnCount: 4, resolutionPercent: 1 },
          ],
      before: {
        capturedAt: beforeCapturedAt,
        raw: identity('before'),
      },
      after: {
        capturedAt: afterCapturedAt,
        raw: identity('after'),
      },
    });
  }
  const quotaForecastRef = 'd4/dev/quota-forecast-observations.json';
  const quotaForecastBytes = `${JSON.stringify({
    schema: 'steward-d4-quota-forecast-observations/1',
    version: 1,
    sourceIdentity: 'native-subscription-controls',
    observations: quotaObservations,
  }, null, 2)}\n`;
  contentByRef[quotaForecastRef] = quotaForecastBytes;
  const cells: D4SmokeStageManifestContent['cells'] = [];
  for (const [marketIndex, market] of D4_SMOKE_MARKETS.entries()) {
    for (const profile of ['bull', 'bear'] as const) {
      const id = `d4-${market}-${profile}-a`;
      const spec = D4_SMOKE_PROFILES[profile];
      const instrument = {
        provider: 'fixture-public',
        symbol: SYMBOLS[market],
        datasetName: `${spec.barInterval}-ohlcv-anonymized`,
        assetClass: market,
        timezone: 'UTC',
        exchangeCalendar: market === 'fx' ? '24/5' : 'fixture-calendar',
        providerAdjustmentMode: 'native_unadjusted',
        candidateAdjustmentMode: 'unadjusted_split_invariant_rebase',
        d3AdjustmentMode: 'unadjusted' as const,
      };
      const intervalMs = profile === 'bull' ? 86_400_000 : 14_400_000;
      const sourceAsOfs = Array.from({ length: spec.totalBars }, (_, index) =>
        new Date(Date.UTC(2025, 0, 1) + index * intervalMs).toISOString());
      const bars = Array.from({ length: spec.totalBars }, (_, index) => ({
        index,
        open: 100 + index,
        high: 101 + index,
        low: 99 + index,
        close: 100.5 + index,
        volume: 1_000 + index,
      }));
      const decisions = Array.from({ length: 12 }, (_, decisionIndex) => {
        const window = d4SmokeDecisionWindow(profile, decisionIndex);
        return {
          ordinal: decisionIndex + 1,
          visibleStart: window.visibleStart,
          visibleEndExclusive: window.visibleEndExclusive,
          visibleBarCount: window.visibleEndExclusive,
          asOfBarIndex: window.asOfBarIndex,
        };
      });
      const candidate: D4SmokeCandidateCell = {
        schema: 'steward-d4-candidate-cell/1',
        version: 1,
        cellId: id,
        split: 'dev',
        window: 'a',
        profile,
        codename: `INSTRUMENT-${String(marketIndex + 1).padStart(2, '0')}`,
        interval: spec.barInterval,
        decisions,
        bars,
      };
      const candidateBytes = `${JSON.stringify(candidate, null, 2)}\n`;
      const candidateRef = `d4/dev/candidate/${id}.json`;
      contentByRef[candidateRef] = candidateBytes;
      const candidateIdentity = {
        ref: candidateRef,
        sha256: createHash('sha256').update(candidateBytes).digest('hex'),
      };
      const universeEvidence = {
        cellId: id,
        selectionBasis: 'point_in_time',
        source: 'fixture-public',
      };
      const universeBytes = canonicalD4SmokeEmbeddedBytes(universeEvidence);
      const universeIdentity = {
        ref: `d4/dev/audit/${id}.json#universe`,
        sha256: createHash('sha256').update(universeBytes).digest('hex'),
      };
      const first = d4SmokeDecisionWindow(profile, 0);
      const final = d4SmokeDecisionWindow(profile, 11);
      const decisionManifests = decisions.map((decision, decisionIndex) => {
        const snapshotBytes = canonicalD4SmokeEmbeddedBytes(
          d4SmokeCandidateDecisionSnapshot(candidate, decisionIndex),
        );
        const snapshot = {
          ref: `d4-snapshot:dev:${createHash('sha256').update(id).digest('hex').slice(0, 16)}:decision-${String(decision.ordinal).padStart(2, '0')}`,
          sha256: createHash('sha256').update(snapshotBytes).digest('hex'),
        };
        const asOf = sourceAsOfs[decision.asOfBarIndex]!;
        const unavailable = (note: string) => ({
          required: false,
          provided: false,
          items: [],
          note,
        });
        return {
          schema: 'steward-eval-data-manifest/1' as const,
          version: 1 as const,
          wakeId: d4SmokeWakeIdPlaceholder(decisionIndex),
          datasetId: id,
          asOf,
          snapshot,
          dataset: {
            provider: instrument.provider,
            name: instrument.datasetName,
            rawSymbol: instrument.symbol,
            assetClass: instrument.assetClass,
            timezone: instrument.timezone,
            exchangeCalendar: instrument.exchangeCalendar,
            content: snapshot,
          },
          adjustment: { mode: 'unadjusted' as const, corporateActionRefs: [] },
          sources: {
            market: {
              required: true,
              provided: true,
              items: [{ ...snapshot, observedAt: asOf, availableAt: asOf }],
              note: null,
            },
            portfolio: unavailable('Synthetic proposal-only identity has no portfolio source.'),
            risk: unavailable('Synthetic proposal-only identity has no executable risk source.'),
            events: unavailable('Frozen fixture has no event stream.'),
            history: unavailable('Runtime supplies only within-execution decision history.'),
          },
          publications: [],
          corporateActions: [],
          universe: {
            selectionBasis: 'point_in_time' as const,
            membershipAsOf: sourceAsOfs[0]!,
            effectiveFrom: sourceAsOfs[0]!,
            effectiveTo: null,
            source: universeIdentity,
          },
          sampling: {
            kind: 'regime_labeled' as const,
            frozenAt: '2026-07-13T00:00:00.000Z',
            plan: samplingPlan,
          },
          audit: {
            manifestCreatedAt: '2026-07-13T00:00:00.000Z',
            evaluationStartedAt: '2026-07-13T00:00:00.000Z',
          },
          split: {
            name: 'dev' as const,
            identity: `split:dev:${id}`,
            leakageGroups: [`fixture:${market}`],
            inputStart: sourceAsOfs[0]!,
            decisionStart: sourceAsOfs[first.asOfBarIndex]!,
            decisionEnd: sourceAsOfs[final.asOfBarIndex]!,
            outcomeEnd: sourceAsOfs.at(-1)!,
            embargoMs: intervalMs,
          },
        };
      });
      const selectedRaw = {
        ref: `remote:${id}:selected`,
        sha256: createHash('sha256').update(`raw:${id}`).digest('hex'),
        canonicalByteLength: spec.totalBars * 100,
        barCount: spec.totalBars,
      };
      const selectedDerived = {
        ref: `derived:${id}:selected`,
        sha256: createHash('sha256').update(`derived:${id}`).digest('hex'),
        canonicalByteLength: spec.totalBars * 80,
        barCount: spec.totalBars,
      };
      const sourceReceipt = { selectedRaw, selectedDerived };
      const splitEvidence = { actions: [] };
      const audit = {
        schema: 'steward-d4-cell-audit/1',
        version: 1,
        cellId: id,
        split: 'dev',
        sourceReceipt,
        universeEvidence,
        splitEvidence,
        decisionManifests,
      };
      const auditBytes = `${JSON.stringify(audit, null, 2)}\n`;
      const auditRef = `d4/dev/audit/${id}.json`;
      contentByRef[auditRef] = auditBytes;
      cells.push({
        id,
        market,
        profile,
        window: 'a',
        split: 'dev',
        stratum: `${market}:${profile}`,
        pairingKey: id,
        temporal: { ...spec },
        instrument,
        asOf: {
          decisionStart: sourceAsOfs[first.asOfBarIndex]!,
          decisionEnd: sourceAsOfs[final.asOfBarIndex]!,
          outcomeEnd: sourceAsOfs.at(-1)!,
        },
        evidence: {
          candidatePayload: candidateIdentity,
          audit: {
            ref: auditRef,
            sha256: createHash('sha256').update(auditBytes).digest('hex'),
          },
          sourceReceipt: {
            ref: `${auditRef}#source-receipt`,
            sha256: createHash('sha256').update(canonicalD4SmokeEmbeddedBytes(sourceReceipt)).digest('hex'),
          },
          splitEvidence: {
            ref: `${auditRef}#split-evidence`,
            sha256: createHash('sha256').update(canonicalD4SmokeEmbeddedBytes(splitEvidence)).digest('hex'),
          },
          samplingPlan,
          selectedRaw,
          selectedDerived,
        },
      });
    }
  }
  const artifact = buildD4SmokeStageManifest({
    authorization: 'AUTH-D4-DEV',
    stage: 'Smoke',
    split: 'dev',
    baseline: {
      commit: 'c8071ebf',
      behaviorVersion: 'v9-RUNTIME',
      instruction: {
        ref: D4_SMOKE_INSTRUCTION_REF,
        sha256: '2b76a194634015914807b8e6591fd72f00bf50647c8c57c665eec7c021a5803c',
      },
      runtimePolicy: {
        ref: D4_SMOKE_RUNTIME_POLICY_REF,
        sha256: 'c46f434f813e59b4ba9979c95f5769fac49aca83361023e28b8143e0bf701de7',
      },
      quotaForecastEvidence: {
        ref: quotaForecastRef,
        sha256: createHash('sha256').update(quotaForecastBytes).digest('hex'),
      },
      runtimeTree: await D4_TEST_RUNTIME_TREE,
    },
    proposalOnly: {
      authzLevel: 'read_only',
      accountId: 'eval:d4-smoke:proposal-only',
      configuredUta: false,
      outputs: ['decision_intent', 'information_snapshot'],
      forbiddenCapabilities: [
        'account_create',
        'account_edit',
        'account_elevate',
        'uta_mutation',
        'execution_record_publish',
        'stage',
        'auto_push',
      ],
    },
    credentialSources: D4_SMOKE_CREDENTIAL_SOURCES,
    candidates: D4_SMOKE_CANDIDATES,
    repetitions: D4_SMOKE_REPETITIONS,
    cells,
  });
  return {
    manifest: artifact.manifest,
    manifestBytes: artifact.bytes,
    manifestSha256: artifact.sha256,
    receipt: approveD4SmokeTestManifest(artifact),
    contentByRef,
  };
}

export function approveD4SmokeTestManifest(
  artifact: Pick<D4SmokeStageManifestArtifact, 'sha256'>,
): D4SmokeCriticReceipt {
  return {
    schema: 'steward-d4-critic-receipt/1',
    version: 1,
    manifestSha256: artifact.sha256,
    reviewerIdentity: 'critic:independent-safety',
    verdict: 'APPROVE',
    reviewedCommit: D4_SMOKE_TEST_REVIEWED_COMMIT,
  };
}
