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

import {
  canonicalDecisionFingerprint,
  canonicalizeJson,
  semanticLedgerProjection,
} from '../../steward/ledger-receipt.js';
import { LEDGER_RENAME_RETRY_CODES, LOCK_TTL_MS } from '../../steward/ledger-writer.js';
import { canonicalInformationSnapshotHash } from '../../steward/snapshot.js';
import { stewardDecisionLedgerEntryV3Schema } from '../../steward/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const bootstrapPath = join(here, 'bootstrap.mjs');
const d2FixtureDir = fileURLToPath(new URL('../../../../tools/steward-contract-proof/fixtures/d2/', import.meta.url));

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

/** A well-formed v3 decision object (self-consistent evidence), for use as a draft. */
function entry(over: Record<string, unknown> = {}): Record<string, unknown> {
  const wakeId = (over.wakeId as string | undefined) ?? 'wake-1';
  return {
    version: 3,
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
    intent: null,
    thesisDispositions: [],
    ...over,
  };
}

const draftPathFor = (wakeId: string) => join(wsDir, '.alice', 'steward', 'drafts', `${encodeURIComponent(wakeId)}.json`);
const markerPathFor = (wakeId: string) => join(wsDir, '.alice', 'steward', 'finalize', `${encodeURIComponent(wakeId)}.json`);
const wakePathFor = (wakeId: string) => join(wsDir, '.alice', 'steward', 'wakes', `${encodeURIComponent(wakeId)}.json`);
const snapshotPathFor = (wakeId: string) => join(wsDir, '.alice', 'steward', 'snapshots', `${encodeURIComponent(wakeId)}.json`);
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
  const snapshot = {
    version: 1,
    snapshotId: `snap:${wakeId}`,
    wakeId,
    accountId: 'mock-simulator-1',
    asOf: '2026-07-10T14:00:00.000Z',
    market: { provided: false, note: 'not supplied' },
    portfolio: { provided: false, note: 'not supplied' },
    risk: { provided: false, envelopeVersion: null, note: 'not supplied' },
    events: { provided: false, note: 'not supplied' },
    history: { provided: false, note: 'not supplied' },
  } as const;
  await writeFile(snapshotPathFor(wakeId), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  await writeFile(wakePathFor(wakeId), JSON.stringify({
    version: 1,
    wakeId,
    status,
    envelope: {
      version: 2,
      reason: 'scheduled_observe',
      accountId: snapshot.accountId,
      authzLevel: 'paper',
      expectedDecision: 'no_trade',
      snapshotRef: {
        snapshotId: snapshot.snapshotId,
        sha256: canonicalInformationSnapshotHash(snapshot),
        path: `.alice/steward/snapshots/${encodeURIComponent(wakeId)}.json`,
        asOf: snapshot.asOf,
      },
    },
    ...extra,
  }, null, 2), 'utf8');
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
async function seedProofSingle(
  mutate?: (entry: Record<string, unknown>, snapshot: Record<string, unknown>) => void,
): Promise<{ entry: Record<string, unknown>; snapshot: Record<string, unknown> }> {
  const entry = JSON.parse(await readFile(join(d2FixtureDir, 'ledger-v3-single.json'), 'utf8')) as Record<string, unknown>;
  const snapshot = JSON.parse(await readFile(join(d2FixtureDir, 'information-snapshot-single.json'), 'utf8')) as Record<string, unknown>;
  mutate?.(entry, snapshot);
  const wakeId = entry['wakeId'] as string;
  await seedWakeRecord(wakeId, 'injected', {
    envelope: {
      version: 2,
      reason: 'scheduled_observe',
      accountId: entry['accountId'],
      authzLevel: 'paper',
      expectedDecision: 'propose_change',
      snapshotRef: {
        snapshotId: snapshot['snapshotId'],
        sha256: canonicalInformationSnapshotHash(snapshot),
        path: `.alice/steward/snapshots/${encodeURIComponent(wakeId)}.json`,
        asOf: snapshot['asOf'],
      },
    },
  });
  await writeFile(snapshotPathFor(wakeId), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  await writeRawDraft(wakeId, entry);
  return { entry, snapshot };
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

  it('hashes nested own __proto__/constructor exactly like the TypeScript receipt canonicalizer', async () => {
    const wakeId = 'wake-hostile-json-keys';
    const params = JSON.parse(
      '{"nested":{"z":1,"__proto__":{"polluted":true},"constructor":{"prototype":{"constructorPolluted":true}}}}',
    ) as Record<string, unknown>;
    const hostile = entry({
      wakeId,
      actions: [{ kind: 'git_reject', params, outcome: 'awaiting_approval' }],
    });
    await seedWakeRecord(wakeId);
    await writeRawDraft(wakeId, hostile);

    expect(runValidate(wakeId).code).toBe(0);
    const committedHostile = JSON.parse((await ledgerLines())[0]!) as Record<string, unknown>;
    const hostileMarker = JSON.parse(await readFile(markerPathFor(wakeId), 'utf8')) as Record<string, unknown>;
    const committedParams = (
      (committedHostile['actions'] as Array<Record<string, unknown>>)[0]!['params'] as Record<string, unknown>
    );
    const nested = committedParams['nested'] as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(nested, '__proto__')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(nested, 'constructor')).toBe(true);
    expect(JSON.stringify(canonicalizeJson(semanticLedgerProjection(committedHostile)))).toContain(
      '"__proto__":{"polluted":true}',
    );
    expect(hostileMarker['fingerprint']).toBe(canonicalDecisionFingerprint(committedHostile));

    const withoutProto = JSON.parse(JSON.stringify(committedHostile)) as Record<string, unknown>;
    const withoutProtoNested = (
      (((withoutProto['actions'] as Array<Record<string, unknown>>)[0]!['params'] as Record<string, unknown>)['nested'])
    ) as Record<string, unknown>;
    delete withoutProtoNested['__proto__'];
    await writeRawDraft(wakeId, withoutProto);
    expect(runValidate(wakeId).code).toBe(0);
    const protoFreeMarker = JSON.parse(await readFile(markerPathFor(wakeId), 'utf8')) as Record<string, unknown>;
    expect(protoFreeMarker['fingerprint']).toBe(canonicalDecisionFingerprint(withoutProto));
    expect(protoFreeMarker['fingerprint']).not.toBe(hostileMarker['fingerprint']);

    const withoutConstructor = JSON.parse(JSON.stringify(withoutProto)) as Record<string, unknown>;
    const withoutConstructorNested = (
      (((withoutConstructor['actions'] as Array<Record<string, unknown>>)[0]!['params'] as Record<string, unknown>)['nested'])
    ) as Record<string, unknown>;
    delete withoutConstructorNested['constructor'];
    await writeRawDraft(wakeId, withoutConstructor);
    expect(runValidate(wakeId).code).toBe(0);
    const cleanMarker = JSON.parse(await readFile(markerPathFor(wakeId), 'utf8')) as Record<string, unknown>;
    expect(cleanMarker['fingerprint']).toBe(canonicalDecisionFingerprint(withoutConstructor));
    expect(cleanMarker['fingerprint']).not.toBe(protoFreeMarker['fingerprint']);
    expect((Object.prototype as { polluted?: unknown }).polluted).toBeUndefined();
    expect((Object.prototype as { constructorPolluted?: unknown }).constructorPolluted).toBeUndefined();
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
    await writeDraft('wake-a', { thesis: 'corrected', decision: 'blocked' });
    expect(runValidate('wake-a').code).toBe(0);
    const lines = await ledgerLines();
    expect(lines).toHaveLength(2); // no duplicate
    expect(JSON.parse(lines[0]).wakeId).toBe('wake-a'); // same position (line 1)
    expect(JSON.parse(lines[0]).decision).toBe('blocked');
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
      decision: 'no_trade',
      pendingHash: null,
      actions: [{ kind: 'order_place', aliceId: 'mock-simulator-1/ASSET-A', params: { action: 'BUY' }, commitHash: 'deadbeef', outcome: 'executed' }],
    });
    await seedWakeRecord('wake-1');
    expect(runValidate('wake-1').code).toBe(0);
  });

  it('rejects a commit hash parked in pendingHash after an executed outcome (D1)', async () => {
    await expectRejected({
      decision: 'no_trade',
      pendingHash: 'deadbeef',
      actions: [{ kind: 'order_place', aliceId: 'mock-simulator-1/ASSET-A', params: { action: 'BUY' }, commitHash: 'deadbeef', outcome: 'executed' }],
    }, /pendingHash must be null/);
  });

  it('rejects legacy versions, free-text action, and policy_denied with no violations', async () => {
    await expectRejected({ version: 2 }, /version must be 3/);
    await expectRejected({ actions: ['placed a market buy'] }, /free-text action strings are rejected/);
    await expectRejected({
      decision: 'no_trade',
      actions: [{ kind: 'order_place', aliceId: 'mock-simulator-1/ASSET-A', params: { action: 'BUY' }, outcome: 'policy_denied' }],
    }, /policy_denied/);
  });

  it('rejects a missing / contradictory wake self-reference (#139)', async () => {
    await expectRejected({ completion: { reason: 'done', evidenceRefs: ['tool:risk'] } }, /exactly one/);
    await expectRejected({ completion: { reason: 'done', evidenceRefs: ['wake:wake-1', 'wake:wake-1'] } }, /exactly one/);
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

  it('rejects a draft at timestamp in the future beyond the 60s tolerance (issue #255)', async () => {
    await expectRejected(
      { at: new Date(Date.now() + 120_000).toISOString() },
      /draft at is in the future -- set at to the actual current UTC time/,
    );
  });

  it('accepts a draft at timestamp at the current time or slightly in the past (issue #255)', async () => {
    const wakeId = 'wake-at-now';
    await writeDraft(wakeId, { at: new Date(Date.now() - 5_000).toISOString() });
    await seedWakeRecord(wakeId);
    expect(runValidate(wakeId).code).toBe(0);
  });

  it('accepts a draft at timestamp within the 60s future tolerance boundary (issue #255)', async () => {
    const wakeId = 'wake-at-boundary';
    await writeDraft(wakeId, { at: new Date(Date.now() + 45_000).toISOString() });
    await seedWakeRecord(wakeId);
    expect(runValidate(wakeId).code).toBe(0);
  });

  it('rejects every representative malformed-v3 draft that the TypeScript schema rejects', async () => {
    const singleIntent = (wakeId: unknown): Record<string, unknown> => ({
      kind: 'single',
      direction: 'long',
      instrument: 'mock-simulator-1/ASSET-A',
      targetExposure: { minPct: 10, maxPct: 15 },
      invalidation: [{ kind: 'price_below', value: '90', note: 'fixture stop' }],
      confidence: 'medium',
      maxAcceptableLossPct: 2,
      timeHorizon: { unit: 'week', value: 1 },
      evidence: [{ ref: 'fixture:market', note: 'fixture evidence' }],
      snapshotId: `snap:${String(wakeId)}`,
      snapshotSha256: '0'.repeat(64),
    });
    const cases: ReadonlyArray<readonly [string, (candidate: Record<string, unknown>) => void]> = [
      ['empty pendingHash', (candidate) => { candidate.pendingHash = ''; }],
      ['blank pendingHash', (candidate) => { candidate.pendingHash = '   '; }],
      ['invalid timestamp', (candidate) => { candidate.at = 'not-an-iso-timestamp'; }],
      ['future timestamp beyond tolerance', (candidate) => { candidate.at = new Date(Date.now() + 120_000).toISOString(); }],
      ['blank account id', (candidate) => { candidate.accountId = '   '; }],
      ['null context', (candidate) => { candidate.context = null; }],
      ['empty context path', (candidate) => { candidate.context = { manifestPath: '', manifestSha256: 'hash' }; }],
      ['blank completion reason', (candidate) => { candidate.completion = { reason: ' ', evidenceRefs: [`wake:${candidate.wakeId}`] }; }],
      ['empty evidence ref', (candidate) => { candidate.completion = { reason: 'done', evidenceRefs: [`wake:${candidate.wakeId}`, ''] }; }],
      ['non-string evidence ref', (candidate) => { candidate.completion = { reason: 'done', evidenceRefs: [`wake:${candidate.wakeId}`, 7] }; }],
      ['empty checklist field', (candidate) => { candidate.checklist = { ...goodChecklist, account: '' }; }],
      ['non-string thesis', (candidate) => { candidate.thesis = 7; }],
      ['non-string invalidation', (candidate) => { candidate.invalidation = null; }],
      ['array action params', (candidate) => { candidate.actions = [{ kind: 'git_reject', params: [], outcome: 'awaiting_approval' }]; }],
      ['empty action aliceId', (candidate) => { candidate.actions = [{ kind: 'order_place', aliceId: '', params: {}, outcome: 'awaiting_approval' }]; }],
      ['empty optional commitHash', (candidate) => { candidate.actions = [{ kind: 'git_reject', params: {}, commitHash: '', outcome: 'awaiting_approval' }]; }],
      ['empty violation string', (candidate) => { candidate.actions = [{ kind: 'git_reject', params: {}, outcome: 'awaiting_approval', violations: [''] }]; }],
      ['invalid violation value', (candidate) => { candidate.actions = [{ kind: 'git_reject', params: {}, outcome: 'awaiting_approval', violations: [null] }]; }],
      ['empty cost model', (candidate) => { candidate.cost = { ...goodCost, model: '' }; }],
      ['negative input tokens', (candidate) => { candidate.cost = { ...goodCost, inputTokens: -1 }; }],
      ['fractional input tokens', (candidate) => { candidate.cost = { ...goodCost, inputTokens: 1.5 }; }],
      ['uncoercible input tokens', (candidate) => { candidate.cost = { ...goodCost, inputTokens: 'many' }; }],
      ['negative model cost', (candidate) => { candidate.cost = { ...goodCost, modelCostUsd: -0.01 }; }],
      ['uncoercible model cost', (candidate) => { candidate.cost = { ...goodCost, modelCostUsd: 'unknown' }; }],
      ['missing cost field', (candidate) => {
        const cost = { ...goodCost } as Record<string, unknown>;
        delete cost.totalEstimatedCostUsd;
        candidate.cost = cost;
      }],
      ['no-trade with intent', (candidate) => { candidate.intent = singleIntent(candidate.wakeId); }],
      ['proposal without intent', (candidate) => { candidate.decision = 'propose_change'; candidate.intent = null; }],
      ['intent unknown field', (candidate) => {
        candidate.decision = 'propose_change';
        candidate.intent = { ...singleIntent(candidate.wakeId), quantity: 10 };
      }],
      ['reversed exposure range', (candidate) => {
        candidate.decision = 'propose_change';
        candidate.intent = { ...singleIntent(candidate.wakeId), targetExposure: { minPct: 20, maxPct: 10 } };
      }],
      ['proposal without price invalidation', (candidate) => {
        candidate.decision = 'propose_change';
        candidate.intent = {
          ...singleIntent(candidate.wakeId),
          invalidation: [{ kind: 'time_expiry', note: 'no price condition' }],
        };
      }],
      ['duplicate portfolio targets', (candidate) => {
        const target = {
          direction: 'long', instrument: 'mock-simulator-1/ASSET-A',
          targetExposure: { minPct: 10, maxPct: 15 },
          invalidation: [{ kind: 'price_below', value: '90', note: 'fixture stop' }],
        };
        candidate.decision = 'propose_change';
        candidate.intent = {
          ...singleIntent(candidate.wakeId),
          kind: 'portfolio',
          targets: [target, { ...target, instrument: ' mock-simulator-1/ASSET-A ' }],
        };
        delete (candidate.intent as Record<string, unknown>).direction;
        delete (candidate.intent as Record<string, unknown>).instrument;
        delete (candidate.intent as Record<string, unknown>).targetExposure;
        delete (candidate.intent as Record<string, unknown>).invalidation;
      }],
      ['duplicate thesis disposition', (candidate) => {
        const disposition = { wakeId: 'prior', instrument: 'mock-simulator-1/ASSET-A', disposition: 'keep', note: 'still open' };
        candidate.thesisDispositions = [
          disposition,
          { ...disposition, wakeId: ' prior ', instrument: ' mock-simulator-1/ASSET-A ' },
        ];
      }],
      ['unknown top-level field', (candidate) => { candidate.unapproved = true; }],
    ];

    for (let index = 0; index < cases.length; index++) {
      const [name, mutate] = cases[index];
      const wakeId = `wake-parity-invalid-${index}`;
      const candidate = structuredClone(entry({ wakeId }));
      mutate(candidate);
      expect(stewardDecisionLedgerEntryV3Schema.safeParse(candidate).success, name).toBe(false);
      await writeRawDraft(wakeId, candidate);
      await seedWakeRecord(wakeId);
      const result = runValidate(wakeId);
      expect(result.code, `${name}: ${result.stderr}`).toBe(1);
      expect(existsSync(markerPathFor(wakeId)), name).toBe(false);
    }
    expect(await ledgerLines()).toEqual([]);
  });

  it('accepts coercible numerics and historical min-length strings exactly as the TypeScript schema does', async () => {
    const wakeId = 'wake-parity-valid';
    const candidate = entry({
      wakeId,
      at: '2026-07-10T14:01:23.123456Z',
      context: { manifestPath: ' ', manifestSha256: ' ' },
      completion: { reason: 'done', evidenceRefs: [`wake:${wakeId}`, ' '] },
      checklist: { ...goodChecklist, account: ' ' },
      actions: [{
        kind: 'git_reject',
        aliceId: ' ',
        params: {},
        commitHash: ' ',
        outcome: 'awaiting_approval',
        violations: [' ', {}],
      }],
      cost: {
        ...goodCost,
        inputTokens: '12',
        outputTokens: false,
        modelCostUsd: '1.25',
        allocatedServerCostUsd: '',
      },
    });
    expect(stewardDecisionLedgerEntryV3Schema.safeParse(candidate).success).toBe(true);
    await writeRawDraft(wakeId, candidate);
    await seedWakeRecord(wakeId);
    const result = runValidate(wakeId);
    expect(result.code, result.stderr).toBe(0);
    expect(await ledgerLines()).toEqual([JSON.stringify(candidate)]);
  });
});

