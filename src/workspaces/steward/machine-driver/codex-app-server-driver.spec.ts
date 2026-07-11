import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { CodexAppServerDriver } from './codex-app-server-driver.js';
import { MachineDriverProtocolError, type DriverEvent, type JsonRpcId, type MachineTransport } from './types.js';

// Real thread/turn ids lifted from fixtures/transcripts/single-turn.jsonl so the
// fake server's wire shapes match a real capture.
const THREAD_ID = '019f5085-2c8f-7aa3-80c4-cadd52943a77';
const TURN_ID = '019f5085-2e1a-7be3-aaad-300c511507cb';

interface WireMessage {
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

/**
 * A fake `codex app-server` speaking the newline-delimited JSON-RPC wire over
 * PassThrough streams — no real spawn (CI has no codex login). Tests set
 * `onMessage` (usually via {@link respondHandshake}) to script server behavior.
 */
class FakeCodexServer {
  readonly toServer = new PassThrough(); // driver stdin  (client -> server)
  readonly toClient = new PassThrough(); // driver stdout (server -> client)
  private buffer = '';
  private readonly exitListeners: Array<() => void> = [];
  onMessage: (msg: WireMessage, server: FakeCodexServer) => void = () => {};

  constructor() {
    this.toServer.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      let nl = this.buffer.indexOf('\n');
      while (nl >= 0) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (line) this.onMessage(JSON.parse(line) as WireMessage, this);
        nl = this.buffer.indexOf('\n');
      }
    });
  }

  send(message: unknown): void {
    this.toClient.write(JSON.stringify(message) + '\n');
  }

  reply(id: JsonRpcId, result: unknown): void {
    this.send({ id, result });
  }

  transport(): MachineTransport {
    return {
      stdin: this.toServer,
      stdout: this.toClient,
      on: (event, listener) => {
        if (event === 'exit') this.exitListeners.push(listener as () => void);
      },
      kill: () => {
        this.exit();
        return true;
      },
    };
  }

  exit(): void {
    for (const listener of [...this.exitListeners]) listener();
  }
}

interface HandshakeScript {
  threadId?: string;
  resumeThreadId?: string;
  turnId?: string;
  onTurnStart?: (msg: WireMessage, server: FakeCodexServer) => void;
  onTurnInterrupt?: (msg: WireMessage, server: FakeCodexServer) => void;
  onResponse?: (msg: WireMessage, server: FakeCodexServer) => void;
}

/** Wire the fake to auto-answer initialize / thread / turn requests. */
function respondHandshake(server: FakeCodexServer, script: HandshakeScript = {}): void {
  server.onMessage = (msg, srv) => {
    // A message with an id but no method is a client->server RESPONSE (e.g.
    // answering a server request) — nothing to reply to.
    if (msg.method === undefined) {
      script.onResponse?.(msg, srv);
      return;
    }
    switch (msg.method) {
      case 'initialize':
        srv.reply(msg.id as JsonRpcId, {
          userAgent: 'fake/0.144.0',
          codexHome: '/tmp',
          platformFamily: 'unix',
          platformOs: 'linux',
        });
        return;
      case 'initialized':
        return;
      case 'thread/start':
        srv.reply(msg.id as JsonRpcId, { thread: { id: script.threadId ?? THREAD_ID } });
        return;
      case 'thread/resume': {
        const requested = (msg.params?.threadId as string | undefined) ?? THREAD_ID;
        srv.reply(msg.id as JsonRpcId, { thread: { id: script.resumeThreadId ?? requested } });
        return;
      }
      case 'turn/start':
        srv.reply(msg.id as JsonRpcId, { turn: { id: script.turnId ?? TURN_ID, status: 'inProgress' } });
        script.onTurnStart?.(msg, srv);
        return;
      case 'turn/interrupt':
        srv.reply(msg.id as JsonRpcId, {});
        script.onTurnInterrupt?.(msg, srv);
        return;
      default:
        if (msg.id !== undefined) srv.reply(msg.id, {});
    }
  };
}

function sendTurnStarted(server: FakeCodexServer): void {
  server.send({
    method: 'turn/started',
    params: { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'inProgress' } },
  });
}

function sendAgentMessage(server: FakeCodexServer, text: string): void {
  server.send({
    method: 'item/completed',
    params: {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      item: { type: 'agentMessage', id: 'msg_1', text, phase: 'final_answer' },
    },
  });
}

