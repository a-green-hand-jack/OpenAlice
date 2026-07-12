/**
 * End-to-end test of the GENERATED workspace validator, not the server-side zod
 * schema. We run the real `bootstrap.mjs` in a temp dir (plain Node, same as the
 * launcher does via ELECTRON_RUN_AS_NODE), then exercise the
 * `.alice/steward/validate-ledger.mjs` it writes.
 *
 * Issue #140: the validator is now the ONLY supported writer of
 * decisions.jsonl. The agent writes a per-wake DRAFT (drafts/<wakeId>.json); the
 * validator reads the draft + the server-owned wake record, strictly validates
 * (#125 schema, #139 self-reference + active-wake binding), cross-checks prior
 * terminal receipts (#134), then atomically appends-or-replaces the wake's line
 * and publishes the #136 finalize marker. Any failure writes neither.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { canonicalDecisionFingerprint } from '../../steward/ledger-receipt.js';
import { LEDGER_RENAME_RETRY_CODES, LOCK_TTL_MS } from '../../steward/ledger-writer.js';

const here = dirname(fileURLToPath(import.meta.url));
const bootstrapPath = join(here, 'bootstrap.mjs');

let root: string;
let wsDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'steward-bootstrap-'));
  wsDir = join(root, 'ws');
  const res = spawnSync(process.execPath, [bootstrapPath, 'test-tag', wsDir], { encoding: 'utf8' });
  expect(res.status, res.stderr).toBe(0);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const goodChecklist = { account: 'ok', positions: 'ok', orders: 'ok', risk: 'NORMAL', market: 'open', history: 'checked' };
const goodCost = {
  model: 'codex', inputTokens: null, outputTokens: null, modelCostUsd: null,
  allocatedServerCostUsd: null, tradingFeesUsd: null, estimatedSlippageUsd: null, totalEstimatedCostUsd: null,
};

/** A well-formed v2 decision object (self-consistent evidence), for use as a draft. */
function entry(over: Record<string, unknown> = {}): Record<string, unknown> {
  const wakeId = (over.wakeId as string | undefined) ?? 'wake-1';
  return {
    version: 2,
    wakeId,
    at: '2026-07-10T14:01:23.000Z',
    accountId: 'mock-simulator-1',
    decision: 'no_trade',
    status: 'done',
    completion: { reason: 'checklist complete; no entry signal', evidenceRefs: [`wake:${wakeId}`, 'tool:risk'] },
    checklist: goodChecklist,
    thesis: 'no thesis or entry signal',
    actions: [],
    pendingHash: null,
    invalidation: 'a new entry signal would reopen the decision',
    cost: goodCost,
    ...over,
  };
}

const draftPathFor = (wakeId: string) => join(wsDir, '.alice', 'steward', 'drafts', `${encodeURIComponent(wakeId)}.json`);
const markerPathFor = (wakeId: string) => join(wsDir, '.alice', 'steward', 'finalize', `${encodeURIComponent(wakeId)}.json`);
const wakePathFor = (wakeId: string) => join(wsDir, '.alice', 'steward', 'wakes', `${encodeURIComponent(wakeId)}.json`);
const ledgerFile = () => join(wsDir, '.alice', 'steward', 'ledger', 'decisions.jsonl');
const ledgerLockFile = () => `${ledgerFile()}.lock`;