describe('generated validate-ledger.mjs — Snapshot M1 and thesis binding (issue #174)', () => {
  it('rejects a tampered snapshot hash before acquiring the ledger lock', async () => {
    await writeDraft('wake-snapshot');
    await seedWakeRecord('wake-snapshot');
    const wake = JSON.parse(await readFile(wakePathFor('wake-snapshot'), 'utf8'));
    wake.envelope.snapshotRef.sha256 = 'f'.repeat(64);
    await writeFile(wakePathFor('wake-snapshot'), JSON.stringify(wake, null, 2), 'utf8');

    const result = runValidate('wake-snapshot');
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/snapshot hash mismatch/);
    expect(await ledgerLines()).toEqual([]);
    expect(existsSync(ledgerLockFile())).toBe(false);
  });

  it('rejects missing composite thesis coverage from the approved production fixture', async () => {
    const { entry } = await seedProofSingle((candidate) => {
      const dispositions = candidate['thesisDispositions'] as Array<Record<string, unknown>>;
      candidate['thesisDispositions'] = dispositions.filter((item) => item['instrument'] !== 'mock-simulator-1/ASSET-B');
    });
    const result = runValidate(entry['wakeId'] as string);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/disposition required thesis exactly once/);
    expect(await ledgerLines()).toEqual([]);
  });

  it('normalizes trimmed disposition identities when matching required thesis coverage', async () => {
    const { entry } = await seedProofSingle((candidate) => {
      const dispositions = candidate['thesisDispositions'] as Array<Record<string, unknown>>;
      for (const disposition of dispositions) {
        disposition['wakeId'] = ` ${String(disposition['wakeId'])} `;
        disposition['instrument'] = ` ${String(disposition['instrument'])} `;
      }
    });
    const result = runValidate(entry['wakeId'] as string);
    expect(result.code, result.stderr).toBe(0);
    expect(await ledgerLines()).toEqual([JSON.stringify(entry)]);
  });

  it('rejects snapshot thesis addresses that collide after identity trimming', async () => {
    const { entry } = await seedProofSingle((_candidate, snapshot) => {
      const history = snapshot['history'] as Record<string, unknown>;
      const openTheses = history['openTheses'] as Array<Record<string, unknown>>;
      const first = openTheses[0]!;
      openTheses.push({
        ...first,
        wakeId: ` ${String(first['wakeId'])} `,
        instrument: ` ${String(first['instrument'])} `,
      });
    });
    const result = runValidate(entry['wakeId'] as string);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/duplicate open thesis address/);
    expect(await ledgerLines()).toEqual([]);
  });

  it('rejects keeping an open thesis while a same-instrument replacement intent is proposed', async () => {
    const { entry } = await seedProofSingle((candidate) => {
      const dispositions = candidate['thesisDispositions'] as Array<Record<string, unknown>>;
      dispositions[0]!['disposition'] = 'keep';
    });
    const result = runValidate(entry['wakeId'] as string);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/cannot keep a thesis while replacing/);
    expect(await ledgerLines()).toEqual([]);
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
    await seedLedger([{ ...prior, thesis: 'rewritten', decision: 'blocked', completion: { reason: 'r', evidenceRefs: ['wake:wake-prior', 'tool:risk'] } }]);
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
  const LEGACY_V2_GOLDEN_ENTRY = {
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
  const LEGACY_V2_GOLDEN_FINGERPRINT = 'a00e0bc4ff92f38b3e7bfab09e797e73d5f9248664cee740ac1efedf4849ef9f';

  it('preserves the legacy-v2 raw hash and writes the proof-fixture v3 hash byte-identically', async () => {
    expect(canonicalDecisionFingerprint(LEGACY_V2_GOLDEN_ENTRY)).toBe(LEGACY_V2_GOLDEN_FINGERPRINT);

    const { entry: v3 } = await seedProofSingle();
    const goldens = JSON.parse(await readFile(join(d2FixtureDir, 'fingerprint-goldens.json'), 'utf8'));
    const result = runValidate(v3['wakeId'] as string);
    expect(result.code, result.stderr).toBe(0);
    const marker = JSON.parse(await readFile(markerPathFor(v3['wakeId'] as string), 'utf8'));
    expect(marker.fingerprint).toBe(goldens.ledgerV3Single);
    expect(marker.fingerprint).toBe(canonicalDecisionFingerprint(v3));
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

  it('upgrades an OLD workspace in place: v3 validator/schema/snapshot dirs, user content byte-preserved, next wake commits', async () => {
    // Simulate a workspace bootstrapped before #140: old ledger-based validator,
    // no drafts/ dir, no runtime marker.
    await writeFile(stewardFile('validate-ledger.mjs'), '// OLD LEDGER-BASED VALIDATOR\n', 'utf8');
    await rm(stewardFile('drafts'), { recursive: true, force: true });
    await rm(stewardFile('runtime.json'), { force: true });
    // Existing user content: a prior completed wake + its ledger line + config.
    const prior = await terminalWakeWithReceipt('wake-old');
    await seedLedger([prior]);
    await rm(stewardFile('snapshots'), { recursive: true, force: true });
    await rm(stewardFile('schemas'), { recursive: true, force: true });
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
    expect(existsSync(stewardFile('snapshots'))).toBe(true);
    expect(JSON.parse(await readFile(stewardFile('schemas/decision-ledger.v3.json'), 'utf8')).title).toContain('v3');
    expect(JSON.parse(await readFile(stewardFile('runtime.json'), 'utf8')).protocol).toBe(3);
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
    expect(JSON.parse(await readFile(stewardFile('runtime.json'), 'utf8')).protocol).toBe(3);
  });
});

describe('decision-ledger.v3.json auxiliary schema artifact', () => {
  it('labels validator authority and structurally constrains decision/intent nullability', async () => {
    const artifact = JSON.parse(await readFile(
      join(wsDir, '.alice/steward/schemas/decision-ledger.v3.json'),
      'utf8',
    )) as Record<string, any>;
    expect(artifact['x-openalice-role']).toBe('auxiliary-structural');
    expect(artifact['x-openalice-authoritative-validator']).toBe('.alice/steward/validate-ledger.mjs');
    expect(artifact.description).toContain('authoritative');

    const branches = artifact.allOf as Array<Record<string, any>>;
    const intentRule = (decision: string) => branches.find((branch) =>
      branch.if?.properties?.decision?.enum?.includes(decision)
    )?.then?.properties?.intent;
    expect(intentRule('no_trade')).toEqual({ type: 'null' });
    expect(intentRule('blocked')).toEqual({ type: 'null' });
    expect(intentRule('propose_change')?.oneOf).toHaveLength(2);
    expect(intentRule('reduce_risk')?.oneOf).toHaveLength(2);
    expect(intentRule('propose_change')?.oneOf).not.toContainEqual({ type: 'null' });

    const executedRule = branches.find((branch) =>
      branch.if?.properties?.actions?.contains?.properties?.outcome?.const === 'executed'
    );
    expect(executedRule?.then?.properties?.pendingHash).toEqual({ type: 'null' });
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

describe('generated README.md — mechanics only, no policy (issue #251)', () => {
  it('describes tmp/ as launcher scratch without asserting proposal-only policy', async () => {
    const readme = await readFile(join(wsDir, '.alice', 'steward', 'README.md'), 'utf8');

    expect(readme).toContain('tmp/: gitignored launcher scratch.');
    expect(readme).not.toContain('broker-mutation surface');
    expect(readme).not.toContain('contract slice');
  });
});
