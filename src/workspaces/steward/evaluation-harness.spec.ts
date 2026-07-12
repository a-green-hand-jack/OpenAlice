import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { sha256StewardEvaluationContent, type StewardEvaluationDataManifest } from './evaluation-data-manifest.js';
import { evaluateStewardWake, type StewardWakeEvaluationInput } from './evaluation-harness.js';
import {
  createStewardEvaluationProvenanceStore,
  type StewardEvaluationProvenanceStore,
} from './evaluation-provenance-store.js';

const CONTENTS: Record<string, string> = {
  snapshot: 'snapshot',
  dataset: 'dataset',
  market: 'market',
  portfolio: 'portfolio',
  risk: 'risk',
  events: 'events',
  history: 'history',
  universe: 'universe',
  sampling: 'sampling',
};

const identity = (ref: string) => ({ ref, sha256: sha256StewardEvaluationContent(CONTENTS[ref]!) });

function dataManifest(): StewardEvaluationDataManifest {
  const source = (ref: string) => ({
    required: true,
    provided: true,
    items: [{
      ...identity(ref),
      observedAt: '2026-01-02T00:00:00.000Z',
      availableAt: '2026-01-02T00:05:00.000Z',
    }],
    note: null,
  });
  return {
    schema: 'steward-eval-data-manifest/1',
    version: 1,
    wakeId: 'wake-eval',
    datasetId: 'dataset-eval',
    asOf: '2026-01-03T00:00:00.000Z',
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
    adjustment: {
      mode: 'unadjusted',
      corporateActionRefs: [],
    },
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
    split: {
      name: 'dev',
      identity: 'split:dev:evaluation',
      leakageGroups: ['family:evaluation'],
      inputStart: '2026-01-01T00:00:00.000Z',
      decisionStart: '2026-01-02T00:00:00.000Z',
      decisionEnd: '2026-01-04T00:00:00.000Z',
      outcomeEnd: '2026-01-05T00:00:00.000Z',
      embargoMs: 0,
    },
  };
}

function input(): StewardWakeEvaluationInput {
  return {
    schema: 'steward-wake-evaluation-input/1',
    version: 1,
    wakeId: 'wake-eval',
    protocol: {
      wakeDelivered: true,
      ledgerValidated: true,
      finalizeMatched: true,
      lockIntegrity: true,
      recoveryIntegrity: 'not_required',
    },
    decision: {
      contractValid: true,
      qualityChecks: [
        { id: 'as_of_reasoning', passed: true, detail: 'intent uses only as-of evidence' },
        { id: 'risk_match', passed: true, detail: 'intent matches declared risk' },
      ],
    },
    execution: {
      requested: true,
      riskEnvelopeValid: true,
      fidelityChecks: [
        { id: 'sizing', passed: true, detail: 'deterministic sizing matched' },
        { id: 'reconciliation', passed: true, detail: 'execution record reconciled' },
      ],
      containment: [],
    },
    dataManifest: dataManifest(),
  };
}

