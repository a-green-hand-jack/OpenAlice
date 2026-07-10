/**
 * End-to-end test of the GENERATED workspace validator, not the server-side
 * zod schema. We run the real `bootstrap.mjs` in a temp dir (plain Node, same
 * as the launcher does via ELECTRON_RUN_AS_NODE), then exercise the
 * `.alice/steward/validate-ledger.mjs` it writes against good/bad ledger
 * fixtures — the surface the steward agent actually runs at the end of a wake.
 *
 * Issue #125: the validator must enforce v2 (version literal 2, typed
 * discriminated actions, strict-pending pendingHash) and reject duplicate
 * wakeIds.
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { canonicalDecisionFingerprint } from '../../steward/ledger-receipt.js';

const here = dirname(fileURLToPath(import.meta.url));
const bootstrapPath = join(here, 'bootstrap.mjs');

let root: string;
let wsDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'steward-bootstrap-'));
  wsDir = join(root, 'ws');
  const res = spawnSync(process.execPath, [bootstrapPath, 'test-tag', wsDir], {
    encoding: 'utf8',
  });
  expect(res.status, res.stderr).toBe(0);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const goodChecklist = {
  account: 'ok',
  positions: 'ok',
  orders: 'ok',
  risk: 'NORMAL',
  market: 'open',
  history: 'checked',
};

const goodCost = {
  model: 'codex',
  inputTokens: null,
  outputTokens: null,
  modelCostUsd: null,
  allocatedServerCostUsd: null,
  tradingFeesUsd: null,
  estimatedSlippageUsd: null,
  totalEstimatedCostUsd: null,
};

function entry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 2,
    wakeId: 'wake-1',
    at: '2026-07-10T14:01:23.000Z',
    accountId: 'mock-simulator-1',
    decision: 'no_trade',
    status: 'done',
    completion: { reason: 'checklist complete; no entry signal', evidenceRefs: ['tool:risk'] },
    checklist: goodChecklist,
    thesis: 'no thesis or entry signal',
    actions: [],
    pendingHash: null,
    invalidation: 'a new entry signal would reopen the decision',
    cost: goodCost,
    ...over,
  };
}

async function runValidator(
  entries: Record<string, unknown>[],
  wakeId: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const ledgerPath = join(wsDir, '.alice', 'steward', 'ledger', 'decisions.jsonl');
  await writeFile(ledgerPath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  const res = spawnSync(
    process.execPath,
    ['.alice/steward/validate-ledger.mjs', wakeId],
    { cwd: wsDir, encoding: 'utf8' },
  );
  return { code: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
}

describe('generated steward validate-ledger.mjs (issue #125 v2)', () => {
  it('accepts a well-formed v2 no_trade entry with empty actions', async () => {
    const res = await runValidator([entry()], 'wake-1');
    expect(res.stderr).toBe('');
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('validates at line 1');
  });

  it('accepts an executed typed action with pendingHash null', async () => {
    const res = await runValidator([
      entry({
        decision: 'propose_trade',
        pendingHash: null,
        actions: [
          {
            kind: 'order_place',
            aliceId: 'mock-simulator-1/ASSET-A',
            params: { action: 'BUY', orderType: 'MKT', totalQuantity: '50' },
            commitHash: 'deadbeef',
            outcome: 'executed',
          },
        ],
      }),
    ], 'wake-1');
    expect(res.stderr).toBe('');
    expect(res.code).toBe(0);
  });

  it('rejects a commit hash parked in pendingHash after an executed outcome (D1)', async () => {
    const res = await runValidator([
      entry({
        decision: 'propose_trade',
        pendingHash: 'deadbeef',
        actions: [
          {
            kind: 'order_place',
            aliceId: 'mock-simulator-1/ASSET-A',
            params: { action: 'BUY' },
            commitHash: 'deadbeef',
            outcome: 'executed',
          },
        ],
      }),
    ], 'wake-1');
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/pendingHash must be null/);
  });

  it('rejects a version-1 entry at v2', async () => {
    const res = await runValidator([entry({ version: 1 })], 'wake-1');
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/version must be 2/);
  });

  it('rejects a free-text action string', async () => {
    const res = await runValidator([
      entry({ actions: ['placed a market buy for 50 shares'] }),
    ], 'wake-1');
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/free-text action strings are rejected/);
  });

  it('rejects a policy_denied action with no violations', async () => {
    const res = await runValidator([
      entry({
        decision: 'no_trade',
        actions: [
          {
            kind: 'order_place',
            aliceId: 'mock-simulator-1/ASSET-A',
            params: { action: 'BUY' },
            outcome: 'policy_denied',
          },
        ],
      }),
    ], 'wake-1');
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/policy_denied/);
  });

  it('rejects a duplicate wakeId (D3, first-wins)', async () => {
    const res = await runValidator([
      entry({ wakeId: 'wake-dup', thesis: 'first' }),
      entry({ wakeId: 'wake-dup', at: '2026-07-10T14:05:00.000Z', decision: 'propose_trade', thesis: 'second' }),
    ], 'wake-dup');
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/exactly one is allowed/);
  });
});

describe('generated steward validate-ledger.mjs integrity cross-check (issue #134)', () => {
  async function writeWakeRecord(rec: Record<string, unknown>): Promise<void> {
    const file = join(wsDir, '.alice', 'steward', 'wakes', `${encodeURIComponent(rec.wakeId as string)}.json`);
    await writeFile(file, `${JSON.stringify(rec, null, 2)}\n`, 'utf8');
  }

  function terminalWakeRecord(wakeId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      version: 1,
      wakeId,
      status: 'done',
      createdAt: '2026-07-10T14:00:00.000Z',
      injectedAt: '2026-07-10T14:00:05.000Z',
      completedAt: '2026-07-10T14:01:23.000Z',
      deadline: '2026-07-10T14:10:00.000Z',
      sessionId: 'sess-1',
      envelope: {
        reason: 'scheduled_observe',
        accountId: 'mock-simulator-1',
        authzLevel: 'paper',
        expectedDecision: 'no_trade',
      },
      ...over,
    };
  }

  it('passes the current wake when a prior terminal wake still matches its receipt (TS/JS fingerprint agreement)', async () => {
    const prior = entry({ wakeId: 'wake-prior', thesis: 'prior decision' });
    const current = entry({ wakeId: 'wake-cur', at: '2026-07-10T15:00:00.000Z' });
    await writeWakeRecord(terminalWakeRecord('wake-prior', {
      ledgerReceipt: {
        version: 1,
        wakeId: 'wake-prior',
        status: 'done',
        decision: 'no_trade',
        at: prior.at,
        accountId: prior.accountId,
        fingerprint: canonicalDecisionFingerprint(prior),
        recordedAt: '2026-07-10T14:02:00.000Z',
      },
    }));
    const res = await runValidator([prior, current], 'wake-cur');
    expect(res.stderr).toBe('');
    expect(res.code).toBe(0);
  });

  it('fails the current wake when a prior terminal wake\'s ledger entry disappeared (regression 4)', async () => {
    const current = entry({ wakeId: 'wake-cur', at: '2026-07-10T15:00:00.000Z' });
    // A prior done wake exists, but its ledger line is gone — only the current
    // wake's entry remains.
    await writeWakeRecord(terminalWakeRecord('wake-prior'));
    const res = await runValidator([current], 'wake-cur');
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/terminal wake wake-prior .*has no ledger entry/);
  });

  it('fails the current wake when a prior terminal wake\'s ledger entry was mutated in place', async () => {
    const original = entry({ wakeId: 'wake-prior', thesis: 'original prior decision' });
    const current = entry({ wakeId: 'wake-cur', at: '2026-07-10T15:00:00.000Z' });
    await writeWakeRecord(terminalWakeRecord('wake-prior', {
      ledgerReceipt: {
        version: 1,
        wakeId: 'wake-prior',
        status: 'done',
        decision: 'no_trade',
        at: original.at,
        accountId: original.accountId,
        fingerprint: canonicalDecisionFingerprint(original),
        recordedAt: '2026-07-10T14:02:00.000Z',
      },
    }));
    // Ledger now carries a REWRITTEN prior entry (different thesis + decision).
    const mutated = entry({ wakeId: 'wake-prior', thesis: 'rewritten', decision: 'propose_trade' });
    const res = await runValidator([mutated, current], 'wake-cur');
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/fingerprint mismatch/);
  });

  it('ignores timeout/stuck wakes in the cross-check (they carry no ledger entry)', async () => {
    const current = entry({ wakeId: 'wake-cur', at: '2026-07-10T15:00:00.000Z' });
    await writeWakeRecord(terminalWakeRecord('wake-to', { status: 'timeout' }));
    const res = await runValidator([current], 'wake-cur');
    expect(res.stderr).toBe('');
    expect(res.code).toBe(0);
  });
});
