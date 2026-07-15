/**
 * Codex context-telemetry reader (issue #132).
 *
 * `readLastTokenCount` streams a rollout JSONL and returns the LAST
 * `token_count` event's `input_tokens` / `model_context_window`;
 * `readCodexContextTelemetry` locates a session's rollout by cwd + id and reads
 * that tail. Fixtures are realistic MINIATURES modeled on a real codex rollout
 * (`payload.info.total_token_usage.input_tokens` + `payload.info
 * .model_context_window`), including the degenerate-turn shape where the tail
 * shows input_tokens past the window.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CODEX_OVERRIDE_MARKER_PATH, findCodexRolloutById, readCodexContextTelemetry, readLastTokenCount } from './codex.js';

/**
 * `readCodexContextTelemetry` resolves its scan root off the OpenAlice
 * override marker (issue #230), not ".codex/ exists" — so any test writing a
 * workspace-local rollout under `<cwd>/.codex/sessions` must also lay down
 * the marker, or the reader falls back to the (irrelevant, real) homedir.
 */
async function writeMarker(cwd: string): Promise<void> {
  const markerPath = join(cwd, CODEX_OVERRIDE_MARKER_PATH);
  await mkdir(dirname(markerPath), { recursive: true });
  await writeFile(markerPath, '', 'utf8');
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'codex-telemetry-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function tokenCountLine(inputTokens: number, modelContextWindow: number): string {
  return JSON.stringify({
    timestamp: '2026-07-10T19:28:03.955Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: inputTokens,
          cached_input_tokens: 0,
          output_tokens: 100,
          total_tokens: inputTokens + 100,
        },
        last_token_usage: { input_tokens: inputTokens },
        model_context_window: modelContextWindow,
      },
    },
  });
}

