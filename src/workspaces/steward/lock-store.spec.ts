/**
 * StewardLockStore.acquire atomicity (issue #154).
 *
 * Pre-fix, `acquire` was a read-then-write TOCTOU: two concurrent callers for
 * the same account could both observe "no live lock" before either wrote the
 * lock file, so both proceeded — the exact bug reported when a cron fire and
 * a manual HTTP fire land near-simultaneously for the same workspace/account.
 *
 * These specs exercise the fixed compare-and-set (`open(path, 'wx')` for a
 * fresh claim, atomic `rename`-away for a stale-lock takeover) directly
 * against `StewardLockStore`, independent of the dispatch layer:
 *  - concurrent fresh acquires converge to exactly one winner
 *  - concurrent reclaims of a stale (crashed-process) lock converge to
 *    exactly one winner, and the stale lock stays reclaimable at all
 *  - a single uncontended acquire still produces byte-identical v1 JSON to
 *    the pre-#154 shape
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createStewardLockStore, StewardLockConflictError } from './lock-store.js';
import { STEWARD_LOCK_SCHEMA_VERSION } from './types.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'steward-lock-store-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const NOW = '2026-07-08T14:00:00.000Z';
const FUTURE_DEADLINE = '2999-01-01T00:00:00.000Z';

/** Every element must be a rejection carrying a `StewardLockConflictError`. */
function expectAllConflictRejections(results: PromiseSettledResult<unknown>[]): void {
  for (const r of results) {
    if (r.status !== 'rejected') continue;
    expect(r.reason).toBeInstanceOf(StewardLockConflictError);
  }
}

describe('StewardLockStore.acquire — concurrent fresh acquire (issue #154)', () => {
  it('8 simultaneous acquires for the same account: exactly one wins, every loser gets StewardLockConflictError, no unhandled rejections — looped 20x to make the race statistically visible', async () => {
    const ITERATIONS = 20;
    const CONTENDERS = 8;
    const store = createStewardLockStore(dir);

    for (let iter = 0; iter < ITERATIONS; iter += 1) {
      const accountId = `race-account-${iter}`;
      // Promise.allSettled attaches a handler to every promise up front, so a
      // losing acquire's rejection is observed here rather than surfacing as
      // an unhandled rejection.
      const results = await Promise.allSettled(
        Array.from({ length: CONTENDERS }, (_, i) =>
          store.acquire({
            accountId,
            wakeId: `wake-${iter}-${i}`,
            now: NOW,
            expiresAt: FUTURE_DEADLINE,
          })),
      );

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(CONTENDERS - 1);
      expectAllConflictRejections(rejected);

      // The persisted lock reflects exactly the winner — no interleaved
      // partial write from a loser.
      const persisted = await store.get(accountId);
      expect(persisted).not.toBeNull();
      if (fulfilled[0]?.status === 'fulfilled') {
        expect(persisted?.wakeId).toBe((fulfilled[0].value as { wakeId: string }).wakeId);
      }
    }
  });
});

describe('StewardLockStore.acquire — stale-lock reclaim survives the atomic rewrite (issue #154)', () => {
  it('a lock left behind by a crashed process (past its TTL) is still reclaimable by a fresh acquire', async () => {
    const store = createStewardLockStore(dir);
    const accountId = 'stale-account';
    await store.acquire({
      accountId,
      wakeId: 'wake-crashed',
      now: '2026-07-08T14:00:00.000Z',
      expiresAt: '2026-07-08T14:03:00.000Z', // the "crashed" process never released this
    });

    const reclaimed = await store.acquire({
      accountId,
      wakeId: 'wake-successor',
      now: '2026-07-08T14:03:01.000Z', // past the stale lock's expiresAt
      expiresAt: '2026-07-08T14:06:00.000Z',
    });

    expect(reclaimed.wakeId).toBe('wake-successor');
    expect(await store.get(accountId)).toMatchObject({ wakeId: 'wake-successor' });
  });

  it('two concurrent reclaim attempts against the same stale lock: exactly one winner — looped 20x to make the race statistically visible', async () => {
    const ITERATIONS = 20;
    const CONTENDERS = 8;
    const store = createStewardLockStore(dir);

    for (let iter = 0; iter < ITERATIONS; iter += 1) {
      const accountId = `stale-race-${iter}`;
      // Seed an expired lock, as a crashed process would leave behind.
      await store.acquire({
        accountId,
        wakeId: `wake-crashed-${iter}`,
        now: '2026-07-08T14:00:00.000Z',
        expiresAt: '2026-07-08T14:03:00.000Z',
      });

      const nowPastExpiry = '2026-07-08T14:03:01.000Z';
      const results = await Promise.allSettled(
        Array.from({ length: CONTENDERS }, (_, i) =>
          store.acquire({
            accountId,
            wakeId: `wake-successor-${iter}-${i}`,
            now: nowPastExpiry,
            expiresAt: '2026-07-08T14:06:00.000Z',
          })),
      );

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(CONTENDERS - 1);
      expectAllConflictRejections(rejected);
    }
  });
});

describe('StewardLockStore.acquire — uncontended path is unchanged (issue #154)', () => {
  it('a single acquire writes the same v1 JSON shape as before the atomic-acquire rewrite', async () => {
    const store = createStewardLockStore(dir);
    const accountId = 'solo-account';

    const record = await store.acquire({
      accountId,
      wakeId: 'wake-solo',
      now: NOW,
      expiresAt: FUTURE_DEADLINE,
    });

    const expectedShape = {
      version: STEWARD_LOCK_SCHEMA_VERSION,
      accountId,
      wakeId: 'wake-solo',
      acquiredAt: NOW,
      expiresAt: FUTURE_DEADLINE,
    };
    expect(STEWARD_LOCK_SCHEMA_VERSION).toBe(1);
    expect(record).toEqual(expectedShape);

    // Byte-compare: the exclusive-create write path must produce the exact
    // same serialization the old read-then-write path did.
    const raw = await readFile(store.pathFor(accountId), 'utf8');
    expect(raw).toBe(`${JSON.stringify(expectedShape, null, 2)}\n`);
  });
});
