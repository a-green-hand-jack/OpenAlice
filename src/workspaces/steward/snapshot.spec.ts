import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  canonicalDecisionFingerprint,
  canonicalInformationSnapshotHash,
  parseStewardDecisionLedgerEntry,
  parseStewardDecisionLedgerEntryLenient,
  publishStewardInformationSnapshot,
  stewardDecisionLedgerEntryV3Schema,
  stewardInformationSnapshotSchema,
  stewardLedgerPath,
  stewardSnapshotPath,
  stewardWakeEnvelopeReadSchema,
  StewardSnapshotConflictError,
  validateStewardDecisionSnapshotBinding,
  validateStewardSnapshotTemporalIntegrity,
  validateStewardThesisDispositionCoverage,
} from './index.js';

const fixtureDir = fileURLToPath(new URL('../../../tools/steward-contract-proof/fixtures/d2/', import.meta.url));

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'steward-snapshot-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function fixture<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(join(fixtureDir, name), 'utf8')) as T;
}

function historyEntry(input: {
  wakeId: string;
  at: string;
  decision?: 'no_trade' | 'propose_change';
  instrument?: string;
  dispositions?: Array<{
    wakeId: string;
    instrument: string;
    disposition: 'supersede' | 'invalidate' | 'expire' | 'keep';
    note: string;
  }>;
}): Record<string, unknown> {
  const decision = input.decision ?? 'no_trade';
  const instrument = input.instrument ?? 'mock-simulator-1/ASSET-A';
  return {
    version: 3,
    wakeId: input.wakeId,
    at: input.at,
    accountId: 'mock-simulator-1',
    decision,
    status: 'done',
    completion: { reason: 'done', evidenceRefs: [`wake:${input.wakeId}`] },
    checklist: { account: 'ok', positions: 'ok', orders: 'ok', risk: 'ok', market: 'ok', history: 'ok' },
    thesis: 'structured lifecycle fixture',
    actions: [],
    pendingHash: null,
    invalidation: 'fixture invalidation',
    cost: {
      model: null,
      inputTokens: null,
      outputTokens: null,
      modelCostUsd: null,
      allocatedServerCostUsd: null,
      tradingFeesUsd: null,
      estimatedSlippageUsd: null,
      totalEstimatedCostUsd: null,
    },
    intent: decision === 'propose_change' ? {
      kind: 'single',
      direction: 'long',
      instrument,
      targetExposure: { minPct: 10, maxPct: 15 },
      invalidation: [{ kind: 'price_below', value: '90', note: 'fixture stop' }],
      confidence: 'medium',
      maxAcceptableLossPct: 2,
      timeHorizon: { unit: 'month', value: 1 },
      evidence: [{ ref: 'fixture:market', note: 'fixture evidence' }],
      snapshotId: `snap:${input.wakeId}`,
      snapshotSha256: '1'.repeat(64),
    } : null,
    thesisDispositions: input.dispositions ?? [],
  };
}

const snapshotInput = (wakeId: string, asOf = '2026-07-12T12:00:00.000Z') => ({
  wakeId,
  asOf,
  envelope: {
    reason: 'scheduled_observe' as const,
    accountId: 'mock-simulator-1',
    authzLevel: 'paper' as const,
    expectedDecision: 'no_trade' as const,
  },
});

