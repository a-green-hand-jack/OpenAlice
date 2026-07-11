#!/usr/bin/env node
// S0 part 2: prove cross-process thread persistence — fresh app-server process,
// thread/resume by id, second turn referencing first-turn context.
import { spawn } from 'node:child_process';
import { readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const { threadId } = JSON.parse(readFileSync('/tmp/s0-spike/result.json', 'utf8'));
const OUT = '/tmp/s0-spike/transcript-resume.jsonl';
writeFileSync(OUT, '');

const child = spawn('codex', ['app-server'], { cwd: '/tmp/s0-scratch', stdio: ['pipe', 'pipe', 'pipe'] });
let nextId = 1;
const pending = new Map();
const record = (dir, msg) => appendFileSync(OUT, JSON.stringify({ dir, msg }) + '\n');
const send = (obj) => { record('client->server', obj); child.stdin.write(JSON.stringify(obj) + '\n'); };
const request = (method, params) => {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, method });
    send({ id, method, params });
  });
};

let turnDone; const turnCompleted = new Promise((r) => { turnDone = r; });
let finalMessage = '';

createInterface({ input: child.stdout }).on('line', (line) => {
  if (!line.trim()) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  record('server->client', msg);
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && pending.has(msg.id)) {
    const p = pending.get(msg.id); pending.delete(msg.id);
    msg.error ? p.reject(new Error(`${p.method}: ${JSON.stringify(msg.error)}`)) : p.resolve(msg.result);
    return;
  }
  if (msg.id !== undefined && msg.method) { send({ id: msg.id, result: { decision: 'denied' } }); return; }
  if (msg.method === 'item/completed' && msg.params?.item?.type === 'agentMessage') {
    finalMessage = msg.params.item.text ?? JSON.stringify(msg.params.item).slice(0, 200);
  }
  if (msg.method === 'turn/completed') turnDone(msg.params);
});

const deadline = setTimeout(() => { console.error('[resume] TIMEOUT'); child.kill('SIGTERM'); process.exit(2); }, 240_000);

try {
  await request('initialize', { clientInfo: { name: 'openalice-s0-spike', version: '0.0.1' } });
  send({ method: 'initialized' });
  const resumed = await request('thread/resume', { threadId, approvalPolicy: 'never', sandbox: 'workspace-write' });
  console.error(`[resume] thread resumed: ${resumed?.thread?.id ?? JSON.stringify(resumed).slice(0, 200)}`);
  await request('turn/start', {
    threadId,
    effort: 'low',
    input: [{ type: 'text', text: 'Without running any commands: what filename did you write your summary to earlier in this conversation? Reply with just the filename.' }],
  });
  const completed = await turnCompleted;
  clearTimeout(deadline);
  console.error(`[resume] turn status: ${completed?.turn?.status}`);
  console.error(`[resume] agent reply: ${finalMessage}`);
  console.error(finalMessage.includes('summary.txt') ? '[resume] SUCCESS — cross-process context retained' : '[resume] WARNING — reply did not reference summary.txt');
  child.kill('SIGTERM');
  process.exit(finalMessage.includes('summary.txt') ? 0 : 1);
} catch (err) {
  clearTimeout(deadline);
  console.error(`[resume] FAILED: ${err?.message ?? err}`);
  child.kill('SIGTERM');
  process.exit(1);
}
