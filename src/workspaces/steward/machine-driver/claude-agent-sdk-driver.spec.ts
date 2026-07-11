import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { AUTOTRUST_SETTINGS_OBJECT } from '../../adapters/claude.js';
import { ClaudeAgentSdkDriver, type ClaudeQueryFn } from './claude-agent-sdk-driver.js';
import { MachineDriverProtocolError, type DriverEvent } from './types.js';

// --- fake SDK query seam (CI never spawns real claude) ------------------------

/** Minimal `system/init` frame — the driver only reads `type` to mark the turn
 *  started, so the rest is inert fixture. */
function initMsg(sessionId: string): SDKMessage {
  return { type: 'system', subtype: 'init', session_id: sessionId } as unknown as SDKMessage;
}

interface ModelUsageLike {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  contextWindow: number;
}

function successResult(opts: {
  sessionId: string;
  text?: string;
  modelUsage?: Record<string, ModelUsageLike>;
  durationMs?: number;
}): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: opts.durationMs ?? 1234,
    result: opts.text ?? 'DONE',
    modelUsage: opts.modelUsage ?? {},
    session_id: opts.sessionId,
  } as unknown as SDKMessage;
}

function errorResult(subtype: string, errors: string[]): SDKMessage {
  return {
    type: 'result',
    subtype,
    duration_ms: 42,
    modelUsage: {},
    errors,
    session_id: 'sess',
  } as unknown as SDKMessage;
}

interface QueryScript {
  /** Messages yielded in order before any hang. */
  readonly messages?: SDKMessage[];
  /** After yielding `messages`, block until the abort signal fires. */
  readonly hangUntilAbort?: boolean;
  /** When hanging, end the stream CLEANLY on abort (default: throw AbortError). */
  readonly endCleanlyOnAbort?: boolean;
}

function makeFakeQuery(script: QueryScript): {
  fn: ClaudeQueryFn;
  captured: { prompt: string; options: Options }[];
} {
  const captured: { prompt: string; options: Options }[] = [];
  const fn: ClaudeQueryFn = ({ prompt, options }) => {
    captured.push({ prompt, options });
    return (async function* () {
      for (const m of script.messages ?? []) yield m;
      if (script.hangUntilAbort) {
        const signal = options.abortController?.signal;
        await new Promise<void>((resolve, reject) => {
          const settle = (): void =>
            script.endCleanlyOnAbort ? resolve() : reject(new Error('The operation was aborted'));
          if (signal?.aborted) return settle();
          signal?.addEventListener('abort', settle, { once: true });
        });
      }
    })();
  };
  return { fn, captured };
}

/**
 * A query fake that echoes the pinned session id back through init + a success
 * result — used where a test needs to assert `sessionId` vs `resume` across
 * turns. Captures each invocation's options.
 */