async function writeDraft(wakeId: string, over: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const e = entry({ wakeId, ...over });
  await writeFile(draftPathFor(wakeId), JSON.stringify(e, null, 2), 'utf8');
  return e;
}
async function writeRawDraft(wakeId: string, obj: unknown): Promise<void> {
  await writeFile(draftPathFor(wakeId), JSON.stringify(obj), 'utf8');
}
/** Seed the server-owned wake record (external binding). status default active. */
async function seedWakeRecord(
  wakeId: string,
  status = 'injected',
  extra: Record<string, unknown> = {},
): Promise<void> {
  await writeFile(wakePathFor(wakeId), JSON.stringify({ version: 1, wakeId, status, ...extra }, null, 2), 'utf8');
}
async function seedLedger(entries: Record<string, unknown>[]): Promise<void> {
  await writeFile(ledgerFile(), entries.length ? `${entries.map((e) => JSON.stringify(e)).join('\n')}\n` : '', 'utf8');
}
function runValidate(wakeId: string): { code: number; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, ['.alice/steward/validate-ledger.mjs', wakeId], { cwd: wsDir, encoding: 'utf8' });
  return { code: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
}
async function ledgerLines(): Promise<string[]> {
  return (await readFile(ledgerFile(), 'utf8')).split('\n').filter(Boolean);
}
/** A prior terminal wake record + its committed ledger line + receipt fingerprint. */
async function terminalWakeWithReceipt(wakeId: string): Promise<Record<string, unknown>> {
  const e = entry({ wakeId });
  await seedWakeRecord(wakeId, 'done', {
    injectedAt: '2026-07-10T14:00:05.000Z',
    ledgerReceipt: { version: 1, wakeId, status: 'done', decision: 'no_trade', at: e.at, accountId: e.accountId, fingerprint: canonicalDecisionFingerprint(e), recordedAt: '2026-07-10T14:02:00.000Z' },
  });
  return e;
}

describe('generated validate-ledger.mjs — draft → ledger commit (issue #140)', () => {
  it('commits a valid draft: writes the entry, publishes a marker, removes the draft', async () => {
    const e = await writeDraft('wake-1');
    await seedWakeRecord('wake-1');
    const res = runValidate('wake-1');
    expect(res.stderr).toBe('');
    expect(res.code).toBe(0);
    expect(await ledgerLines()).toEqual([JSON.stringify(e)]);
    const marker = JSON.parse(await readFile(markerPathFor('wake-1'), 'utf8'));
    expect(marker.fingerprint).toBe(canonicalDecisionFingerprint(e));
    expect(existsSync(draftPathFor('wake-1'))).toBe(false); // cleaned on success
  });

  it('appends a new wake and preserves the prior line byte-for-byte', async () => {
    const prior = entry({ wakeId: 'wake-prior', thesis: 'unusual   spacing kept' });
    const priorRaw = JSON.stringify(prior);
    await writeFile(ledgerFile(), `${priorRaw}\n`, 'utf8');
    await writeDraft('wake-2');
    await seedWakeRecord('wake-2');
    expect(runValidate('wake-2').code).toBe(0);
    const lines = await ledgerLines();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(priorRaw); // untouched, exact bytes
    expect(JSON.parse(lines[1]).wakeId).toBe('wake-2');
  });

  it('replaces the SAME wake line in place for a pre-terminal correction (no duplicate, same position)', async () => {
    await seedLedger([entry({ wakeId: 'wake-a' }), entry({ wakeId: 'wake-b' })]);
    await seedWakeRecord('wake-a');
    // correct wake-a in place
    await writeDraft('wake-a', { thesis: 'corrected', decision: 'propose_trade' });
    expect(runValidate('wake-a').code).toBe(0);
    const lines = await ledgerLines();
    expect(lines).toHaveLength(2); // no duplicate
    expect(JSON.parse(lines[0]).wakeId).toBe('wake-a'); // same position (line 1)
    expect(JSON.parse(lines[0]).decision).toBe('propose_trade');
    expect(JSON.parse(lines[1]).wakeId).toBe('wake-b'); // untouched
  });

  it('fails and writes NOTHING when there is no draft', async () => {
    await seedWakeRecord('wake-nodraft');
    const res = runValidate('wake-nodraft');
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/no draft/);
    expect(existsSync(markerPathFor('wake-nodraft'))).toBe(false);
    expect(await ledgerLines()).toEqual([]);
  });

  it('is path-safe for an arbitrary wakeId (slashes/colons percent-encoded)', async () => {
    const wakeId = '2026-07-11T14:00:00Z:aapl/risk-check';
    const e = await writeDraft(wakeId);
    await seedWakeRecord(wakeId);
    expect(runValidate(wakeId).code).toBe(0);
    expect(draftPathFor(wakeId).endsWith(`${encodeURIComponent(wakeId)}.json`)).toBe(true);
    const marker = JSON.parse(await readFile(markerPathFor(wakeId), 'utf8'));
    expect(marker.wakeId).toBe(wakeId);
    expect((await ledgerLines()).map((l) => JSON.parse(l).wakeId)).toEqual([wakeId]);
    void e;
  });
});