describe('readLastTokenCount', () => {
  it('returns the LAST token_count event, not the first', async () => {
    const fp = join(dir, 'rollout.jsonl');
    await writeFile(
      fp,
      [
        tokenCountLine(24345, 121600),
        JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', text: 'thinking' } }),
        tokenCountLine(125765, 121600),
        '',
      ].join('\n'),
      'utf8',
    );

    expect(await readLastTokenCount(fp)).toEqual({ inputTokens: 125765, modelContextWindow: 121600 });
  });

  it('reads the degenerate-turn tail where input_tokens exceeds the window', async () => {
    const fp = join(dir, 'rollout.jsonl');
    await writeFile(fp, `${tokenCountLine(125765, 121600)}\n`, 'utf8');

    const tail = await readLastTokenCount(fp);
    expect(tail).not.toBeNull();
    expect(tail!.inputTokens).toBeGreaterThan(tail!.modelContextWindow);
  });

  it('returns null for a missing file', async () => {
    expect(await readLastTokenCount(join(dir, 'nope.jsonl'))).toBeNull();
  });

  it('returns null when the rollout has no token_count events', async () => {
    const fp = join(dir, 'rollout.jsonl');
    await writeFile(
      fp,
      [
        JSON.stringify({ type: 'session_meta', payload: { id: 'x', cwd: '/tmp' } }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', text: 'hi' } }),
        '',
      ].join('\n'),
      'utf8',
    );

    expect(await readLastTokenCount(fp)).toBeNull();
  });

  it('skips a malformed token_count line and keeps the last GOOD one', async () => {
    const fp = join(dir, 'rollout.jsonl');
    await writeFile(
      fp,
      [
        tokenCountLine(24345, 121600),
        '{"type":"event_msg","payload":{"type":"token_count", BROKEN JSON',
        '',
      ].join('\n'),
      'utf8',
    );

    // The broken line is skipped; the last parseable token_count wins.
    expect(await readLastTokenCount(fp)).toEqual({ inputTokens: 24345, modelContextWindow: 121600 });
  });
});

/** Lay down `<cwd>/.codex/sessions/YYYY/MM/DD/rollout-<id>.jsonl` for today,
 *  with a session_meta line-1 attributing it to `sessionCwd` + `sessionId`. */
async function writeRollout(
  cwd: string,
  sessionId: string,
  sessionCwd: string,
  bodyLines: string[],
): Promise<void> {
  await writeRolloutAt(cwd, sessionId, sessionCwd, new Date(), bodyLines);
}

/** Same as {@link writeRollout} but at an explicit date, so tests can place a
 *  rollout in an OLDER dated leaf than "today" (issue #132 / PR #133 review:
 *  a steward session's rollout leaf is fixed at its OWN creation date, which
 *  can fall arbitrarily far behind "now" for a long-lived persistent
 *  session). */
async function writeRolloutAt(
  cwd: string,
  sessionId: string,
  sessionCwd: string,
  at: Date,
  bodyLines: string[],
): Promise<void> {
  const y = String(at.getFullYear());
  const m = String(at.getMonth() + 1).padStart(2, '0');
  const d = String(at.getDate()).padStart(2, '0');
  const leaf = join(cwd, '.codex', 'sessions', y, m, d);
  await mkdir(leaf, { recursive: true });
  const meta = JSON.stringify({
    type: 'session_meta',
    payload: { id: sessionId, cwd: sessionCwd },
  });
  await writeFile(
    join(leaf, `rollout-${y}-${m}-${d}T19-00-00-${sessionId}.jsonl`),
    [meta, ...bodyLines, ''].join('\n'),
    'utf8',
  );
}

describe('readCodexContextTelemetry', () => {
  it('returns the session rollout tail attributed to this cwd', async () => {
    await writeMarker(dir);
    await writeRollout(dir, 'sess-1', dir, [tokenCountLine(24345, 121600), tokenCountLine(80000, 121600)]);

    const tel = await readCodexContextTelemetry(dir, 'sess-1');
    expect(tel).not.toBeNull();
    expect(tel!.inputTokens).toBe(80000);
    expect(tel!.modelContextWindow).toBe(121600);
    expect(tel!.source).toContain('rollout-');
  });

  it('returns null when no rollout matches the sessionId', async () => {
    await writeMarker(dir);
    await writeRollout(dir, 'sess-1', dir, [tokenCountLine(24345, 121600)]);

    expect(await readCodexContextTelemetry(dir, 'other-session')).toBeNull();
  });

  it('returns null when the on-disk directory does not exist', async () => {
    await writeMarker(dir);
    expect(await readCodexContextTelemetry(dir, 'sess-1')).toBeNull();
  });

  it('returns null when there is no override marker, even if a workspace-local .codex/sessions rollout exists (issue #230)', async () => {
    // No marker written: the reader must NOT fall back to reading this
    // workspace-local rollout — it should resolve against the (irrelevant)
    // homedir root instead, exactly like composeEnv/listOnDisk now do.
    await writeRollout(dir, 'sess-1', dir, [tokenCountLine(24345, 121600)]);
    expect(await readCodexContextTelemetry(dir, 'sess-1')).toBeNull();
  });

  it(
    'finds the tracked session rollout in an OLDER dated leaf even when a newer ' +
      'foreign rollout exists (issue #132 PR #133 review — the old listOnDisk-based ' +
      '2-leaf window would miss this)',
    async () => {
      await writeMarker(dir);
      const threeMonthsAgo = new Date();
      threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

      // The TRACKED steward session's rollout — old, poisoned (past window).
      await writeRolloutAt(dir, 'steward-session', dir, threeMonthsAgo, [
        tokenCountLine(24345, 121600),
        tokenCountLine(125765, 121600),
      ]);
      // An unrelated, newer rollout in the SAME (global) root — simulates any
      // other codex session on the box writing today, which is what pushed
      // the tracked session's leaf outside the old 2-leaf window.
      await writeRollout(dir, 'unrelated-session', dir, [tokenCountLine(500, 121600)]);

      const tel = await readCodexContextTelemetry(dir, 'steward-session');
      expect(tel).not.toBeNull();
      expect(tel!.inputTokens).toBe(125765);
      expect(tel!.modelContextWindow).toBe(121600);
    },
  );

  it('finds a rollout across a year boundary (December -> January)', async () => {
    const target = resolve(dir);
    const root = join(dir, '.codex', 'sessions');
    // Simulate: tracked session created in a prior December, an unrelated
    // session exists in the following January (root's newest leaf).
    await writeRolloutAt(dir, 'dec-session', dir, new Date(2025, 11, 15), [
      tokenCountLine(50000, 121600),
    ]);
    await writeRolloutAt(dir, 'jan-session', dir, new Date(2026, 0, 3), [
      tokenCountLine(100, 121600),
    ]);

    const match = await findCodexRolloutById(root, target, 'dec-session');
    expect(match).not.toBeNull();
    expect(match!.sessionId).toBe('dec-session');
  });

  it('returns null once the maxLeaves cap is exhausted without finding the id', async () => {
    const target = resolve(dir);
    const root = join(dir, '.codex', 'sessions');
    const farBack = new Date();
    farBack.setFullYear(farBack.getFullYear() - 1);
    // A newer leaf (visited first, newest-first) that does NOT contain the
    // target id, plus the target's own much-older leaf — with the cap set to
    // exactly 1 leaf, only the newer non-matching one is ever examined.
    await writeRollout(dir, 'other-session', dir, [tokenCountLine(500, 121600)]);
    await writeRolloutAt(dir, 'ancient-session', dir, farBack, [tokenCountLine(1000, 121600)]);

    const match = await findCodexRolloutById(root, target, 'ancient-session', 1);
    expect(match).toBeNull();
  });
});
