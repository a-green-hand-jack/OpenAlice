import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createStewardLedgerStore,
  createStewardLockStore,
  createStewardSupervisor,
  createStewardWakeStore,
  DECISION_LEDGER_SCHEMA_VERSION,
  parseStewardDecisionLedgerEntry,
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

  it('coerces numeric-string cost fields to actual numbers (a smaller model\'s observed mistake)', async () => {
    const store = createStewardLedgerStore(dir);
    // A well-formed entry, but with every numeric `cost` field written as a
    // JSON string -- exactly what a claude-haiku-4-5-20251001 steward session
    // was observed producing live. Built as a plain object (not the typed
    // `ledgerEntry()` helper) since the whole point is that these fields are
    // NOT the number type the schema declares.
    const rawEntry = {
      ...ledgerEntry({ wakeId: 'wake-str-cost' }),
      cost: {
        model: 'claude-haiku-4-5-20251001',
        inputTokens: '120',
        outputTokens: '45',
        modelCostUsd: '0.01',
        allocatedServerCostUsd: '0',
        tradingFeesUsd: '0',
        estimatedSlippageUsd: '0',
        totalEstimatedCostUsd: '0',
      },
    };

    await mkdir(dirname(store.path()), { recursive: true });
    await writeFile(store.path(), `${JSON.stringify(rawEntry)}\n`, 'utf8');

    const entries = await store.read();
    expect(entries).toHaveLength(1);
    expect(entries[0].cost.tradingFeesUsd).toBe(0);
    expect(typeof entries[0].cost.tradingFeesUsd).toBe('number');
    expect(entries[0].cost.estimatedSlippageUsd).toBe(0);
    expect(typeof entries[0].cost.estimatedSlippageUsd).toBe('number');
    expect(entries[0].cost.totalEstimatedCostUsd).toBe(0);
    expect(entries[0].cost.modelCostUsd).toBeCloseTo(0.01);
    expect(typeof entries[0].cost.modelCostUsd).toBe('number');
    expect(entries[0].cost.inputTokens).toBe(120);
    expect(typeof entries[0].cost.inputTokens).toBe('number');
    expect(entries[0].cost.outputTokens).toBe(45);
    expect(typeof entries[0].cost.outputTokens).toBe('number');

    // parseStewardDecisionLedgerEntry (also used directly by `append`) applies
    // the same coercion independent of the store's read-from-disk path, and a
    // real `null` cost value must still parse as `null`, not get coerced to 0.
    const parsedDirectly = parseStewardDecisionLedgerEntry(rawEntry);
    expect(parsedDirectly.cost.tradingFeesUsd).toBe(0);
    expect(typeof parsedDirectly.cost.tradingFeesUsd).toBe('number');
    const withNullCost = parseStewardDecisionLedgerEntry({
      ...rawEntry,
      cost: { ...rawEntry.cost, tradingFeesUsd: null },
    });
    expect(withNullCost.cost.tradingFeesUsd).toBeNull();
  });

  it('skips a genuinely malformed ledger line without throwing, and still returns every other valid entry', async () => {
    const store = createStewardLedgerStore(dir);
    const good1 = ledgerEntry({ wakeId: 'wake-good-1', at: '2026-07-08T14:01:00.000Z' });
    const good2 = ledgerEntry({ wakeId: 'wake-good-2', at: '2026-07-08T14:02:00.000Z' });
    const missingDecision = { ...ledgerEntry({ wakeId: 'wake-missing-decision' }) } as Record<string, unknown>;
    delete missingDecision.decision;

    await mkdir(dirname(store.path()), { recursive: true });
    await writeFile(
      store.path(),
      [
        JSON.stringify(good1),
        'not valid json at all',
        JSON.stringify(missingDecision),
        JSON.stringify(good2),
      ].join('\n') + '\n',
      'utf8',
    );

    const entries = await store.read();
    expect(entries.map((e) => e.wakeId)).toEqual(['wake-good-1', 'wake-good-2']);

    const diagnostics = await store.readDiagnostics();
    expect(diagnostics.entries.map((e) => e.wakeId)).toEqual(['wake-good-1', 'wake-good-2']);
    expect(diagnostics.invalid).toHaveLength(2);
    expect(diagnostics.invalid[0].line).toBe(2);
    expect(diagnostics.invalid[1].line).toBe(3);

    // findByWakeId, built on read(), sees neither the invalid-JSON line nor
    // the missing-field line as a match -- it doesn't throw either.
    expect(await store.findByWakeId('wake-missing-decision')).toBeNull();
    expect((await store.findByWakeId('wake-good-2'))?.wakeId).toBe('wake-good-2');
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

  it('reconciles a good wake even when another wake\'s ledger line is malformed', async () => {
    const wakeStore = createStewardWakeStore(dir);
    const lockStore = createStewardLockStore(dir);
    const ledgerStore = createStewardLedgerStore(dir);
    const badEnvelope: StewardWakeEnvelope = { ...envelope, accountId: 'mock-simulator-2' };

    // wake-good: a normal wake with a well-formed ledger entry -> should
    // reconcile to 'done' same as any other tick.
    await wakeStore.create({
      wakeId: 'wake-good',
      deadline: '2026-07-08T14:03:00.000Z',
      envelope,
      now: '2026-07-08T14:00:00.000Z',
    });
    await wakeStore.updateStatus('wake-good', 'injected', {
      now: '2026-07-08T14:00:05.000Z',
      injectedAt: '2026-07-08T14:00:05.000Z',
      sessionId: 'session-good',
    });
    await lockStore.acquire({
      accountId: envelope.accountId,
      wakeId: 'wake-good',
      now: '2026-07-08T14:00:00.000Z',
      expiresAt: '2026-07-08T14:03:00.000Z',
    });

    // wake-bad: a DIFFERENT wake (different account) whose ledger line is
    // genuinely malformed (missing `decision`) -- must not block wake-good's
    // reconciliation in the same tick.
    await wakeStore.create({
      wakeId: 'wake-bad',
      deadline: '2026-07-08T14:03:00.000Z',
      envelope: badEnvelope,
      now: '2026-07-08T14:00:00.000Z',
    });
    await wakeStore.updateStatus('wake-bad', 'injected', {
      now: '2026-07-08T14:00:05.000Z',
      injectedAt: '2026-07-08T14:00:05.000Z',
      sessionId: 'session-bad',
    });
    await lockStore.acquire({
      accountId: 'mock-simulator-2',
      wakeId: 'wake-bad',
      now: '2026-07-08T14:00:00.000Z',
      expiresAt: '2026-07-08T14:03:00.000Z',
    });

    const goodEntry = ledgerEntry({ wakeId: 'wake-good', at: '2026-07-08T14:01:00.000Z' });
    const badEntry = {
      ...ledgerEntry({ wakeId: 'wake-bad', at: '2026-07-08T14:01:05.000Z' }),
    } as Record<string, unknown>;
    delete badEntry.decision;

    await mkdir(dirname(ledgerStore.path()), { recursive: true });
    await writeFile(
      ledgerStore.path(),
      `${JSON.stringify(goodEntry)}\n${JSON.stringify(badEntry)}\n`,
      'utf8',
    );

    const result = await createStewardSupervisor(dir).tick({
      now: '2026-07-08T14:01:30.000Z',
      isSessionRunning: () => true,
    });

    expect(result.transitions).toContainEqual({
      wakeId: 'wake-good',
      from: 'injected',
      to: 'done',
      reason: 'ledger:done',
    });
    expect((await wakeStore.get('wake-good'))?.status).toBe('done');
    expect(await lockStore.get(envelope.accountId)).toBeNull();

    // wake-bad has no PARSEABLE ledger entry this tick (its line was skipped,
    // not thrown), so the supervisor simply falls through to its
    // deadline/liveness checks same as "no entry yet" -- it does NOT crash the
    // whole tick, and wake-good still reconciled above.
    expect((await wakeStore.get('wake-bad'))?.status).toBe('injected');
    expect(await lockStore.get('mock-simulator-2')).not.toBeNull();
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