describe('generated validate-ledger.mjs — strict schema on the draft (issue #125/#139)', () => {
  async function expectRejected(over: Record<string, unknown>, re: RegExp, wakeId = 'wake-1'): Promise<void> {
    await writeRawDraft(wakeId, entry({ wakeId, ...over }));
    await seedWakeRecord(wakeId);
    const res = runValidate(wakeId);
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(re);
    expect(existsSync(markerPathFor(wakeId))).toBe(false);
    expect(await ledgerLines()).toEqual([]); // ledger untouched
    expect(existsSync(draftPathFor(wakeId))).toBe(true); // draft kept for correction
  }

  it('accepts an executed typed action with pendingHash null', async () => {
    await writeDraft('wake-1', {
      decision: 'propose_trade',
      pendingHash: null,
      actions: [{ kind: 'order_place', aliceId: 'mock-simulator-1/ASSET-A', params: { action: 'BUY' }, commitHash: 'deadbeef', outcome: 'executed' }],
    });
    await seedWakeRecord('wake-1');
    expect(runValidate('wake-1').code).toBe(0);
  });

  it('rejects a commit hash parked in pendingHash after an executed outcome (D1)', async () => {
    await expectRejected({
      decision: 'propose_trade',
      pendingHash: 'deadbeef',
      actions: [{ kind: 'order_place', aliceId: 'mock-simulator-1/ASSET-A', params: { action: 'BUY' }, commitHash: 'deadbeef', outcome: 'executed' }],
    }, /pendingHash must be null/);
  });

  it('rejects version 1, free-text action, and policy_denied with no violations', async () => {
    await expectRejected({ version: 1 }, /version must be 2/);
    await expectRejected({ actions: ['placed a market buy'] }, /free-text action strings are rejected/);
    await expectRejected({
      decision: 'no_trade',
      actions: [{ kind: 'order_place', aliceId: 'mock-simulator-1/ASSET-A', params: { action: 'BUY' }, outcome: 'policy_denied' }],
    }, /policy_denied/);
  });

  it('rejects a missing / contradictory wake self-reference (#139)', async () => {
    await expectRejected({ completion: { reason: 'done', evidenceRefs: ['tool:risk'] } }, /must include the self-reference/);
    // self-ref present, but ALSO names another wake → contradictory.
    await expectRejected({ completion: { reason: 'done', evidenceRefs: ['wake:wake-1', 'wake:wake-other', 'tool:risk'] } }, /references a different wake/);
  });

  it('rejects a draft whose top-level wakeId is not the wake being finalized', async () => {
    await writeRawDraft('wake-1', entry({ wakeId: 'wake-somethingelse' }));
    await seedWakeRecord('wake-1');
    const res = runValidate('wake-1');
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/must equal the wake you are finalizing/);
  });
});

describe('generated validate-ledger.mjs — external wake binding (issue #139)', () => {
  it('rejects finalizing a wake with no active wake record (impersonation), writing nothing', async () => {
    await writeDraft('ghost-wake');
    const res = runValidate('ghost-wake'); // no wake record seeded
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/no active posted wake/);
    expect(existsSync(markerPathFor('ghost-wake'))).toBe(false);
    expect(await ledgerLines()).toEqual([]);
  });

  it('rejects re-finalizing an already-terminal wake (replay)', async () => {
    await writeDraft('wake-done');
    await seedWakeRecord('wake-done', 'done');
    const res = runValidate('wake-done');
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/already done|cannot be re-finalized/);
    expect(existsSync(markerPathFor('wake-done'))).toBe(false);
  });
});