function sendTokenUsage(server: FakeCodexServer): void {
  server.send({
    method: 'thread/tokenUsage/updated',
    params: {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      tokenUsage: {
        total: { totalTokens: 20201, inputTokens: 20116, cachedInputTokens: 1920, outputTokens: 85, reasoningOutputTokens: 11 },
        last: { totalTokens: 20201, inputTokens: 20116, cachedInputTokens: 1920, outputTokens: 85, reasoningOutputTokens: 11 },
        modelContextWindow: 258400,
      },
    },
  });
}

function sendTurnCompleted(server: FakeCodexServer, status: string, durationMs: number | null = 11695): void {
  server.send({
    method: 'turn/completed',
    params: { threadId: THREAD_ID, turn: { id: TURN_ID, items: [], status, error: null, durationMs } },
  });
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

function makeDriver(server: FakeCodexServer): CodexAppServerDriver {
  return new CodexAppServerDriver({ cwd: '/tmp/scratch', spawn: () => server.transport() });
}

describe('CodexAppServerDriver', () => {
  it('runs a turn to completion, capturing the agent message and telemetry', async () => {
    const server = new FakeCodexServer();
    respondHandshake(server, {
      onTurnStart: (_msg, srv) => {
        sendTurnStarted(srv);
        sendAgentMessage(srv, 'DONE');
        sendTokenUsage(srv);
        sendTurnCompleted(srv, 'completed');
      },
    });
    const driver = makeDriver(server);

    const { threadId, resumed } = await driver.ensureThread({ cwd: '/tmp/scratch' });
    expect(resumed).toBe(false);
    expect(threadId).toBe(THREAD_ID);

    const events: DriverEvent[] = [];
    const outcome = await driver.runTurn(threadId, 'do the thing', { effort: 'low', onEvent: (e) => events.push(e) });

    expect(outcome.status).toBe('completed');
    expect(outcome.turnId).toBe(TURN_ID);
    expect(outcome.agentMessage).toBe('DONE');
    expect(outcome.interrupted).toBe(false);
    expect(outcome.durationMs).toBe(11695);

    const telemetry = driver.readTelemetry(threadId);
    expect(telemetry?.totalTokens).toBe(20201);
    expect(telemetry?.inputTokens).toBe(20116);
    expect(telemetry?.cachedInputTokens).toBe(1920);
    expect(telemetry?.outputTokens).toBe(85);
    expect(telemetry?.contextWindow).toBe(258400);
    expect(events.map((e) => e.type)).toContain('token-usage');
    expect(driver.isThreadLive(threadId)).toBe(true);

    await driver.dispose();
    expect(driver.isThreadLive(threadId)).toBe(false);
  });

  it('resumes an existing thread and reports resumed:true', async () => {
    const server = new FakeCodexServer();
    respondHandshake(server, { resumeThreadId: THREAD_ID });
    const driver = makeDriver(server);

    const result = await driver.ensureThread({ threadId: THREAD_ID, cwd: '/tmp/scratch' });
    expect(result).toEqual({ threadId: THREAD_ID, resumed: true });

    await driver.dispose();
  });

  it('rejects the turn when an error notification is non-retryable', async () => {
    const server = new FakeCodexServer();
    respondHandshake(server, {
      onTurnStart: (_msg, srv) => {
        srv.send({
          method: 'error',
          params: { error: { message: 'boom' }, threadId: THREAD_ID, turnId: TURN_ID, willRetry: false },
        });
      },
    });
    const driver = makeDriver(server);

    const { threadId } = await driver.ensureThread({ cwd: '/tmp/scratch' });
    const err = await driver.runTurn(threadId, 'x').then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MachineDriverProtocolError);
    expect(String((err as Error).message)).toContain('boom');

    await driver.dispose();
  });

  it('keeps waiting after a retryable error and resolves on completion', async () => {
    const server = new FakeCodexServer();
    respondHandshake(server, {
      onTurnStart: (_msg, srv) => {
        srv.send({
          method: 'error',
          params: { error: { message: 'transient' }, threadId: THREAD_ID, turnId: TURN_ID, willRetry: true },
        });
        sendAgentMessage(srv, 'RECOVERED');
        sendTurnCompleted(srv, 'completed');
      },
    });
    const driver = makeDriver(server);

    const { threadId } = await driver.ensureThread({ cwd: '/tmp/scratch' });
    const events: DriverEvent[] = [];
    const outcome = await driver.runTurn(threadId, 'x', { onEvent: (e) => events.push(e) });

    expect(outcome.status).toBe('completed');
    expect(outcome.agentMessage).toBe('RECOVERED');
    expect(events.some((e) => e.type === 'error-notification' && e.willRetry === true)).toBe(true);

    await driver.dispose();
  });

  it('default-denies a server->client request and still completes the turn', async () => {
    const server = new FakeCodexServer();
    const answered: unknown[] = [];
    respondHandshake(server, {
      onTurnStart: (_msg, srv) => {
        // Server asks the client to approve something (has id + method).
        srv.send({ id: 999, method: 'thread/shellCommand', params: { threadId: THREAD_ID } });
        sendTurnCompleted(srv, 'completed');
      },
      onResponse: (msg) => {
        if (msg.id === 999) answered.push(msg.result);
      },
    });
    const driver = makeDriver(server);

    const { threadId } = await driver.ensureThread({ cwd: '/tmp/scratch' });
    const events: DriverEvent[] = [];
    const outcome = await driver.runTurn(threadId, 'x', { onEvent: (e) => events.push(e) });
    await flush();

    expect(outcome.status).toBe('completed');
    expect(answered).toEqual([{ decision: 'denied' }]);
    expect(events.some((e) => e.type === 'server-request-denied' && e.method === 'thread/shellCommand')).toBe(true);

    await driver.dispose();
  });

  it('interrupts a turn that overruns its deadline and resolves interrupted', async () => {
    const server = new FakeCodexServer();
    let interruptReceived = false;
    respondHandshake(server, {
      // Turn never completes on its own — only the deadline can settle it.
      onTurnInterrupt: (_msg, srv) => {
        interruptReceived = true;
        sendTurnCompleted(srv, 'interrupted');
      },
    });
    const driver = makeDriver(server);

    const { threadId } = await driver.ensureThread({ cwd: '/tmp/scratch' });
    const outcome = await driver.runTurn(threadId, 'slow', { deadlineMs: 30 });

    expect(interruptReceived).toBe(true);
    expect(outcome.interrupted).toBe(true);
    expect(outcome.status).toBe('interrupted');

    await driver.dispose();
  });

  it('rejects a concurrent runTurn on the same thread', async () => {
    const server = new FakeCodexServer();
    respondHandshake(server, {}); // first turn is left in flight
    const driver = makeDriver(server);

    const { threadId } = await driver.ensureThread({ cwd: '/tmp/scratch' });
    const first = driver.runTurn(threadId, 'a');

    await expect(driver.runTurn(threadId, 'b')).rejects.toThrow(/already in flight/);

    await driver.dispose();
    await expect(first).rejects.toBeInstanceOf(MachineDriverProtocolError);
  });

  it('rejects the in-flight turn when the app-server exits', async () => {
    const server = new FakeCodexServer();
    respondHandshake(server, {}); // turn/start resolves, turn never completes
    const driver = makeDriver(server);

    const { threadId } = await driver.ensureThread({ cwd: '/tmp/scratch' });
    const pending = driver.runTurn(threadId, 'x');
    await flush(); // let turn/start resolve and the waiter arm

    server.exit();

    const err = await pending.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MachineDriverProtocolError);
    expect(String((err as Error).message)).toContain('exited');

    await driver.dispose();
  });

  it('rejects cleanly when the app-server exits while turn/start is in flight', async () => {
    const server = new FakeCodexServer();
    respondHandshake(server);
    const inner = server.onMessage;
    server.onMessage = (msg, srv) => {
      // Die before answering turn/start — the waiter is armed but the request
      // is still pending, so the rejection must be consumed exactly once.
      if (msg.method === 'turn/start') {
        srv.exit();
        return;
      }
      inner(msg, srv);
    };
    const driver = makeDriver(server);
    const { threadId } = await driver.ensureThread({ cwd: '/tmp/scratch' });

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      await expect(driver.runTurn(threadId, 'x')).rejects.toBeInstanceOf(MachineDriverProtocolError);
      await flush(); // give an orphaned rejection a tick to surface
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    await driver.dispose();
  });

  it('rejects cleanly when dispose() runs while turn/start is in flight', async () => {
    const server = new FakeCodexServer();
    respondHandshake(server);
    const inner = server.onMessage;
    server.onMessage = (msg, srv) => {
      if (msg.method === 'turn/start') return; // never answer
      inner(msg, srv);
    };
    const driver = makeDriver(server);
    const { threadId } = await driver.ensureThread({ cwd: '/tmp/scratch' });

    const pending = driver.runTurn(threadId, 'x');
    await flush(); // turn/start sent, response never arrives
    await driver.dispose();

    await expect(pending).rejects.toBeInstanceOf(MachineDriverProtocolError);
  });
});
