import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createStewardLedgerStore,
  createStewardWakeStore,
  DECISION_LEDGER_SCHEMA_VERSION,
  WAKE_SCHEMA_VERSION,
  type StewardDecisionLedgerEntry,
  type StewardWakeEnvelope,
} from './index.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'steward-store-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const envelope: StewardWakeEnvelope = {
  reason: 'scheduled_observe',
  accountId: 'mock-simulator-1',
  authzLevel: 'paper',
  expectedDecision: 'no_trade',
  marketContext: { symbols: ['AAPL'] },
  riskContext: { riskState: 'NORMAL', guards: [] },
};

function ledgerEntry(over: Partial<StewardDecisionLedgerEntry> = {}): StewardDecisionLedgerEntry {
  return {
    version: DECISION_LEDGER_SCHEMA_VERSION,
    wakeId: '2026-07-08T14:00:00Z:aapl-risk-check',
    at: '2026-07-08T14:01:23.000Z',
    accountId: 'mock-simulator-1',
    decision: 'no_trade',
    status: 'done',
    context: {
      manifestPath: '.alice/steward/context-manifest.json',
      manifestSha256: 'abc123',
    },
    completion: {
      reason: 'checklist complete; no entry signal',
      evidenceRefs: ['wake:2026-07-08T14:00:00Z:aapl-risk-check', 'tool:risk'],
    },
    checklist: {
      account: 'ok',
      positions: 'ok',
      orders: 'ok',
      risk: 'NORMAL',
      market: 'open',
      history: 'checked',
    },
    thesis: 'No trade: no thesis or entry signal in this behavior wake.',
    actions: [],
    pendingHash: null,
    invalidation: 'A new explicit thesis or entry signal would reopen the decision.',
    cost: {
      model: 'codex',
      inputTokens: null,
      outputTokens: null,
      modelCostUsd: null,
      allocatedServerCostUsd: null,
      tradingFeesUsd: null,
      estimatedSlippageUsd: null,
      totalEstimatedCostUsd: null,
    },
    ...over,
  };
}

describe('StewardWakeStore', () => {
  it('creates a queued wake record at a cross-platform encoded wake path', async () => {
    const store = createStewardWakeStore(dir);
    const wakeId = '2026-07-08T14:00:00Z:aapl-risk-check';

    const record = await store.create({
      wakeId,
      deadline: '2026-07-08T14:03:00.000Z',
      envelope,
      now: '2026-07-08T14:00:00.000Z',
    });

    expect(record).toMatchObject({
      version: WAKE_SCHEMA_VERSION,
      wakeId,
      status: 'queued',
      createdAt: '2026-07-08T14:00:00.000Z',
      injectedAt: null,
      sessionId: null,
      envelope,
    });
    expect(store.filenameFor(wakeId)).toBe('2026-07-08T14%3A00%3A00Z%3Aaapl-risk-check.json');
    expect(existsSync(store.pathFor(wakeId))).toBe(true);
    expect(await store.get(wakeId)).toEqual(record);
  });

  it('updates status, timestamps, session id, and clears transient errors', async () => {
    const store = createStewardWakeStore(dir);
    const wakeId = 'wake-1';
    await store.create({
      wakeId,
      deadline: '2026-07-08T14:03:00.000Z',
      envelope,
      now: '2026-07-08T14:00:00.000Z',
    });

    const injected = await store.updateStatus(wakeId, 'injected', {
      now: '2026-07-08T14:00:05.000Z',
      injectedAt: '2026-07-08T14:00:05.000Z',
      sessionId: 'codex-session-1',
    });
    expect(injected.status).toBe('injected');
    expect(injected.updatedAt).toBe('2026-07-08T14:00:05.000Z');
    expect(injected.injectedAt).toBe('2026-07-08T14:00:05.000Z');
    expect(injected.sessionId).toBe('codex-session-1');

    const errored = await store.updateStatus(wakeId, 'error', {
      now: '2026-07-08T14:01:00.000Z',
      error: 'tool failed',
    });
    expect(errored.error).toBe('tool failed');

    const done = await store.updateStatus(wakeId, 'done', {
      now: '2026-07-08T14:01:23.000Z',
      completedAt: '2026-07-08T14:01:23.000Z',
      error: null,
    });
    expect(done.status).toBe('done');
    expect(done.completedAt).toBe('2026-07-08T14:01:23.000Z');
    expect(done.error).toBeUndefined();
  });

  it('lists wake records in createdAt order and refuses duplicate create', async () => {
    const store = createStewardWakeStore(dir);
    await store.create({
      wakeId: 'wake-b',
      deadline: '2026-07-08T14:03:00.000Z',
      envelope,
      now: '2026-07-08T14:00:02.000Z',
    });
    await store.create({
      wakeId: 'wake-a',
      deadline: '2026-07-08T14:03:00.000Z',
      envelope,
      now: '2026-07-08T14:00:01.000Z',
    });

    await expect(store.create({
      wakeId: 'wake-a',
      deadline: '2026-07-08T14:03:00.000Z',
      envelope,
    })).rejects.toThrow(/already exists/);

    expect((await store.list()).map((r) => r.wakeId)).toEqual(['wake-a', 'wake-b']);
  });
});

describe('StewardLedgerStore', () => {
  it('appends and reads validated decision ledger entries', async () => {
    const store = createStewardLedgerStore(dir);
    const first = await store.append(ledgerEntry({ wakeId: 'wake-1', at: '2026-07-08T14:01:00.000Z' }));
    const second = await store.append(ledgerEntry({ wakeId: 'wake-2', at: '2026-07-08T14:02:00.000Z' }));

    expect(await store.read()).toEqual([first, second]);
    expect(await store.read({ limit: 1 })).toEqual([second]);
    expect(await store.read({ wakeId: 'wake-1' })).toEqual([first]);
    expect(await store.findByWakeId('wake-2')).toEqual(second);
    expect(await store.findByWakeId('missing')).toBeNull();

    const raw = await readFile(store.path(), 'utf8');
    expect(raw.trim().split('\n')).toHaveLength(2);
  });

  it('requires completion.reason and the full cost field set', async () => {
    const store = createStewardLedgerStore(dir);

    await expect(store.append(ledgerEntry({
      completion: { reason: '', evidenceRefs: ['wake:wake-1'] },
    }))).rejects.toThrow();

    const missingCostField = ledgerEntry() as unknown as { cost: Record<string, unknown> };
    delete missingCostField.cost.totalEstimatedCostUsd;
    await expect(store.append(missingCostField as unknown as StewardDecisionLedgerEntry)).rejects.toThrow();
  });

  it('surfaces invalid persisted ledger lines with line numbers', async () => {
    const store = createStewardLedgerStore(dir);
    await store.append(ledgerEntry({ wakeId: 'wake-1' }));
    await rm(store.path(), { force: true });
    await writeFile(store.path(), `${JSON.stringify(ledgerEntry({ wakeId: 'wake-1' }))}\n{"bad":true}\n`, 'utf8');

    await expect(store.read()).rejects.toThrow(/invalid steward decision ledger line 2/);
  });
});