describe('generated validate-ledger.mjs — prior terminal integrity cross-check (issue #134)', () => {
  it('blocks the commit and writes no marker when a prior terminal wake\'s entry disappeared', async () => {
    await terminalWakeWithReceipt('wake-prior'); // record + receipt, but NO ledger line
    await seedLedger([]);
    await writeDraft('wake-cur');
    await seedWakeRecord('wake-cur');
    const res = runValidate('wake-cur');
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/has no ledger entry/);
    expect(existsSync(markerPathFor('wake-cur'))).toBe(false);
    expect(await ledgerLines()).toEqual([]); // current entry NOT committed
  });

  it('blocks the commit when a prior terminal wake\'s entry was mutated (fingerprint mismatch)', async () => {
    const prior = await terminalWakeWithReceipt('wake-prior');
    // ledger carries a MUTATED prior entry (semantic change)
    await seedLedger([{ ...prior, thesis: 'rewritten', decision: 'propose_trade', completion: { reason: 'r', evidenceRefs: ['wake:wake-prior', 'tool:risk'] } }]);
    await writeDraft('wake-cur');
    await seedWakeRecord('wake-cur');
    const res = runValidate('wake-cur');
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/fingerprint mismatch/);
    expect(existsSync(markerPathFor('wake-cur'))).toBe(false);
  });

  it('commits normally when the prior terminal wake is intact', async () => {
    const prior = await terminalWakeWithReceipt('wake-prior');
    await seedLedger([prior]); // intact
    await writeDraft('wake-cur');
    await seedWakeRecord('wake-cur');
    expect(runValidate('wake-cur').code).toBe(0);
    expect((await ledgerLines()).map((l) => JSON.parse(l).wakeId)).toEqual(['wake-prior', 'wake-cur']);
  });
});

describe('generated validate-ledger.mjs — failure lock cleanup (issue #176)', () => {
  it('releases its owned token after representative post-acquire failures', async () => {
    await terminalWakeWithReceipt('wake-prior');
    await seedLedger([]);
    await writeDraft('wake-missing-prior');
    await seedWakeRecord('wake-missing-prior');

    const integrityFailure = runValidate('wake-missing-prior');
    expect(integrityFailure.code).toBe(1);
    expect(integrityFailure.stderr).toMatch(/has no ledger entry/);
    expect(existsSync(ledgerLockFile())).toBe(false);

    await rm(wakePathFor('wake-prior'), { force: true });
    await rm(wakePathFor('wake-missing-prior'), { force: true });
    await seedLedger([
      entry({ wakeId: 'wake-duplicate', thesis: 'first' }),
      entry({ wakeId: 'wake-duplicate', thesis: 'second' }),
    ]);
    await writeDraft('wake-duplicate');
    await seedWakeRecord('wake-duplicate');

    const duplicateFailure = runValidate('wake-duplicate');
    expect(duplicateFailure.code).toBe(1);
    expect(duplicateFailure.stderr).toMatch(/already has 2 entries/);
    expect(existsSync(ledgerLockFile())).toBe(false);
  });

  it('survives repeated failed retries without stranding the lock, then commits immediately', async () => {
    const prior = await terminalWakeWithReceipt('wake-prior');
    await seedLedger([]);
    await writeDraft('wake-retry');
    await seedWakeRecord('wake-retry');

    for (let attempt = 0; attempt < 40; attempt++) {
      const failed = runValidate('wake-retry');
      expect(failed.code, `attempt ${attempt}`).toBe(1);
      expect(failed.stderr).toMatch(/has no ledger entry/);
      expect(existsSync(ledgerLockFile()), `attempt ${attempt}`).toBe(false);
    }

    await seedLedger([prior]);
    const recovered = runValidate('wake-retry');
    expect(recovered.code, recovered.stderr).toBe(0);
    expect(existsSync(ledgerLockFile())).toBe(false);
    expect((await ledgerLines()).map((line) => JSON.parse(line).wakeId)).toEqual([
      'wake-prior',
      'wake-retry',
    ]);
  });
});