describe('production ledger v3 + Snapshot M1 contracts (issue #174)', () => {
  it('exercises approved proof fixtures without importing the proof oracle', async () => {
    const v2 = await fixture<Record<string, unknown>>('ledger-v2-golden.json');
    const v3Single = await fixture<Record<string, unknown>>('ledger-v3-single.json');
    const v3Portfolio = await fixture<Record<string, unknown>>('ledger-v3-portfolio.json');
    const singleSnapshotRaw = await fixture<Record<string, unknown>>('information-snapshot-single.json');
    const portfolioSnapshotRaw = await fixture<Record<string, unknown>>('information-snapshot-portfolio.json');
    const goldens = await fixture<Record<string, string>>('fingerprint-goldens.json');

    const single = stewardDecisionLedgerEntryV3Schema.parse(v3Single);
    const portfolio = stewardDecisionLedgerEntryV3Schema.parse(v3Portfolio);
    const singleSnapshot = stewardInformationSnapshotSchema.parse(singleSnapshotRaw);
    const portfolioSnapshot = stewardInformationSnapshotSchema.parse(portfolioSnapshotRaw);

    expect(canonicalDecisionFingerprint(v2)).toBe(goldens['legacyLedgerV2']);
    expect(canonicalDecisionFingerprint(v3Single)).toBe(goldens['ledgerV3Single']);
    expect(canonicalDecisionFingerprint(v3Portfolio)).toBe(goldens['ledgerV3Portfolio']);
    expect(canonicalInformationSnapshotHash(singleSnapshotRaw)).toBe(goldens['informationSnapshotSingle']);
    expect(canonicalInformationSnapshotHash(portfolioSnapshotRaw)).toBe(goldens['informationSnapshotPortfolio']);
    expect(validateStewardDecisionSnapshotBinding(single, singleSnapshot)).toEqual([]);
    expect(validateStewardDecisionSnapshotBinding(portfolio, portfolioSnapshot)).toEqual([]);
    expect(validateStewardThesisDispositionCoverage(single, singleSnapshot)).toEqual([]);
    expect(validateStewardThesisDispositionCoverage(portfolio, portfolioSnapshot)).toEqual([]);
    expect(validateStewardSnapshotTemporalIntegrity(singleSnapshot)).toEqual([]);
  });

  it('writes only strict v3 while reading distinct v1/v2/v3 history', async () => {
    const v2 = await fixture<Record<string, unknown>>('ledger-v2-golden.json');
    const v3 = await fixture<Record<string, unknown>>('ledger-v3-single.json');
    const v1 = { ...v2, version: 1, actions: ['legacy free text'] };

    expect(parseStewardDecisionLedgerEntryLenient(v1).version).toBe(1);
    expect(parseStewardDecisionLedgerEntryLenient(v2).version).toBe(2);
    expect(parseStewardDecisionLedgerEntryLenient(v3).version).toBe(3);
    expect(() => parseStewardDecisionLedgerEntry(v1)).toThrow();
    expect(() => parseStewardDecisionLedgerEntry(v2)).toThrow();
    expect(() => parseStewardDecisionLedgerEntry({ ...v3, decision: 'propose_trade' })).toThrow();
    expect(parseStewardDecisionLedgerEntry(v3).decision).toBe('propose_change');
  });

  it('reads pre-Snapshot envelopes without accepting a malformed v2 envelope as legacy', () => {
    const legacy = {
      reason: 'scheduled_observe',
      accountId: 'mock-simulator-1',
      authzLevel: 'paper',
      expectedDecision: 'no_trade',
    };
    expect(stewardWakeEnvelopeReadSchema.parse(legacy)).toEqual(legacy);
    expect(() => stewardWakeEnvelopeReadSchema.parse({ ...legacy, version: 2 })).toThrow();
  });

  it('publishes deterministic five-category snapshots exclusively and derives local open-thesis identity', async () => {
    const fixtureV3 = await fixture<Record<string, unknown>>('ledger-v3-portfolio.json');
    const v3: Record<string, unknown> = {
      ...fixtureV3,
      // The proof fixture dispositions address earlier fixture history that is
      // not present in this isolated publisher test's one-line ledger.
      thesisDispositions: [],
    };
    await mkdir(dirname(stewardLedgerPath(dir)), { recursive: true });
    await writeFile(stewardLedgerPath(dir), `${JSON.stringify(v3)}\n`, 'utf8');
    const input = {
      wakeId: 'wake-m1',
      asOf: '2026-07-12T12:00:00.000Z',
      envelope: {
        reason: 'scheduled_observe' as const,
        accountId: v3['accountId'] as string,
        authzLevel: 'paper' as const,
        expectedDecision: 'no_trade' as const,
        marketContext: { refs: ['bar:asset-a'], freshness: 'dispatch' },
      },
    };

    const first = await publishStewardInformationSnapshot(dir, input);
    expect(first.snapshot.market.provided).toBe(true);
    expect(first.snapshot.portfolio).toMatchObject({ provided: false });
    expect(first.snapshot.risk).toMatchObject({ provided: false, envelopeVersion: null });
    expect(first.snapshot.events).toMatchObject({ provided: false });
    expect(first.snapshot.history.provided).toBe(true);
    if (!first.snapshot.history.provided) throw new Error('history unexpectedly unavailable');
    expect(first.snapshot.history.openTheses.map((thesis) => thesis.instrument)).toEqual([
      'mock-simulator-1/ASSET-A',
      'mock-simulator-1/ASSET-B',
    ]);
    expect(new Set(first.snapshot.history.openTheses.map((thesis) => thesis.instrument)).size).toBe(2);
    expect(first.binding.sha256).toBe(canonicalInformationSnapshotHash(first.snapshot));
    expect(first.envelope.snapshotRef).toEqual(first.binding);
    const originalBytes = await readFile(stewardSnapshotPath(dir, input.wakeId), 'utf8');

    const adopted = await publishStewardInformationSnapshot(dir, {
      ...input,
      asOf: '2026-07-12T12:01:00.000Z',
    });
    expect(adopted.binding).toEqual(first.binding);
    expect(await readFile(stewardSnapshotPath(dir, input.wakeId), 'utf8')).toBe(originalBytes);
    await expect(publishStewardInformationSnapshot(dir, {
      ...input,
      envelope: { ...input.envelope, marketContext: { refs: ['different-source'] } },
    })).rejects.toBeInstanceOf(StewardSnapshotConflictError);
    expect(await readFile(stewardSnapshotPath(dir, input.wakeId), 'utf8')).toBe(originalBytes);
    expect((await readdir(dirname(stewardSnapshotPath(dir, input.wakeId))))
      .filter((name) => name.includes('.tmp-'))).toEqual([]);
  });

  it('replays a multi-wake thesis lifecycle: keep preserves, supersede replaces, and expire closes', async () => {
    const instrument = 'mock-simulator-1/ASSET-A';
    const opened = historyEntry({ wakeId: 'wake-open', at: '2026-07-01T00:00:00.000Z', decision: 'propose_change', instrument });
    const kept = historyEntry({
      wakeId: 'wake-keep',
      at: '2026-07-02T00:00:00.000Z',
      dispositions: [{ wakeId: 'wake-open', instrument, disposition: 'keep', note: 'thesis remains valid' }],
    });
    await mkdir(dirname(stewardLedgerPath(dir)), { recursive: true });
    await writeFile(stewardLedgerPath(dir), `${JSON.stringify(opened)}\n${JSON.stringify(kept)}\n`, 'utf8');

    const afterKeep = await publishStewardInformationSnapshot(dir, snapshotInput('snapshot-after-keep', '2026-07-02T12:00:00.000Z'));
    expect(afterKeep.snapshot.history.provided).toBe(true);
    if (!afterKeep.snapshot.history.provided) throw new Error('history unexpectedly unavailable');
    expect(afterKeep.snapshot.history.openTheses).toEqual([expect.objectContaining({
      wakeId: 'wake-open',
      instrument,
      fingerprint: canonicalDecisionFingerprint(opened),
    })]);

    const replacement = historyEntry({
      wakeId: 'wake-replace',
      at: '2026-07-03T00:00:00.000Z',
      decision: 'propose_change',
      instrument,
      dispositions: [{ wakeId: 'wake-open', instrument, disposition: 'supersede', note: 'replace with fresh thesis' }],
    });
    await writeFile(stewardLedgerPath(dir), `${JSON.stringify(opened)}\n${JSON.stringify(kept)}\n${JSON.stringify(replacement)}\n`, 'utf8');
    const afterReplace = await publishStewardInformationSnapshot(dir, snapshotInput('snapshot-after-replace', '2026-07-03T12:00:00.000Z'));
    if (!afterReplace.snapshot.history.provided) throw new Error('history unexpectedly unavailable');
    expect(afterReplace.snapshot.history.openTheses).toEqual([expect.objectContaining({ wakeId: 'wake-replace', instrument })]);

    const expired = historyEntry({
      wakeId: 'wake-expire',
      at: '2026-07-04T00:00:00.000Z',
      dispositions: [{ wakeId: 'wake-replace', instrument, disposition: 'expire', note: 'close thesis' }],
    });
    await writeFile(stewardLedgerPath(dir), `${JSON.stringify(opened)}\n${JSON.stringify(kept)}\n${JSON.stringify(replacement)}\n${JSON.stringify(expired)}\n`, 'utf8');
    const afterExpire = await publishStewardInformationSnapshot(dir, snapshotInput('snapshot-after-expire', '2026-07-04T12:00:00.000Z'));
    if (!afterExpire.snapshot.history.provided) throw new Error('history unexpectedly unavailable');
    expect(afterExpire.snapshot.history.openTheses).toEqual([]);
  });

  it('fails closed instead of publishing incomplete history for malformed or future ledger lines', async () => {
    await mkdir(dirname(stewardLedgerPath(dir)), { recursive: true });
    const valid = historyEntry({ wakeId: 'wake-valid', at: '2026-07-01T00:00:00.000Z' });
    const cases = [
      { wakeId: 'snapshot-invalid-json', ledger: `${JSON.stringify(valid)}\n{broken\n`, error: /invalid JSON/ },
      { wakeId: 'snapshot-invalid-schema', ledger: `${JSON.stringify(valid)}\n${JSON.stringify({ version: 3, wakeId: 'bad' })}\n`, error: /invalid ledger schema/ },
      {
        wakeId: 'snapshot-future',
        ledger: `${JSON.stringify(valid)}\n${JSON.stringify(historyEntry({ wakeId: 'wake-future', at: '2026-07-13T00:00:00.000Z' }))}\n`,
        error: /future ledger entry/,
      },
    ] as const;
    for (const testCase of cases) {
      await writeFile(stewardLedgerPath(dir), testCase.ledger, 'utf8');
      await expect(publishStewardInformationSnapshot(
        dir,
        snapshotInput(testCase.wakeId),
      )).rejects.toThrow(testCase.error);
      await expect(readFile(stewardSnapshotPath(dir, testCase.wakeId), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('uses the first attributable wake winner and ignores a later JSON-object duplicate', async () => {
    await mkdir(dirname(stewardLedgerPath(dir)), { recursive: true });
    const first = historyEntry({
      wakeId: 'wake-first-wins',
      at: '2026-07-01T00:00:00.000Z',
      decision: 'propose_change',
      instrument: 'mock-simulator-1/ASSET-A',
    });
    const laterDuplicate = historyEntry({
      wakeId: 'wake-first-wins',
      at: '2026-07-02T00:00:00.000Z',
      decision: 'propose_change',
      instrument: 'mock-simulator-1/ASSET-B',
    });
    await writeFile(
      stewardLedgerPath(dir),
      `${JSON.stringify(first)}\n${JSON.stringify(laterDuplicate)}\n`,
      'utf8',
    );

    const published = await publishStewardInformationSnapshot(
      dir,
      snapshotInput('snapshot-first-wins', '2026-07-03T00:00:00.000Z'),
    );
    if (!published.snapshot.history.provided) throw new Error('history unexpectedly unavailable');
    expect(published.snapshot.history.openTheses).toEqual([expect.objectContaining({
      wakeId: 'wake-first-wins',
      instrument: 'mock-simulator-1/ASSET-A',
      fingerprint: canonicalDecisionFingerprint(first),
    })]);
  });

  it('fails closed when the first attributable winner is schema-invalid even if a valid duplicate follows', async () => {
    await mkdir(dirname(stewardLedgerPath(dir)), { recursive: true });
    const invalidFirst = { version: 3, wakeId: 'wake-invalid-first', accountId: 'mock-simulator-1' };
    const validLater = historyEntry({
      wakeId: 'wake-invalid-first',
      at: '2026-07-01T00:00:00.000Z',
      decision: 'propose_change',
    });
    await writeFile(
      stewardLedgerPath(dir),
      `${JSON.stringify(invalidFirst)}\n${JSON.stringify(validLater)}\n`,
      'utf8',
    );

    await expect(publishStewardInformationSnapshot(
      dir,
      snapshotInput('snapshot-invalid-first'),
    )).rejects.toThrow(/invalid ledger schema at line 1/);
    expect(existsSync(stewardSnapshotPath(dir, 'snapshot-invalid-first'))).toBe(false);
  });

  it('idempotently adopts only a canonical-identical immutable snapshot on retry', async () => {
    const input = snapshotInput('wake-idempotent');
    const first = await publishStewardInformationSnapshot(dir, input);
    const bytes = await readFile(stewardSnapshotPath(dir, input.wakeId), 'utf8');
    const retry = await publishStewardInformationSnapshot(dir, {
      ...input,
      asOf: '2026-07-12T12:05:00.000Z',
    });
    expect(retry.binding).toEqual(first.binding);
    expect(await readFile(stewardSnapshotPath(dir, input.wakeId), 'utf8')).toBe(bytes);
  });
});
