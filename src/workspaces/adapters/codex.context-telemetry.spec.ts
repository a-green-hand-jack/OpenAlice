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
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readCodexContextTelemetry, readLastTokenCount } from './codex.js';

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
  const now = new Date();
  const y = String(now.getFullYear());
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const leaf = join(cwd, '.codex', 'sessions', y, m, d);
  await mkdir(leaf, { recursive: true });
  const meta = JSON.stringify({
    type: 'session_meta',
    payload: { id: sessionId, cwd: sessionCwd },
  });
  await writeFile(
    join(leaf, `rollout-2026-07-10T19-00-00-${sessionId}.jsonl`),
    [meta, ...bodyLines, ''].join('\n'),
    'utf8',
  );
}

describe('readCodexContextTelemetry', () => {
  it('returns the session rollout tail attributed to this cwd', async () => {
    await writeRollout(dir, 'sess-1', dir, [tokenCountLine(24345, 121600), tokenCountLine(80000, 121600)]);

    const tel = await readCodexContextTelemetry(dir, 'sess-1');
    expect(tel).not.toBeNull();
    expect(tel!.inputTokens).toBe(80000);
    expect(tel!.modelContextWindow).toBe(121600);
    expect(tel!.source).toContain('rollout-');
  });

  it('returns null when no rollout matches the sessionId', async () => {
    await writeRollout(dir, 'sess-1', dir, [tokenCountLine(24345, 121600)]);

    expect(await readCodexContextTelemetry(dir, 'other-session')).toBeNull();
  });

  it('returns null when the on-disk directory does not exist', async () => {
    expect(await readCodexContextTelemetry(dir, 'sess-1')).toBeNull();
  });
});