function makeEchoQuery(): { fn: ClaudeQueryFn; captured: { prompt: string; options: Options }[] } {
  const captured: { prompt: string; options: Options }[] = [];
  const fn: ClaudeQueryFn = ({ prompt, options }) => {
    captured.push({ prompt, options });
    const sessionId = (options.sessionId ?? options.resume ?? 'sess') as string;
    return (async function* () {
      yield initMsg(sessionId);
      yield successResult({ sessionId, text: 'HELLO' });
    })();
  };
  return { fn, captured };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

function makeDriver(fn: ClaudeQueryFn, env?: Record<string, string>): ClaudeAgentSdkDriver {
  return new ClaudeAgentSdkDriver({ cwd: '/tmp/scratch', ...(env ? { env } : {}), queryFn: fn });
}

describe('ClaudeAgentSdkDriver', () => {
  it('pins a fresh session id up front and runs a turn via sessionId (not resume)', async () => {
    const { fn, captured } = makeEchoQuery();
    const driver = makeDriver(fn);

    const { threadId, resumed } = await driver.ensureThread({ cwd: '/tmp/scratch' });
    expect(resumed).toBe(false);
    expect(threadId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

    const events: DriverEvent[] = [];
    const outcome = await driver.runTurn(threadId, 'do it', { onEvent: (e) => events.push(e) });

    expect(outcome.status).toBe('completed');
    expect(outcome.turnId).toBeTruthy();
    expect(outcome.agentMessage).toBe('HELLO');
    expect(outcome.interrupted).toBe(false);
    expect(outcome.durationMs).toBe(1234);
    expect(events.map((e) => e.type)).toContain('turn-started');

    // FIRST turn pins the id via sessionId; resume is absent.
    const opts = captured[captured.length - 1].options;
    expect(opts.sessionId).toBe(threadId);
    expect(opts.resume).toBeUndefined();
    // Unattended permission surface: same auto-trust settings, dontAsk (not bypass).
    expect(opts.settings).toBe(AUTOTRUST_SETTINGS_OBJECT);
    expect(opts.permissionMode).toBe('dontAsk');

    // Liveness clears the moment the turn settles (no daemon).
    expect(driver.isThreadLive(threadId)).toBe(false);
  });

  it('resumes a prior-process thread via resume and reports resumed:true', async () => {
    const { fn, captured } = makeFakeQuery({
      messages: [initMsg('prior'), successResult({ sessionId: 'prior' })],
    });
    const driver = makeDriver(fn);

    const result = await driver.ensureThread({ threadId: 'prior-thread-id', cwd: '/tmp/scratch' });
    expect(result).toEqual({ threadId: 'prior-thread-id', resumed: true });

    await driver.runTurn('prior-thread-id', 'x');
    const opts = captured[0].options;
    expect(opts.resume).toBe('prior-thread-id');
    expect(opts.sessionId).toBeUndefined();
  });

  it("a fresh thread's second turn resumes (session now exists on disk)", async () => {
    const { fn, captured } = makeEchoQuery();
    const driver = makeDriver(fn);

    const { threadId } = await driver.ensureThread({ cwd: '/tmp/scratch' });
    await driver.runTurn(threadId, 'first');
    await driver.runTurn(threadId, 'second');

    expect(captured[0].options.sessionId).toBe(threadId);
    expect(captured[0].options.resume).toBeUndefined();
    expect(captured[1].options.resume).toBe(threadId);
    expect(captured[1].options.sessionId).toBeUndefined();
  });

  it('maps SDK model usage into telemetry, including the context window', async () => {
    const modelUsage = {
      'claude-opus-4-8': {
        inputTokens: 1000,
        outputTokens: 50,
        cacheReadInputTokens: 200,
        cacheCreationInputTokens: 100,
        contextWindow: 200_000,
      },
    };
    const { fn } = makeFakeQuery({
      messages: [initMsg('s'), successResult({ sessionId: 's', modelUsage })],
    });
    const driver = makeDriver(fn);
    const { threadId } = await driver.ensureThread({ cwd: '/tmp/scratch' });

    const events: DriverEvent[] = [];
    await driver.runTurn(threadId, 'x', { onEvent: (e) => events.push(e) });

    const telemetry = driver.readTelemetry(threadId);
    expect(telemetry?.inputTokens).toBe(1300); // 1000 + 200 cacheRead + 100 cacheCreation
    expect(telemetry?.cachedInputTokens).toBe(200);
    expect(telemetry?.outputTokens).toBe(50);
    expect(telemetry?.totalTokens).toBe(1350);
    expect(telemetry?.contextWindow).toBe(200_000);
    expect(events.some((e) => e.type === 'token-usage')).toBe(true);
  });

  it('forwards cwd + env (spread over process.env) and the auto-trust settings', async () => {
    const { fn, captured } = makeFakeQuery({
      messages: [initMsg('s'), successResult({ sessionId: 's' })],
    });
    const driver = makeDriver(fn, { AQ_WS_ID: 'ws-42', OPENALICE_TOOL_URL: 'http://127.0.0.1:1' });
    const { threadId } = await driver.ensureThread({ cwd: '/tmp/scratch' });
    await driver.runTurn(threadId, 'x');

    const opts = captured[0].options;
    expect(opts.cwd).toBe('/tmp/scratch');
    expect(opts.env?.['AQ_WS_ID']).toBe('ws-42');
    expect(opts.env?.['OPENALICE_TOOL_URL']).toBe('http://127.0.0.1:1');
    // process.env survives the REPLACE-not-merge semantics because we spread it.
    expect(opts.env?.['PATH']).toBe(process.env['PATH']);
  });

  it('interrupts a turn that overruns its deadline and resolves interrupted', async () => {
    const { fn } = makeFakeQuery({ messages: [initMsg('s')], hangUntilAbort: true });
    const driver = makeDriver(fn);
    const { threadId } = await driver.ensureThread({ cwd: '/tmp/scratch' });

    const outcome = await driver.runTurn(threadId, 'slow', { deadlineMs: 30 });

    expect(outcome.interrupted).toBe(true);
    expect(outcome.status).toBe('interrupted');
    // Every settle clears liveness for this driver (by construction).
    expect(driver.isThreadLive(threadId)).toBe(false);
  });

  it('interruptInFlight aborts the running turn, settling it interrupted (clean stream end)', async () => {
    const { fn } = makeFakeQuery({
      messages: [initMsg('s')],
      hangUntilAbort: true,
      endCleanlyOnAbort: true,
    });
    const driver = makeDriver(fn);
    const { threadId } = await driver.ensureThread({ cwd: '/tmp/scratch' });

    const pending = driver.runTurn(threadId, 'slow');
    await flush(); // let the turn start iterating and hang
    expect(driver.isThreadLive(threadId)).toBe(true);

    await driver.interruptInFlight(threadId);
    const outcome = await pending;

    expect(outcome.interrupted).toBe(true);
    expect(outcome.status).toBe('interrupted');
    expect(driver.isThreadLive(threadId)).toBe(false);
  });

  it('interruptInFlight is a no-op when nothing is in flight', async () => {
    const { fn } = makeFakeQuery({ messages: [initMsg('s'), successResult({ sessionId: 's' })] });
    const driver = makeDriver(fn);
    const { threadId } = await driver.ensureThread({ cwd: '/tmp/scratch' });
    await expect(driver.interruptInFlight(threadId)).resolves.toBeUndefined();
  });

  it('rejects with a protocol error and clears liveness on a fatal result error', async () => {
    const { fn } = makeFakeQuery({
      messages: [initMsg('s'), errorResult('error_during_execution', ['kaboom'])],
    });
    const driver = makeDriver(fn);
    const { threadId } = await driver.ensureThread({ cwd: '/tmp/scratch' });

    const err = await driver.runTurn(threadId, 'x').then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MachineDriverProtocolError);
    expect(String((err as Error).message)).toContain('kaboom');
    expect(driver.isThreadLive(threadId)).toBe(false);
  });

  it('rejects a concurrent runTurn on the same thread', async () => {
    const { fn } = makeFakeQuery({ messages: [initMsg('s')], hangUntilAbort: true });
    const driver = makeDriver(fn);
    const { threadId } = await driver.ensureThread({ cwd: '/tmp/scratch' });

    const first = driver.runTurn(threadId, 'a');
    await flush();
    await expect(driver.runTurn(threadId, 'b')).rejects.toThrow(/already in flight/);

    await driver.dispose();
    await expect(first).rejects.toBeInstanceOf(MachineDriverProtocolError);
  });

  it('dispose mid-turn rejects the in-flight turn as a driver-disposed error', async () => {
    const { fn } = makeFakeQuery({ messages: [initMsg('s')], hangUntilAbort: true });
    const driver = makeDriver(fn);
    const { threadId } = await driver.ensureThread({ cwd: '/tmp/scratch' });

    const pending = driver.runTurn(threadId, 'x');
    await flush();
    expect(driver.isHealthy()).toBe(true);
    await driver.dispose();

    const err = await pending.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MachineDriverProtocolError);
    expect(String((err as Error).message)).toContain('disposed');
    expect(driver.isHealthy()).toBe(false);
  });

  it('ensureThread on a disposed driver throws', async () => {
    const { fn } = makeFakeQuery({});
    const driver = makeDriver(fn);
    await driver.dispose();
    await expect(driver.ensureThread({ cwd: '/tmp/scratch' })).rejects.toBeInstanceOf(MachineDriverProtocolError);
  });
});
