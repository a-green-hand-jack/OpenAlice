import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { AUTOTRUST_SETTINGS_OBJECT } from '../../claude-autotrust-settings.js';
import {
  ClaudeAgentSdkDriver,
  SUPPORTED_CLAUDE_AGENT_SDK_VERSION,
  type ClaudeQueryFn,
} from './claude-agent-sdk-driver.js';
import { MachineDriverProtocolError, type DriverEvent } from './types.js';

const require_ = createRequire(import.meta.url);

// --- fake SDK query seam (CI never spawns real claude) ------------------------

/** Minimal `system/init` frame — the driver only reads `type` to mark the turn
 *  started, so the rest is inert fixture. */
function initMsg(sessionId: string, model?: string): SDKMessage {
  return {
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    ...(model !== undefined ? { model } : {}),
  } as unknown as SDKMessage;
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
    expect(opts.sandbox).toBeUndefined();
    expect(opts.settingSources).toBeUndefined();
    expect(opts.strictMcpConfig).toBeUndefined();

    // Liveness clears the moment the turn settles (no daemon).
    expect(driver.isThreadLive(threadId)).toBe(false);
  });

  it('forwards an explicit fail-closed sandbox without changing ordinary defaults', async () => {
    const { fn, captured } = makeFakeQuery({
      messages: [initMsg('s'), successResult({ sessionId: 's' })],
    });
    const sandbox: NonNullable<Options['sandbox']> = {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      network: {
        allowedDomains: [],
        deniedDomains: ['*'],
        allowUnixSockets: [],
        allowAllUnixSockets: false,
        allowLocalBinding: false,
      },
      filesystem: { allowWrite: ['/tmp/scratch'] },
    };
    const driver = new ClaudeAgentSdkDriver({
      cwd: '/tmp/scratch',
      queryFn: fn,
      sandbox,
      settingSources: [],
      strictMcpConfig: true,
      tools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
      skills: [],
    });
    const { threadId } = await driver.ensureThread({ cwd: '/tmp/scratch' });
    await driver.runTurn(threadId, 'x');

    expect(captured[0].options.sandbox).toEqual(sandbox);
    expect(captured[0].options.settingSources).toEqual([]);
    expect(captured[0].options.strictMcpConfig).toBe(true);
    expect(captured[0].options.tools).toEqual(['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep']);
    expect(captured[0].options.skills).toEqual([]);
  });

  it('surfaces a Bash audit-append failure as a fail-closed command event', async () => {
    const { fn } = makeFakeQuery({
      messages: [
        initMsg('s'),
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{
              type: 'tool_use',
              id: 'tool-bash-1',
              name: 'Bash',
              input: { command: 'git push' },
            }],
          },
          parent_tool_use_id: null,
          uuid: 'assistant-1',
          session_id: 's',
        } as unknown as SDKMessage,
        {
          type: 'user',
          message: {
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: 'tool-bash-1',
              is_error: true,
              content: 'D4_SMOKE_AUDIT_APPEND_FAILED EACCES',
            }],
          },
          parent_tool_use_id: null,
          session_id: 's',
        } as unknown as SDKMessage,
        successResult({ sessionId: 's' }),
      ],
    });
    const driver = makeDriver(fn);
    const { threadId } = await driver.ensureThread({ cwd: '/tmp/scratch' });
    const events: DriverEvent[] = [];

    await driver.runTurn(threadId, 'x', { onEvent: (event) => events.push(event) });

    expect(events).toContainEqual(expect.objectContaining({
      type: 'item-completed',
      itemType: 'commandExecution',
      command: 'git push',
      aggregatedOutput: 'D4_SMOKE_AUDIT_APPEND_FAILED EACCES',
      exitCode: 125,
    }));
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

  it('collects actual models from init, result usage keys, and fallback events', async () => {
    const usage = {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      contextWindow: 200_000,
    };
    const { fn } = makeFakeQuery({
      messages: [
        initMsg('s', 'claude-fable-5'),
        {
          type: 'system',
          subtype: 'model_refusal_fallback',
          original_model: 'claude-fable-5',
          fallback_model: 'claude-sonnet-5',
          session_id: 's',
        } as unknown as SDKMessage,
        successResult({ sessionId: 's', modelUsage: { 'claude-sonnet-5': usage } }),
      ],
    });
    const driver = makeDriver(fn);
    const { threadId } = await driver.ensureThread({ cwd: '/tmp/scratch', model: 'claude-fable-5' });

    const outcome = await driver.runTurn(threadId, 'x', { model: 'claude-fable-5' });
    expect(outcome.actualModelIds).toEqual(['claude-fable-5', 'claude-sonnet-5']);
  });

  it('forwards cwd + the auto-trust settings, and passes a composed env EXACTLY (issue #146 S5 review MAJOR-1)', async () => {
    const { fn, captured } = makeFakeQuery({
      messages: [initMsg('s'), successResult({ sessionId: 's' })],
    });
    // A `buildSpawnEnv`-style composed env: complete (rebuilt PATH, HOME) and
    // WITHOUT Alice-internal secrets — `buildSpawnEnv` deletes those, it never
    // just leaves them empty. This is what `composeSpawnInputs` actually hands
    // the driver in production.
    const composedEnv = {
      PATH: '/composed/bin:/usr/bin',
      HOME: '/home/steward',
      AQ_WS_ID: 'ws-42',
      OPENALICE_TOOL_URL: 'http://127.0.0.1:1',
    };
    // Seed the PARENT process env with a secret `buildSpawnEnv` would have
    // stripped, to prove the driver never resurrects it by spreading
    // `process.env` underneath the composed env.
    const priorToken = process.env['OPENALICE_UTA_INTERNAL_TOKEN'];
    process.env['OPENALICE_UTA_INTERNAL_TOKEN'] = 'super-secret-broker-token';
    try {
      const driver = makeDriver(fn, composedEnv);
      const { threadId } = await driver.ensureThread({ cwd: '/tmp/scratch' });
      await driver.runTurn(threadId, 'x');

      const opts = captured[0].options;
      expect(opts.cwd).toBe('/tmp/scratch');
      // The composed env is passed through EXACTLY, not merged with process.env.
      expect(opts.env).toEqual(composedEnv);
      // PATH survives because it's part of the PROVIDED (composed) env, not
      // because process.env leaked in underneath it.
      expect(opts.env?.['PATH']).toBe('/composed/bin:/usr/bin');
      // The Alice-internal secret present in the parent process env must NOT
      // reach the unattended claude child — this is the security boundary the
      // alice*/tool-gateway relies on.
      expect(opts.env?.['OPENALICE_UTA_INTERNAL_TOKEN']).toBeUndefined();
    } finally {
      if (priorToken === undefined) delete process.env['OPENALICE_UTA_INTERNAL_TOKEN'];
      else process.env['OPENALICE_UTA_INTERNAL_TOKEN'] = priorToken;
    }
  });

  it('omits Options.env entirely when no env is supplied, letting the SDK inherit process.env itself', async () => {
    const { fn, captured } = makeFakeQuery({
      messages: [initMsg('s'), successResult({ sessionId: 's' })],
    });
    const driver = makeDriver(fn); // no env passed to the driver at all
    const { threadId } = await driver.ensureThread({ cwd: '/tmp/scratch' });
    await driver.runTurn(threadId, 'x');

    // `env` key must be ABSENT (not `env: undefined` as an explicit key, and
    // certainly not `env: {}`) — verified against the SDK: a destructured
    // `Options.env` default of `{...process.env}` fires whenever the value is
    // `undefined`, so omitting the key is what actually triggers inheritance.
    expect('env' in captured[0].options).toBe(false);
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

/**
 * Contract-drift guard (issue #146 S5 review minor), mirroring the codex
 * driver's `SUPPORTED_CODEX_VERSION` pin discipline
 * (`protocol-contract.spec.ts`): the driver hand-maps `Options`/`SDKMessage`
 * shapes it read from the SDK's `.d.ts` at implementation time. If the
 * installed `@anthropic-ai/claude-agent-sdk` is ever bumped without a matching
 * driver review, this fails loudly instead of the driver silently drifting
 * out of sync with the actual wire shapes.
 */
describe('claude-agent-sdk version pin', () => {
  it('pins SUPPORTED_CLAUDE_AGENT_SDK_VERSION to the installed package version', () => {
    // The package's `exports` map has no `./package.json` subpath, so resolve
    // the main entry (`.` -> sdk.mjs) and read package.json from its directory.
    const entry = require_.resolve('@anthropic-ai/claude-agent-sdk');
    const pkg = JSON.parse(readFileSync(join(dirname(entry), 'package.json'), 'utf8')) as { version: string };
    expect(pkg.version).toBe(SUPPORTED_CLAUDE_AGENT_SDK_VERSION);
  });
});