describe('generated validate-ledger.mjs — golden fingerprint parity (TS ↔ JS)', () => {
  const GOLDEN_ENTRY = {
    version: 2,
    wakeId: 'golden-wake',
    at: '2026-07-11T00:00:00.000Z',
    accountId: 'mock-simulator-1',
    decision: 'no_trade',
    status: 'done',
    completion: { reason: 'checklist complete; no entry signal', evidenceRefs: ['wake:golden-wake', 'tool:risk'] },
    checklist: goodChecklist,
    thesis: 'No trade: no thesis or entry signal.',
    actions: [],
    pendingHash: null,
    invalidation: 'A new explicit thesis or entry signal would reopen the decision.',
    cost: goodCost,
  } as const;
  // Pinned in ledger-receipt.spec.ts too — keep in sync.
  const GOLDEN_FINGERPRINT = 'a00e0bc4ff92f38b3e7bfab09e797e73d5f9248664cee740ac1efedf4849ef9f';

  it('the validator writes a marker whose fingerprint matches the pinned TS golden vector', async () => {
    expect(canonicalDecisionFingerprint(GOLDEN_ENTRY)).toBe(GOLDEN_FINGERPRINT);
    await writeRawDraft('golden-wake', GOLDEN_ENTRY);
    await seedWakeRecord('golden-wake');
    expect(runValidate('golden-wake').code).toBe(0);
    const marker = JSON.parse(await readFile(markerPathFor('golden-wake'), 'utf8'));
    expect(marker.fingerprint).toBe(GOLDEN_FINGERPRINT);
  });
});

describe('generated validate-ledger.mjs ↔ ledger-writer.ts lock-protocol parity (issue #140)', () => {
  it('shares the lock TTL, retry codes, lock-path suffix, and record shape with the TS writer', async () => {
    const src = await readFile(join(wsDir, '.alice', 'steward', 'validate-ledger.mjs'), 'utf8');
    // TTL parity (TS constant is the source of truth).
    expect(LOCK_TTL_MS).toBe(30_000);
    expect(src).toContain(`const LOCK_TTL_MS = ${LOCK_TTL_MS}`);
    // Rename retry codes parity.
    for (const code of LEDGER_RENAME_RETRY_CODES) expect(src).toContain(`'${code}'`);
    // Lock path suffix + record shape.
    expect(src).toContain("ledgerPath + '.lock'");
    expect(src).toContain('pid: process.pid, token, at: Date.now()');
    // Acquire budget outlasts the TTL (200 attempts) in both.
    expect(src).toContain('attempt < 200');
  });
});

