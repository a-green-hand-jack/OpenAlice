/**
 * StewardLockStore.acquire atomicity (issue #154, and the #154 review fixup
 * for C1/M1/M2 below).
 *
 * Pre-fix, `acquire` was a read-then-write TOCTOU: two concurrent callers for
 * the same account could both observe "no live lock" before either wrote the
 * lock file, so both proceeded — the exact bug reported when a cron fire and
 * a manual HTTP fire land near-simultaneously for the same workspace/account.
 *
 * A first fix (create-then-steal via `open('wx')` + rename-away takeover)
 * turned out to have its own residual race on the stale-lock takeover path
 * (review finding C1: a delayed reclaimer's `rename` could yank a winner's
 * freshly-recreated LIVE lock, producing two simultaneous winners — the
 * exact bug #154 exists to prevent) plus a torn-file risk on write failure
 * (review finding M1). The current fix instead serializes the ENTIRE
 * check → expiry-check → write body per account behind a module-level async
 * mutex (see `withLockFileMutex` in `lock-store.ts`), so no interleaving is
 * possible by construction, and restores the original tmp+rename write
 * (`writeJsonAtomic`) so a write failure can never leave a torn file at the
 * canonical lock path.
 *
 * These specs exercise `StewardLockStore` directly, independent of the
 * dispatch layer:
 *  - concurrent fresh acquires converge to exactly one winner (unchanged
 *    from the first #154 fix — kept as specified by review)
 *  - a stale (crashed-process) lock stays reclaimable by a single acquirer
 *  - a high-iteration stress run of concurrent reclaimers over a seeded
 *    stale lock never produces a double-winner or a non-conflict rejection
 *    (review finding M2 — the original 20-iteration version could not
 *    reliably surface C1, which reproduced at roughly 5-in-30,000)
 *  - a single uncontended acquire still produces byte-identical v1 JSON to
 *    the pre-#154 shape
 *  - a torn/unparseable legacy lock file self-heals instead of bricking the
 *    account (review finding M1)
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

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

describe('StewardLockStore.acquire — stale-lock reclaim survives the mutex rewrite (issue #154)', () => {
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

  /**
   * Review finding M2: the original 20-iteration x 8-way version of this
   * test could not reliably catch C1 (the create-then-steal design's
   * double-winner bug reproduced at roughly 5-in-30,000). This runs as many
   * iterations as fit in a fixed wall-clock budget (target 30,000, budget
   * well under the test timeout so a slow CI box still gets a real report
   * instead of a timeout failure) and asserts zero double-winners and zero
   * non-`StewardLockConflictError` rejections across ALL of them. With the
   * mutex, every iteration is fully serialized in-process, so this is
   * expected to pass deterministically, not probabilistically.
   */
  it(
    'high-iteration stress: N-way contention over a seeded stale lock never yields a double-winner or a non-conflict rejection',
    async () => {
      const store = createStewardLockStore(dir);
      const CONTENDERS = 8;
      const TARGET_ITERATIONS = 30_000;
      const BUDGET_MS = 25_000; // leave headroom under this test's own timeout

      const startedAt = Date.now();
      let iterations = 0;
      let doubleWinnerIterations = 0;
      let nonConflictRejections = 0;

      while (iterations < TARGET_ITERATIONS && Date.now() - startedAt < BUDGET_MS) {
        const accountId = `stale-stress-${iterations}`;
        // Seed an expired lock, as a crashed process would leave behind.
        await store.acquire({
          accountId,
          wakeId: `wake-crashed-${iterations}`,
          now: '2026-07-08T14:00:00.000Z',
          expiresAt: '2026-07-08T14:03:00.000Z',
        });

        const results = await Promise.allSettled(
          Array.from({ length: CONTENDERS }, (_, i) =>
            store.acquire({
              accountId,
              wakeId: `wake-successor-${iterations}-${i}`,
              now: '2026-07-08T14:03:01.000Z', // past the seeded lock's expiresAt
              expiresAt: '2026-07-08T14:06:00.000Z',
            })),
        );

        const fulfilledCount = results.filter((r) => r.status === 'fulfilled').length;
        if (fulfilledCount !== 1) doubleWinnerIterations += 1;
        for (const r of results) {
          if (r.status === 'rejected' && !(r.reason instanceof StewardLockConflictError)) {
            nonConflictRejections += 1;
          }
        }

        iterations += 1;
      }

      const elapsedMs = Date.now() - startedAt;
      // Visible in CI output regardless of pass/fail — the achieved count is
      // itself part of what review asked to report.
      // eslint-disable-next-line no-console
      console.log(
        `[issue-154 review M2] stale-lock stress: iterations=${iterations} elapsedMs=${elapsedMs} doubleWinnerIterations=${doubleWinnerIterations} nonConflictRejections=${nonConflictRejections}`,
      );

      expect(iterations).toBeGreaterThanOrEqual(1000); // sanity: the loop actually ran a meaningful number of rounds
      expect(doubleWinnerIterations).toBe(0);
      expect(nonConflictRejections).toBe(0);
    },
    30_000,
  );
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

    // Byte-compare: the mutex-serialized write path must produce the exact
    // same tmp+rename serialization the pre-#154 path did.
    const raw = await readFile(store.pathFor(accountId), 'utf8');
    expect(raw).toBe(`${JSON.stringify(expectedShape, null, 2)}\n`);
  });
});

describe('StewardLockStore.get — torn/legacy-corrupt lock residue self-heals (issue #154 review M1)', () => {
  it('treats an unparseable lock file as absent rather than throwing, and a subsequent acquire overwrites it cleanly', async () => {
    const store = createStewardLockStore(dir);
    const accountId = 'torn-account';
    const path = store.pathFor(accountId);
    await mkdir(dirname(path), { recursive: true });
    // A 0-byte file, as a disk-full/crash-mid-write or manual-edit residue
    // would leave behind.
    await writeFile(path, '', 'utf8');

    await expect(store.get(accountId)).resolves.toBeNull();

    const acquired = await store.acquire({
      accountId,
      wakeId: 'wake-after-torn',
      now: NOW,
      expiresAt: FUTURE_DEADLINE,
    });
    expect(acquired.wakeId).toBe('wake-after-torn');

    const raw = await readFile(path, 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});
