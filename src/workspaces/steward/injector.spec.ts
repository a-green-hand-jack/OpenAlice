/**
 * injectStewardWake — two-phase submit (issue #91).
 *
 * Ink-based interactive TUIs (Claude Code, Codex) treat a single burst
 * write containing embedded newlines as a paste and never submit it. The
 * fix is to write the message body, then — after a short settle delay —
 * write a bare `\r` in a SEPARATE call, which is what actually submits the
 * pending composer contents. These tests assert the two-write shape and
 * ordering against a mocked SessionPool; they cannot exercise real TUI
 * input handling (see docs/uta-live-testing.md-style live verification for
 * that), so this is a regression guard for the write-count/order contract.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionPool } from '../session-pool.js';
import type { StewardWakeRecord } from './types.js';
import {
  formatStewardWakeMessage,
  injectStewardWake,
  STEWARD_WAKE_SUBMIT_DELAY_MS,
} from './injector.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const record: StewardWakeRecord = {
  version: 1,
  wakeId: 'wake-1',
  status: 'queued',
  createdAt: '2026-07-08T14:00:00.000Z',
  injectedAt: null,
  deadline: '2026-07-08T14:03:00.000Z',
  sessionId: null,
  controlFace: 'pty',
  envelope: {
    version: 2,
    reason: 'scheduled_observe',
    accountId: 'mock-simulator-1',
    authzLevel: 'paper',
    expectedDecision: 'no_trade',
    snapshotRef: {
      snapshotId: 'snap:wake-1',
      sha256: '0'.repeat(64),
      path: '.alice/steward/snapshots/wake-1.json',
      asOf: '2026-07-08T14:00:00.000Z',
    },
  },
};

function fakePool(opts: { writable?: readonly boolean[] } = {}) {
  const writable = opts.writable ?? [true, true];
  let call = 0;
  const calls: Array<{ sessionId: string; input: string | Buffer; opts: unknown }> = [];
  const writeToSession = vi.fn((sessionId: string, input: string | Buffer, writeOpts: unknown) => {
    const ok = writable[Math.min(call, writable.length - 1)] ?? true;
    call += 1;
    calls.push({ sessionId, input, opts: writeOpts });
    return ok;
  });
  return { pool: { writeToSession } as unknown as SessionPool, calls };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('injectStewardWake', () => {
  it('writes the message body, waits the submit-gap, then writes a bare \\r in a second call', async () => {
    const { pool, calls } = fakePool();

    const resultPromise = injectStewardWake({ pool, sessionId: 'sess-1', record });
    await vi.advanceTimersByTimeAsync(STEWARD_WAKE_SUBMIT_DELAY_MS);
    const result = await resultPromise;

    expect(result).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      sessionId: 'sess-1',
      input: formatStewardWakeMessage(record),
      opts: { source: 'steward-supervisor' },
    });
    expect(calls[1]).toEqual({
      sessionId: 'sess-1',
      input: '\r',
      opts: { source: 'steward-supervisor' },
    });
  });

  it('does not write the follow-up \\r before the submit-gap elapses', async () => {
    const { pool, calls } = fakePool();

    const resultPromise = injectStewardWake({ pool, sessionId: 'sess-1', record });
    await vi.advanceTimersByTimeAsync(STEWARD_WAKE_SUBMIT_DELAY_MS - 1);
    expect(calls).toHaveLength(1); // body written, \r not yet due

    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    await resultPromise;
  });

  it('returns false immediately without writing \\r when the session is gone (body write fails)', async () => {
    const { pool, calls } = fakePool({ writable: [false] });

    const result = await injectStewardWake({ pool, sessionId: 'missing', record });

    expect(result).toBe(false);
    expect(calls).toHaveLength(1); // only the (failed) body write attempt
  });

  it('returns false if the session disappears between the body write and the \\r', async () => {
    const { pool, calls } = fakePool({ writable: [true, false] });

    const resultPromise = injectStewardWake({ pool, sessionId: 'sess-1', record });
    await vi.advanceTimersByTimeAsync(STEWARD_WAKE_SUBMIT_DELAY_MS);
    const result = await resultPromise;

    expect(result).toBe(false);
    expect(calls).toHaveLength(2);
  });
});

describe('formatStewardWakeMessage', () => {
  it('carries mechanics but leaves act-vs-record-only policy to the workspace instruction (issue #251)', () => {
    const message = formatStewardWakeMessage(record);

    expect(message).not.toContain('actions is [] and pendingHash is null');
    expect(message).not.toContain('broker mutation');
    expect(message).toContain('node .alice/steward/validate-ledger.mjs');
    expect(message).toContain('Do not inspect OpenAlice source. Do not call push.');
  });
});
