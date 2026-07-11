/**
 * Issue #140: the atomic, cross-process-locked ledger writer. These exercise the
 * TS side of the protocol the generated validator mirrors — no lost updates
 * under concurrency, safe stale-lock reclaim, lock serialization, and
 * old-content preservation on a failed write.
 */
import { mkdtemp, readFile, rm, writeFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  acquireLedgerLock,
  createStewardLedgerStore,
  DECISION_LEDGER_SCHEMA_VERSION,
  LOCK_TTL_MS,
  stewardLedgerLockPath,
  withLedgerWrite,
  type StewardDecisionLedgerEntryV2,
} from './index.js';
import { stewardLedgerPath } from './paths.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ledger-writer-'));
  await mkdir(dirname(stewardLedgerPath(dir)), { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function entry(wakeId: string): StewardDecisionLedgerEntryV2 {
  return {
    version: DECISION_LEDGER_SCHEMA_VERSION,
    wakeId,
    at: '2026-07-11T00:00:00.000Z',
    accountId: 'acct',
    decision: 'no_trade',
    status: 'done',
    completion: { reason: 'done', evidenceRefs: [`wake:${wakeId}`, 'tool:risk'] },
    checklist: { account: 'ok', positions: 'ok', orders: 'ok', risk: 'ok', market: 'ok', history: 'ok' },
    thesis: 'th',
    actions: [],
    pendingHash: null,
    invalidation: 'inv',
    cost: {
      model: 'c', inputTokens: null, outputTokens: null, modelCostUsd: null,
      allocatedServerCostUsd: null, tradingFeesUsd: null, estimatedSlippageUsd: null, totalEstimatedCostUsd: null,
    },
  };
}

describe('StewardLedgerStore.append atomic locked write (issue #140)', () => {
  it('does not lose updates under concurrency: N parallel appends → N distinct lines', async () => {
    const store = createStewardLedgerStore(dir);
    const ids = Array.from({ length: 25 }, (_, i) => `wake-${i}`);
    await Promise.all(ids.map((id) => store.append(entry(id))));
    const lines = (await readFile(store.path(), 'utf8')).split('\n').filter(Boolean);
    expect(lines).toHaveLength(25);
    const seen = new Set(lines.map((l) => JSON.parse(l).wakeId));
    expect(seen.size).toBe(25);
    // No lock or temp files left behind.
    const dirEntries = await readdir(dirname(store.path()));
    expect(dirEntries.filter((n) => n.includes('.lock') || n.includes('.tmp-'))).toEqual([]);
  });

  it('reclaims a stale lock and still writes', async () => {
    const store = createStewardLedgerStore(dir);
    await store.append(entry('wake-first'));
    // A crashed writer left a lock behind, older than the TTL.
    await writeFile(
      stewardLedgerLockPath(dir),
      JSON.stringify({ pid: 999999, token: 'dead', at: Date.now() - (LOCK_TTL_MS + 5_000) }),
      'utf8',
    );
    await store.append(entry('wake-second')); // must reclaim + proceed
    const ids = (await readFile(store.path(), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l).wakeId);
    expect(ids).toEqual(['wake-first', 'wake-second']);
  });

  it('serializes writers: a held lock blocks a concurrent append until released', async () => {
    const store = createStewardLedgerStore(dir);
    const lock = await acquireLedgerLock(dir);
    const appendPromise = store.append(entry('wake-blocked')); // must wait for the lock
    // Release shortly after; the append then proceeds.
    await new Promise((r) => setTimeout(r, 60));
    await lock.release();
    await appendPromise;
    const ids = (await readFile(store.path(), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l).wakeId);
    expect(ids).toEqual(['wake-blocked']);
  });

  it('a failed mutate leaves the ledger\'s old complete content intact and releases the lock', async () => {
    await writeFile(stewardLedgerPath(dir), 'OLD-COMPLETE\n', 'utf8');
    await expect(withLedgerWrite(dir, () => { throw new Error('boom'); })).rejects.toThrow('boom');
    // Old content untouched — never truncated in place.
    expect(await readFile(stewardLedgerPath(dir), 'utf8')).toBe('OLD-COMPLETE\n');
    // Lock released → a subsequent write succeeds.
    await withLedgerWrite(dir, (raw) => `${raw}NEW\n`);
    expect(await readFile(stewardLedgerPath(dir), 'utf8')).toBe('OLD-COMPLETE\nNEW\n');
  });
});