async function withProvenanceStore<T>(
  candidate: StewardWakeEvaluationInput,
  run: (store: StewardEvaluationProvenanceStore) => Promise<T>,
): Promise<T> {
  const workspace = await mkdtemp(join(tmpdir(), 'openalice-steward-evaluation-'));
  const store = createStewardEvaluationProvenanceStore(workspace);
  try {
    for (const [ref, content] of Object.entries(CONTENTS)) {
      await store.publishContent(ref, content);
    }
    await store.publishManifest(
      candidate.wakeId,
      `${JSON.stringify(candidate.dataManifest, null, 2)}\n`,
    );
    return await run(store);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

describe('steward three-layer evaluation harness', () => {
  it('reports protocol, decision, and execution independently with one layer per outcome', async () => {
    const candidate = input();
    await withProvenanceStore(candidate, async (store) => {
      const report = await evaluateStewardWake(candidate, store);
      expect(report.protocol.verdict).toBe('pass');
      expect(report.decision.verdict).toBe('pass');
      expect(report.execution.verdict).toBe('pass');
      expect(report.outcomes.length).toBeGreaterThan(0);
      expect(report.outcomes.every((outcome) =>
        ['protocol', 'decision', 'execution'].filter((layer) => layer === outcome.layer).length === 1,
      )).toBe(true);
      expect(report.protocol.outcomes.every((outcome) => outcome.layer === 'protocol')).toBe(true);
      expect(report.decision.outcomes.every((outcome) => outcome.layer === 'decision')).toBe(true);
      expect(report.execution.outcomes.every((outcome) => outcome.layer === 'execution')).toBe(true);
    });
  });

  it('closes downstream gates when protocol reliability fails', async () => {
    const candidate = input();
    candidate.protocol.finalizeMatched = false;
    await withProvenanceStore(candidate, async (store) => {
      const report = await evaluateStewardWake(candidate, store);
      expect(report.protocol).toMatchObject({ verdict: 'fail', gate: 'closed', gateReason: 'protocol_failed' });
      expect(report.decision).toMatchObject({ verdict: 'not_evaluated', gate: 'closed', gateReason: 'protocol_failed' });
      expect(report.execution).toMatchObject({ verdict: 'not_evaluated', gate: 'closed', gateReason: 'protocol_failed' });
      expect(report.decision.outcomes.every((outcome) => outcome.status === 'not_evaluated')).toBe(true);
    });
  });

  it('never converts a dangerous decision into success because a guard contained it', async () => {
    const candidate = input();
    candidate.decision.qualityChecks[0] = {
      id: 'as_of_reasoning',
      passed: false,
      detail: 'intent used invalid evidence',
    };
    candidate.execution.containment = [{
      code: 'policy_denied',
      detail: 'deterministic guard refused the dangerous intent',
    }];
    await withProvenanceStore(candidate, async (store) => {
      const report = await evaluateStewardWake(candidate, store);
      expect(report.decision.verdict).toBe('fail');
      expect(report.execution.containment).toEqual([
        expect.objectContaining({
          layer: 'execution',
          classification: 'containment',
          status: 'observed',
          code: 'containment:policy_denied',
        }),
      ]);
      expect(report.decision.outcomes.some((outcome) => outcome.classification === 'containment')).toBe(false);
    });
  });

  it('fails decision provenance while leaving execution fidelity mechanically separate', async () => {
    const candidate = input();
    const manifest = candidate.dataManifest as StewardEvaluationDataManifest;
    manifest.sources.market.items[0] = {
      ...manifest.sources.market.items[0]!,
      availableAt: '2026-01-04T00:00:00.000Z',
    };
    candidate.decision.qualityChecks[0] = {
      id: 'as_of_reasoning',
      passed: false,
      detail: 'bad decision evidence',
    };
    await withProvenanceStore(candidate, async (store) => {
      const report = await evaluateStewardWake(candidate, store);
      expect(report.decision.verdict).toBe('fail');
      expect(report.decision.manifest.violations).toContainEqual(
        expect.objectContaining({ code: 'future_source_availability' }),
      );
      expect(report.execution.verdict).toBe('pass');
    });
  });

  it('refuses caller relabelling after the launcher persisted the wake manifest', async () => {
    const candidate = input();
    await withProvenanceStore(candidate, async (store) => {
      const manifest = candidate.dataManifest as StewardEvaluationDataManifest;
      manifest.snapshot = {
        ref: manifest.snapshot.ref,
        sha256: sha256StewardEvaluationContent('caller-substitute'),
      };
      await expect(evaluateStewardWake(candidate, store)).rejects.toMatchObject({
        code: 'manifest_binding_mismatch',
      });
      const persisted = await store.loadManifest(candidate.wakeId);
      expect(Buffer.from(persisted.contentByRef['snapshot']!)).toEqual(Buffer.from('snapshot'));
    });
  });

  it('does not score execution without a valid mandatory risk envelope', async () => {
    const candidate = input();
    candidate.execution.riskEnvelopeValid = false;
    candidate.execution.containment = [{
      code: 'risk_envelope_missing',
      detail: 'execution was refused fail-closed',
    }];
    await withProvenanceStore(candidate, async (store) => {
      const report = await evaluateStewardWake(candidate, store);
      expect(report.execution).toMatchObject({
        verdict: 'not_evaluated',
        gate: 'closed',
        gateReason: 'risk_envelope_invalid',
      });
      expect(report.decision.verdict).toBe('pass');
    });
  });

  it('fails closed on malformed or duplicate layer evidence', async () => {
    const candidate = input();
    candidate.decision.qualityChecks.push(candidate.decision.qualityChecks[0]!);
    await withProvenanceStore(candidate, async (store) => {
      await expect(evaluateStewardWake(candidate, store)).rejects.toThrow(/duplicate check id/);
    });
  });
});
