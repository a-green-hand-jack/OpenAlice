import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createStewardLedgerStore,
  createStewardLockStore,
  createStewardSupervisor,
  createStewardWakeStore,
  DECISION_LEDGER_SCHEMA_VERSION,
  StewardLockConflictError,
  stewardStatePath,
  stewardSupervisorLogPath,
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

describe('StewardLockStore', () => {
  it('guards one active wake per account and allows expired lock replacement', async () => {
    const store = createStewardLockStore(dir);
    const first = await store.acquire({
      accountId: 'mock-simulator-1',
      wakeId: 'wake-1',
      now: '2026-07-08T14:00:00.000Z',
      expiresAt: '2026-07-08T14:03:00.000Z',
    });

    expect(first.accountId).toBe('mock-simulator-1');
    expect(store.filenameFor('mock/simulator:1')).toBe('mock%2Fsimulator%3A1.json');
    await expect(store.acquire({
      accountId: 'mock-simulator-1',
      wakeId: 'wake-2',
      now: '2026-07-08T14:01:00.000Z',
      expiresAt: '2026-07-08T14:04:00.000Z',
    })).rejects.toBeInstanceOf(StewardLockConflictError);

    const replacement = await store.acquire({
      accountId: 'mock-simulator-1',
      wakeId: 'wake-2',
      now: '2026-07-08T14:03:01.000Z',
      expiresAt: '2026-07-08T14:06:00.000Z',
    });
    expect(replacement.wakeId).toBe('wake-2');
    expect(await store.release('mock-simulator-1', 'wake-1')).toBe(false);
    expect(await store.release('mock-simulator-1', 'wake-2')).toBe(true);
    expect(await store.get('mock-simulator-1')).toBeNull();
  });
});

describe('StewardSupervisor', () => {
  it('marks ledger-completed wakes done, releases locks, and writes cost state', async () => {
    const wakeStore = createStewardWakeStore(dir);
    const ledgerStore = createStewardLedgerStore(dir);
    const lockStore = createStewardLockStore(dir);
    await wakeStore.create({
      wakeId: 'wake-1',
      deadline: '2026-07-08T14:03:00.000Z',
      envelope,
      now: '2026-07-08T14:00:00.000Z',
    });
    await wakeStore.updateStatus('wake-1', 'injected', {
      now: '2026-07-08T14:00:05.000Z',
      injectedAt: '2026-07-08T14:00:05.000Z',
      sessionId: 'codex-session-1',
    });
    await lockStore.acquire({
      accountId: envelope.accountId,
      wakeId: 'wake-1',
      now: '2026-07-08T14:00:00.000Z',
      expiresAt: '2026-07-08T14:03:00.000Z',
    });
    await ledgerStore.append(ledgerEntry({
      wakeId: 'wake-1',
      cost: {
        model: 'codex',
        inputTokens: 100,
        outputTokens: 50,
        modelCostUsd: 180,
        allocatedServerCostUsd: 1,
        tradingFeesUsd: 2,
        estimatedSlippageUsd: 3,
        totalEstimatedCostUsd: null,
      },
    }));

    const result = await createStewardSupervisor(dir).tick({
      now: '2026-07-08T14:01:30.000Z',
      isSessionRunning: () => true,
      config: { monthlyBudget: { modelUsd: 200 }, costPolicy: { warnAtPct: 80 } },
    });

    expect(result.transitions).toEqual([{
      wakeId: 'wake-1',
      from: 'injected',
      to: 'done',
      reason: 'ledger:done',
    }]);
    expect((await wakeStore.get('wake-1'))?.status).toBe('done');
    expect(await lockStore.get(envelope.accountId)).toBeNull();
    expect(result.cost).toMatchObject({
      entries: 1,
      inputTokens: 100,
      outputTokens: 50,
      modelCostUsd: 180,
      totalEstimatedCostUsd: 186,
    });
    expect(result.warnings).toHaveLength(1);

    const state = JSON.parse(await readFile(stewardStatePath(dir), 'utf8')) as { cost: { entries: number } };
    expect(state.cost.entries).toBe(1);
    const log = await readFile(stewardSupervisorLogPath(dir), 'utf8');
    expect(log).toContain('"type":"wake_completed"');
    expect(log).toContain('"type":"cost_summary"');
  });

  it('marks injected wakes stuck when the session is gone before deadline', async () => {
    const wakeStore = createStewardWakeStore(dir);
    const lockStore = createStewardLockStore(dir);
    await wakeStore.create({
      wakeId: 'wake-stuck',
      deadline: '2026-07-08T14:03:00.000Z',
      envelope,
      now: '2026-07-08T14:00:00.000Z',
    });
    await wakeStore.updateStatus('wake-stuck', 'injected', {
      now: '2026-07-08T14:00:05.000Z',
      injectedAt: '2026-07-08T14:00:05.000Z',
      sessionId: 'missing-session',
    });
    await lockStore.acquire({
      accountId: envelope.accountId,
      wakeId: 'wake-stuck',
      now: '2026-07-08T14:00:00.000Z',
      expiresAt: '2026-07-08T14:03:00.000Z',
    });

    const result = await createStewardSupervisor(dir).tick({
      now: '2026-07-08T14:01:00.000Z',
      isSessionRunning: () => false,
    });

    expect(result.transitions[0]).toMatchObject({
      wakeId: 'wake-stuck',
      from: 'injected',
      to: 'stuck',
      reason: 'session_not_running',
    });
    expect((await wakeStore.get('wake-stuck'))?.status).toBe('stuck');
    expect(await lockStore.get(envelope.accountId)).toBeNull();
  });
});
