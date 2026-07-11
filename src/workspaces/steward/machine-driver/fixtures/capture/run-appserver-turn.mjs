#!/usr/bin/env node
// S0 spike: drive one codex app-server turn end-to-end over stdio JSON-RPC.
// Captures the full wire transcript (both directions) to transcript.jsonl.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const SCRATCH = '/tmp/s0-scratch';
const OUT = '/tmp/s0-spike/transcript.jsonl';
mkdirSync(SCRATCH, { recursive: true });
writeFileSync(`${SCRATCH}/notes.txt`, [
  'OpenAlice S0 spike scratch notes.',
  'Fact 1: the steward wake path currently uses PTY injection.',
  'Fact 2: the target control face is codex app-server.',
  'Fact 3: this file exists only to give the agent something to read.',
].join('\n'));
writeFileSync(OUT, '');

const child = spawn('codex', ['app-server'], {
  cwd: SCRATCH,
  stdio: ['pipe', 'pipe', 'pipe'],
});

let nextId = 1;
const pending = new Map(); // id -> {resolve, reject, method}

function record(dir, msg) {
  appendFileSync(OUT, JSON.stringify({ dir, msg }) + '\n');
}

function send(obj) {
  record('client->server', obj);
  child.stdin.write(JSON.stringify(obj) + '\n');
}

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, method });
    send({ id, method, params });
  });
}

function notify(method, params) {
  send(params === undefined ? { method } : { method, params });
}

let turnDone;
const turnCompleted = new Promise((r) => { turnDone = r; });
let activeTurn = null;

const rl = createInterface({ input: child.stdout });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { record('server->client(unparsed)', line); return; }
  record('server->client', msg);

  // Response to one of our requests
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(`${p.method}: ${JSON.stringify(msg.error)}`));
    else p.resolve(msg.result);
    return;
  }
  // Server->client request (approvals etc.) — deny by default, log loudly
  if (msg.id !== undefined && msg.method) {
    console.error(`[spike] SERVER REQUEST (unexpected under approvalPolicy=never): ${msg.method}`);
    send({ id: msg.id, result: { decision: 'denied' } });
    return;
  }
  // Notification
  if (msg.method === 'turn/started') {
    activeTurn = msg.params?.turn?.id ?? null;
    console.error(`[spike] turn started: ${activeTurn}`);
  } else if (msg.method === 'item/completed') {
    const t = msg.params?.item?.type ?? msg.params?.item?.item_type ?? '?';
    console.error(`[spike] item completed: ${t}`);
  } else if (msg.method === 'thread/tokenUsage/updated') {
    console.error(`[spike] tokenUsage: ${JSON.stringify(msg.params?.tokenUsage).slice(0, 160)}`);
  } else if (msg.method === 'turn/completed') {
    console.error('[spike] turn completed');
    turnDone(msg.params);
  } else if (msg.method === 'error') {
    console.error(`[spike] ERROR notification: ${JSON.stringify(msg.params).slice(0, 300)}`);
  }
});

child.stderr.on('data', (d) => {
  const s = d.toString();
  appendFileSync('/tmp/s0-spike/appserver-stderr.log', s);
});
child.on('exit', (code, sig) => console.error(`[spike] app-server exited code=${code} sig=${sig}`));

const deadline = setTimeout(() => {
  console.error('[spike] TIMEOUT after 240s');
  child.kill('SIGTERM');
  process.exit(2);
}, 240_000);

try {
  const init = await request('initialize', {
    clientInfo: { name: 'openalice-s0-spike', title: 'OpenAlice S0 spike', version: '0.0.1' },
  });
  console.error(`[spike] initialized: ${JSON.stringify(init).slice(0, 300)}`);
  notify('initialized');

  const started = await request('thread/start', {
    cwd: SCRATCH,
    approvalPolicy: 'never',
    sandbox: 'workspace-write',
    ephemeral: false,
  });
  const threadId = started?.thread?.id ?? started?.threadId;
  console.error(`[spike] thread started: ${threadId}`);
  if (!threadId) throw new Error(`no thread id in ${JSON.stringify(started).slice(0, 400)}`);

  const turn = await request('turn/start', {
    threadId,
    effort: 'low',
    input: [{
      type: 'text',
      text: 'Read notes.txt in the current directory and write a one-line summary of it to summary.txt. Then reply with exactly the word DONE.',
    }],
  });
  console.error(`[spike] turn/start response: ${JSON.stringify(turn).slice(0, 300)}`);

  const completed = await turnCompleted;
  console.error(`[spike] turn/completed payload: ${JSON.stringify(completed).slice(0, 500)}`);

  // Resume check: read the thread back
  const readBack = await request('thread/read', { threadId });
  console.error(`[spike] thread/read ok, keys: ${Object.keys(readBack ?? {})}`);

  clearTimeout(deadline);
  console.error('[spike] SUCCESS');
  writeFileSync('/tmp/s0-spike/result.json', JSON.stringify({ threadId, completed }, null, 2));
  child.kill('SIGTERM');
  process.exit(0);
} catch (err) {
  clearTimeout(deadline);
  console.error(`[spike] FAILED: ${err?.message ?? err}`);
  child.kill('SIGTERM');
  process.exit(1);
}