describe('bootstrap.mjs --refresh-runtime (issue #140 merge gate)', () => {
  const stewardFile = (p: string) => join(wsDir, '.alice', 'steward', p);
  function refresh(): { code: number; stderr: string } {
    const res = spawnSync(process.execPath, [bootstrapPath, '--refresh-runtime', wsDir], { encoding: 'utf8' });
    return { code: res.status ?? -1, stderr: res.stderr };
  }

  it('upgrades an OLD workspace in place: new validator + drafts dir, user content byte-preserved, next wake commits', async () => {
    // Simulate a workspace bootstrapped before #140: old ledger-based validator,
    // no drafts/ dir, no runtime marker.
    await writeFile(stewardFile('validate-ledger.mjs'), '// OLD LEDGER-BASED VALIDATOR\n', 'utf8');
    await rm(stewardFile('drafts'), { recursive: true, force: true });
    await rm(stewardFile('runtime.json'), { force: true });
    // Existing user content: a prior completed wake + its ledger line + config.
    const prior = await terminalWakeWithReceipt('wake-old');
    await seedLedger([prior]);
    const ledgerBefore = await readFile(ledgerFile(), 'utf8');
    const configBefore = await readFile(stewardFile('config.json'), 'utf8');
    const wakeBefore = await readFile(wakePathFor('wake-old'), 'utf8');

    const r = refresh();
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);

    // Launcher-owned artifacts upgraded:
    const validator = await readFile(stewardFile('validate-ledger.mjs'), 'utf8');
    expect(validator).not.toContain('OLD LEDGER-BASED');
    expect(validator).toContain('drafts');
    expect(existsSync(stewardFile('drafts'))).toBe(true);
    expect(JSON.parse(await readFile(stewardFile('runtime.json'), 'utf8')).protocol).toBe(2);
    // User content preserved byte-for-byte:
    expect(await readFile(ledgerFile(), 'utf8')).toBe(ledgerBefore);
    expect(await readFile(stewardFile('config.json'), 'utf8')).toBe(configBefore);
    expect(await readFile(wakePathFor('wake-old'), 'utf8')).toBe(wakeBefore);

    // The next wake now works end-to-end (draft → commit → marker), history intact.
    await seedWakeRecord('wake-new');
    await writeDraft('wake-new');
    expect(runValidate('wake-new').code).toBe(0);
    expect((await ledgerLines()).map((l) => JSON.parse(l).wakeId)).toEqual(['wake-old', 'wake-new']);
    expect(existsSync(markerPathFor('wake-new'))).toBe(true);
  });

  it('is idempotent: repeated refresh succeeds and never duplicates git excludes', async () => {
    expect(refresh().code).toBe(0);
    expect(refresh().code).toBe(0);
    const exclude = await readFile(join(wsDir, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude.split('\n').filter((l) => l.trim() === '.alice/steward/drafts/')).toHaveLength(1);
    expect(exclude.split('\n').filter((l) => l.trim() === '.alice/steward/ledger/decisions.jsonl.lock')).toHaveLength(1);
  });

  it('never touches user content when nothing changed (config/ledger/wakes untouched)', async () => {
    await seedLedger([entry({ wakeId: 'wake-keep' })]);
    const before = {
      config: await readFile(stewardFile('config.json'), 'utf8'),
      ledger: await readFile(ledgerFile(), 'utf8'),
    };
    expect(refresh().code).toBe(0);
    expect(await readFile(stewardFile('config.json'), 'utf8')).toBe(before.config);
    expect(await readFile(ledgerFile(), 'utf8')).toBe(before.ledger);
  });

  it('concurrent refreshes are safe', async () => {
    const runs = await Promise.all([0, 1, 2, 3].map(() => new Promise<number>((resolve) => {
      const child = spawn(process.execPath, [bootstrapPath, '--refresh-runtime', wsDir]);
      child.on('close', (code) => resolve(code ?? -1));
    })));
    expect(runs.every((c) => c === 0)).toBe(true);
    expect(existsSync(stewardFile('drafts'))).toBe(true);
    expect(JSON.parse(await readFile(stewardFile('runtime.json'), 'utf8')).protocol).toBe(2);
  });
});

describe('generated validate-ledger.mjs — concurrent atomic writes (issue #140)', () => {
  function validateAsync(wakeId: string): Promise<number> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, ['.alice/steward/validate-ledger.mjs', wakeId], { cwd: wsDir });
      child.on('close', (code) => resolve(code ?? -1));
    });
  }

  it('many different wakes committing concurrently all land (no lost update, no lock leak)', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `wake-c${i}`);
    for (const id of ids) {
      await writeDraft(id);
      await seedWakeRecord(id);
    }
    // Genuinely parallel cross-process writers contending on the shared lock.
    const codes = await Promise.all(ids.map(validateAsync));
    expect(codes.every((c) => c === 0)).toBe(true);
    const committed = (await ledgerLines()).map((l) => JSON.parse(l).wakeId).sort();
    expect(committed).toEqual([...ids].sort());
    expect(existsSync(ledgerLockFile())).toBe(false);
  });
});
