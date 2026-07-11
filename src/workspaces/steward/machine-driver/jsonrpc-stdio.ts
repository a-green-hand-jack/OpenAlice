/**
 * Minimal newline-delimited JSON-RPC client over a child process's stdio.
 *
 * codex app-server speaks a JSON-RPC-ish framing: one JSON object per line,
 * WITHOUT the `"jsonrpc": "2.0"` envelope field (the S0 capture confirms this).
 * We match that exactly — requests are `{ id, method, params }`, notifications
 * are `{ method, params? }`, responses are `{ id, result }` / `{ id, error }`,
 * and server→client requests carry both `id` and `method`.
 *
 * Zero deps beyond Node built-ins.
 */

import { StringDecoder } from 'node:string_decoder';

import type { Logger } from '../../logger.js';
import { MachineDriverProtocolError, type JsonRpcId, type MachineTransport } from './types.js';

export const NOOP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  event() {},
  child() {
    return NOOP_LOGGER;
  },
};

/** Answer sent to any server→client request when no handler overrides it.
 *  Under `approvalPolicy: 'never'` the server should not ask, but a stray
 *  request must never be left hanging — so we always deny and move on. */
const DEFAULT_DENIAL = { decision: 'denied' } as const;

type NotificationHandler = (method: string, params: unknown) => void;
type ServerRequestHandler = (method: string, params: unknown, id: JsonRpcId) => unknown;

export interface JsonRpcStdioClientOptions {
  readonly onNotification?: NotificationHandler;
  /** Return a value to answer a server→client request; return `undefined` to
   *  fall through to the default denial. */
  readonly onServerRequest?: ServerRequestHandler;
  /** Called once when the transport exits, after pending requests are rejected. */
  readonly onClose?: (error: Error) => void;
  readonly logger?: Logger;
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (result: unknown) => void;
  readonly reject: (err: Error) => void;
}

export class JsonRpcStdioClient {
  private readonly transport: MachineTransport;
  private readonly options: JsonRpcStdioClientOptions;
  private readonly logger: Logger;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly decoder = new StringDecoder('utf8');
  private nextId = 1;
  private buffer = '';
  private closed = false;
  private closeError: Error | null = null;

  constructor(transport: MachineTransport, options: JsonRpcStdioClientOptions = {}) {
    this.transport = transport;
    this.options = options;
    this.logger = options.logger ?? NOOP_LOGGER;
    transport.stdout.on('data', (chunk: Buffer | string) => this.onData(chunk));
    transport.stdout.on('error', (err: Error) => this.logger.warn('jsonrpc: stdout error', { err }));
    transport.on('exit', () => this.handleExit());
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(this.closeError ?? new MachineDriverProtocolError('transport closed'));
    }
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      try {
        this.writeMessage({ id, method, params });
      } catch (err) {
        this.pending.delete(id);
        reject(err instanceof Error ? err : new MachineDriverProtocolError(String(err)));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    const message = params === undefined ? { method } : { method, params };
    try {
      this.writeMessage(message);
    } catch (err) {
      this.logger.warn('jsonrpc: notify write failed', { method, err });
    }
  }

  isClosed(): boolean {
    return this.closed;
  }

  private writeMessage(message: unknown): void {
    this.transport.stdin.write(JSON.stringify(message) + '\n');
  }

  private onData(chunk: Buffer | string): void {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length > 0) this.dispatchLine(line);
      newline = this.buffer.indexOf('\n');
    }
  }

  private dispatchLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      // Unparseable-line tolerance: the app-server never emits garbage, but a
      // banner or partial flush must not take down the connection.
      this.logger.debug('jsonrpc: dropped unparseable line', { preview: line.slice(0, 200) });
      return;
    }
    if (typeof message !== 'object' || message === null) return;
    const m = message as {
      id?: JsonRpcId | null;
      method?: unknown;
      params?: unknown;
      result?: unknown;
      error?: unknown;
    };
    const hasId = m.id !== undefined && m.id !== null;
    const hasMethod = typeof m.method === 'string';
    if (hasMethod && hasId) {
      this.answerServerRequest(m.id as JsonRpcId, m.method as string, m.params);
    } else if (hasMethod) {
      this.options.onNotification?.(m.method as string, m.params);
    } else if (hasId) {
      this.settleResponse(m.id as JsonRpcId, m.result, m.error);
    }
  }

  private settleResponse(id: JsonRpcId, result: unknown, error: unknown): void {
    const pending = this.pending.get(id);
    if (!pending) {
      this.logger.debug('jsonrpc: response for unknown id', { id });
      return;
    }
    this.pending.delete(id);
    if (error !== undefined && error !== null) {
      const errObj = error as { message?: string };
      pending.reject(
        new MachineDriverProtocolError(`${pending.method} failed: ${errObj?.message ?? 'unknown error'}`),
      );
    } else {
      pending.resolve(result);
    }
  }

  private answerServerRequest(id: JsonRpcId, method: string, params: unknown): void {
    let result: unknown = DEFAULT_DENIAL;
    try {
      const handled = this.options.onServerRequest?.(method, params, id);
      if (handled !== undefined) result = handled;
    } catch (err) {
      this.logger.warn('jsonrpc: server-request handler threw; denying', { method, err });
    }
    try {
      this.writeMessage({ id, result });
    } catch (err) {
      this.logger.warn('jsonrpc: failed to answer server request', { method, err });
    }
  }

  private handleExit(): void {
    if (this.closed) return;
    this.closed = true;
    const err = new MachineDriverProtocolError('codex app-server process exited');
    this.closeError = err;
    const outstanding = [...this.pending.values()];
    this.pending.clear();
    for (const pending of outstanding) pending.reject(err);
    this.options.onClose?.(err);
  }
}
