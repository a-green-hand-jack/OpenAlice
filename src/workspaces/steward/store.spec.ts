import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  canonicalDecisionFingerprint,
  createStewardFinalizeStore,
  createStewardLedgerStore,
  createStewardLockStore,
  createStewardSupervisor,
  createStewardWakeStore,
  DECISION_LEDGER_SCHEMA_VERSION,
  DECISION_LEDGER_SCHEMA_VERSION_V1,
  parseStewardDecisionLedgerEntry,
  parseStewardDecisionLedgerEntryLenient,
  StewardLedgerStore,
  StewardLockConflictError,
  stewardStatePath,
  stewardSupervisorLogPath,
  summarizeStewardCosts,
  WAKE_SCHEMA_VERSION,
  type StewardDecisionLedgerEntryV2,
  type StewardWakeEnvelope,
} from './index.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'steward-store-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const envelope: StewardWakeEnvelope = {
  reason: 'scheduled_observe',
  accountId: 'mock-simulator-1',
  authzLevel: 'paper',
  expectedDecision: 'no_trade',
  marketContext: { symbols: ['AAPL'] },
  riskContext: { riskState: 'NORMAL', guards: [] },
};

function ledgerEntry(over: Partial<StewardDecisionLedgerEntryV2> = {}): StewardDecisionLedgerEntryV2 {
  // Issue #139: the entry's `wake:` evidence self-reference must match its own
  // top-level wakeId, so derive it from the (possibly overridden) wakeId.
  const wakeId = over.wakeId ?? '2026-07-08T14:00:00Z:aapl-risk-check';
  return {
    version: DECISION_LEDGER_SCHEMA_VERSION,
    wakeId,
    at: '2026-07-08T14:01:23.000Z',
    accountId: 'mock-simulator-1',
    decision: 'no_trade',
    status: 'done',
    context: {
      manifestPath: '.alice/steward/context-manifest.json',
      manifestSha256: 'abc123',
    },
    completion: {
      reason: 'checklist complete; no entry signal',
      evidenceRefs: [`wake:${wakeId}`, 'tool:risk'],
    },
    checklist: {
      account: 'ok',
      positions: 'ok',
      orders: 'ok',
      risk: 'NORMAL',
      market: 'open',
      history: 'checked',
    },
    thesis: 'No trade: no thesis or entry signal in this behavior wake.',
    actions: [],
    pendingHash: null,
    invalidation: 'A new explicit thesis or entry signal would reopen the decision.',
    cost: {
      model: 'codex',
      inputTokens: null,
      outputTokens: null,
      modelCostUsd: null,
      allocatedServerCostUsd: null,
      tradingFeesUsd: null,
      estimatedSlippageUsd: null,
      totalEstimatedCostUsd: null,
    },
    ...over,
  };
}

/** Issue #136: publish the finalization marker the generated validator would
 *  write, so a marker-protocol wake can terminalize on the next tick. Fingerprint
 *  matches the appended entry's canonical semantic fingerprint. */
async function publishMarker(
  wakeId: string,
  entry: Record<string, unknown>,
  validatedAt = '2026-07-08T14:01:10.000Z',
): Promise<void> {
  await createStewardFinalizeStore(dir).write({
    wakeId,
    fingerprint: canonicalDecisionFingerprint(entry),
    validatedAt,
  });
}

describe('StewardWakeStore', () => {
  it('creates a queued wake record at a cross-platform encoded wake path', async () => {
    const store = createStewardWakeStore(dir);
    const wakeId = '2026-07-08T14:00:00Z:aapl-risk-check';

    const record = await store.create({
      wakeId,
      deadline: '2026-07-08T14:03:00.000Z',
      envelope,
      now: '2026-07-08T14:00:00.000Z',
    });

    expect(record).toMatchObject({
      version: WAKE_SCHEMA_VERSION,
      wakeId,
      status: 'queued',
      createdAt: '2026-07-08T14:00:00.000Z',
      injectedAt: null,
      sessionId: null,
      envelope,
    });
    expect(store.filenameFor(wakeId)).toBe('2026-07-08T14%3A00%3A00Z%3Aaapl-risk-check.json');
    expect(existsSync(store.pathFor(wakeId))).toBe(true);
    expect(await store.get(wakeId)).toEqual(record);
  });

  it('updates status, timestamps, session id, and clears transient errors', async () => {
    const store = createStewardWakeStore(dir);
    const wakeId = 'wake-1';
    await store.create({
      wakeId,
      deadline: '2026-07-08T14:03:00.000Z',
      envelope,
      now: '2026-07-08T14:00:00.000Z',
    });

    const injected = await store.updateStatus(wakeId, 'injected', {
      now: '2026-07-08T14:00:05.000Z',
      injectedAt: '2026-07-08T14:00:05.000Z',
      sessionId: 'codex-session-1',
    });
    expect(injected.status).toBe('injected');
    expect(injected.updatedAt).toBe('2026-07-08T14:00:05.000Z');
    expect(injected.injectedAt).toBe('2026-07-08T14:00:05.000Z');
    expect(injected.sessionId).toBe('codex-session-1');

    const errored = await store.updateStatus(wakeId, 'error', {
      now: '2026-07-08T14:01:00.000Z',
      error: 'tool failed',
    });
    expect(errored.error).toBe('tool failed');

    const done = await store.updateStatus(wakeId, 'done', {
      now: '2026-07-08T14:01:23.000Z',
      completedAt: '2026-07-08T14:01:23.000Z',
      error: null,
    });
    expect(done.status).toBe('done');
    expect(done.completedAt).toBe('2026-07-08T14:01:23.000Z');
    expect(done.error).toBeUndefined();
  });

  it('lists wake records in createdAt order and refuses duplicate create', async () => {
    const store = createStewardWakeStore(dir);
    await store.create({
      wakeId: 'wake-b',
      deadline: '2026-07-08T14:03:00.000Z',
      envelope,
      now: '2026-07-08T14:00:02.000Z',
    });
    await store.create({
      wakeId: 'wake-a',
      deadline: '2026-07-08T14:03:00.000Z',
      envelope,
      now: '2026-07-08T14:00:01.000Z',
    });

    await expect(store.create({
      wakeId: 'wake-a',
      deadline: '2026-07-08T14:03:00.000Z',
      envelope,
    })).rejects.toThrow(/already exists/);

    expect((await store.list()).map((r) => r.wakeId)).toEqual(['wake-a', 'wake-b']);
  });

  it('defaults controlFace to pty and round-trips an explicit machine face (issue #146)', async () => {
    const store = createStewardWakeStore(dir);

    // Default: an ordinary create is a PTY wake.
    const pty = await store.create({
      wakeId: 'wake-pty',
      deadline: '2026-07-08T14:03:00.000Z',
      envelope,
      now: '2026-07-08T14:00:00.000Z',
    });
    expect(pty.controlFace).toBe('pty');

    // Explicit machine face persists and survives a status update.
    const machine = await store.create({
      wakeId: 'wake-machine',
      deadline: '2026-07-08T14:03:00.000Z',
      envelope,
      now: '2026-07-08T14:00:00.000Z',
      controlFace: 'machine',
      sessionId: 'thread-uuid-1',
    });
    expect(machine.controlFace).toBe('machine');
    expect((await store.get('wake-machine'))?.controlFace).toBe('machine');

    const injected = await store.updateStatus('wake-machine', 'injected', {
      now: '2026-07-08T14:00:05.000Z',
      injectedAt: '2026-07-08T14:00:05.000Z',
      sessionId: 'thread-uuid-1',
    });
    expect(injected.controlFace).toBe('machine');
  });

  it('reads a legacy record with no controlFace field as pty (issue #146)', async () => {
    const store = createStewardWakeStore(dir);
    await store.create({
      wakeId: 'wake-legacy',
      deadline: '2026-07-08T14:03:00.000Z',
      envelope,
      now: '2026-07-08T14:00:00.000Z',
    });

    // Simulate a pre-#146 on-disk record: strip the field the older writer
    // never emitted, then confirm the reader defaults it to 'pty'.
    const path = store.pathFor('wake-legacy');
    const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    delete raw.controlFace;
    await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    expect('controlFace' in raw).toBe(false);

    expect((await store.get('wake-legacy'))?.controlFace).toBe('pty');
  });
});

describe('StewardLedgerStore', () => {
  it('appends and reads validated decision ledger entries', async () => {
    const store = createStewardLedgerStore(dir);
    const first = await store.append(ledgerEntry({ wakeId: 'wake-1', at: '2026-07-08T14:01:00.000Z' }));
    const second = await store.append(ledgerEntry({ wakeId: 'wake-2', at: '2026-07-08T14:02:00.000Z' }));

    expect(await store.read()).toEqual([first, second]);
    expect(await store.read({ limit: 1 })).toEqual([second]);
    expect(await store.read({ wakeId: 'wake-1' })).toEqual([first]);
    expect(await store.findByWakeId('wake-2')).toEqual(second);
    expect(await store.findByWakeId('missing')).toBeNull();

    const raw = await readFile(store.path(), 'utf8');
    expect(raw.trim().split('\n')).toHaveLength(2);
  });

  it('requires completion.reason and the full cost field set', async () => {
    const store = createStewardLedgerStore(dir);

    await expect(store.append(ledgerEntry({
      completion: { reason: '', evidenceRefs: ['wake:wake-1'] },
    }))).rejects.toThrow();

    const missingCostField = ledgerEntry() as unknown as { cost: Record<string, unknown> };
    delete missingCostField.cost.totalEstimatedCostUsd;
    await expect(store.append(missingCostField as unknown as StewardDecisionLedgerEntryV2)).rejects.toThrow();
  });

  it('coerces numeric-string cost fields to actual numbers (a smaller model\'s observed mistake)', async () => {
    const store = createStewardLedgerStore(dir);
    // A well-formed entry, but with every numeric `cost` field written as a
    // JSON string -- exactly what a claude-haiku-4-5-20251001 steward session
    // was observed producing live. Built as a plain object (not the typed
    // `ledgerEntry()` helper) since the whole point is that these fields are
    // NOT the number type the schema declares.
    const rawEntry = {
      ...ledgerEntry({ wakeId: 'wake-str-cost' }),
      cost: {
        model: 'claude-haiku-4-5-20251001',
        inputTokens: '120',
        outputTokens: '45',
        modelCostUsd: '0.01',
        allocatedServerCostUsd: '0',
        tradingFeesUsd: '0',
        estimatedSlippageUsd: '0',
        totalEstimatedCostUsd: '0',
      },
    };

    await mkdir(dirname(store.path()), { recursive: true });
    await writeFile(store.path(), `${JSON.stringify(rawEntry)}\n`, 'utf8');

    const entries = await store.read();
    expect(entries).toHaveLength(1);
    expect(entries[0].cost.tradingFeesUsd).toBe(0);
    expect(typeof entries[0].cost.tradingFeesUsd).toBe('number');
    expect(entries[0].cost.estimatedSlippageUsd).toBe(0);
    expect(typeof entries[0].cost.estimatedSlippageUsd).toBe('number');
    expect(entries[0].cost.totalEstimatedCostUsd).toBe(0);
    expect(entries[0].cost.modelCostUsd).toBeCloseTo(0.01);
    expect(typeof entries[0].cost.modelCostUsd).toBe('number');
    expect(entries[0].cost.inputTokens).toBe(120);
    expect(typeof entries[0].cost.inputTokens).toBe('number');
    expect(entries[0].cost.outputTokens).toBe(45);
    expect(typeof entries[0].cost.outputTokens).toBe('number');

    // parseStewardDecisionLedgerEntry (also used directly by `append`) applies
    // the same coercion independent of the store's read-from-disk path, and a
    // real `null` cost value must still parse as `null`, not get coerced to 0.
    const parsedDirectly = parseStewardDecisionLedgerEntry(rawEntry);
    expect(parsedDirectly.cost.tradingFeesUsd).toBe(0);
    expect(typeof parsedDirectly.cost.tradingFeesUsd).toBe('number');
    const withNullCost = parseStewardDecisionLedgerEntry({
      ...rawEntry,
      cost: { ...rawEntry.cost, tradingFeesUsd: null },
    });
    expect(withNullCost.cost.tradingFeesUsd).toBeNull();
  });

  it('skips a genuinely malformed ledger line without throwing, and still returns every other valid entry', async () => {
    const store = createStewardLedgerStore(dir);
    const good1 = ledgerEntry({ wakeId: 'wake-good-1', at: '2026-07-08T14:01:00.000Z' });
    const good2 = ledgerEntry({ wakeId: 'wake-good-2', at: '2026-07-08T14:02:00.000Z' });
    const missingDecision = { ...ledgerEntry({ wakeId: 'wake-missing-decision' }) } as Record<string, unknown>;
    delete missingDecision.decision;

    await mkdir(dirname(store.path()), { recursive: true });
    await writeFile(
      store.path(),
      [
        JSON.stringify(good1),
        'not valid json at all',
        JSON.stringify(missingDecision),
        JSON.stringify(good2),
      ].join('\n') + '\n',
      'utf8',
    );

    const entries = await store.read();
    expect(entries.map((e) => e.wakeId)).toEqual(['wake-good-1', 'wake-good-2']);

    const diagnostics = await store.readDiagnostics();
    expect(diagnostics.entries.map((e) => e.wakeId)).toEqual(['wake-good-1', 'wake-good-2']);
    expect(diagnostics.invalid).toHaveLength(2);
    expect(diagnostics.invalid[0].line).toBe(2);
    expect(diagnostics.invalid[1].line).toBe(3);

    // findByWakeId, built on read(), sees neither the invalid-JSON line nor
    // the missing-field line as a match -- it doesn't throw either.
    expect(await store.findByWakeId('wake-missing-decision')).toBeNull();
    expect((await store.findByWakeId('wake-good-2'))?.wakeId).toBe('wake-good-2');
  });

  // --- Issue #125: v2 ledger contract -----------------------------------

  it('accepts an executed-action terminal entry with pendingHash null', async () => {
    const store = createStewardLedgerStore(dir);
    const entry = ledgerEntry({
      wakeId: 'wake-executed',
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
    });

    const appended = await store.append(entry);
    expect(appended.actions).toHaveLength(1);
    expect((appended.actions[0] as { commitHash?: string }).commitHash).toBe('deadbeef');
    expect(appended.pendingHash).toBeNull();
  });

  it('rejects a v2 entry that parks a commit hash in pendingHash after an executed outcome (D1)', async () => {
    const store = createStewardLedgerStore(dir);
    await expect(store.append(ledgerEntry({
      wakeId: 'wake-bad-pending',
      decision: 'propose_trade',
      // Provenance belongs in actions[].commitHash; pendingHash is strictly the
      // stage awaiting approval and MUST be null once anything executed.
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
    }))).rejects.toThrow(/pendingHash must be null/);
  });

  it('keeps pendingHash for an awaiting_approval action', async () => {
    const store = createStewardLedgerStore(dir);
    const appended = await store.append(ledgerEntry({
      wakeId: 'wake-awaiting',
      decision: 'propose_trade',
      pendingHash: 'abc12345',
      actions: [
        {
          kind: 'order_commit',
          aliceId: 'mock-simulator-1/ASSET-A',
          params: { action: 'BUY' },
          commitHash: 'abc12345',
          outcome: 'awaiting_approval',
        },
      ],
    }));
    expect(appended.pendingHash).toBe('abc12345');
  });

  it('requires violations on a policy_denied action', async () => {
    const store = createStewardLedgerStore(dir);
    await expect(store.append(ledgerEntry({
      wakeId: 'wake-denied-noviol',
      decision: 'propose_trade',
      pendingHash: null,
      actions: [
        {
          kind: 'order_place',
          aliceId: 'mock-simulator-1/ASSET-A',
          params: { action: 'BUY' },
          outcome: 'policy_denied',
        },
      ],
    }))).rejects.toThrow(/violations/);

    const ok = await store.append(ledgerEntry({
      wakeId: 'wake-denied-ok',
      decision: 'no_trade',
      pendingHash: null,
      actions: [
        {
          kind: 'order_place',
          aliceId: 'mock-simulator-1/ASSET-A',
          params: { action: 'BUY' },
          outcome: 'policy_denied',
          violations: [{ reason: 'stopLoss too wide' }],
        },
      ],
    }));
    expect(ok.actions).toHaveLength(1);
  });

  it('rejects a free-text action string at v2, but reads a legacy v1 line via the lenient path', async () => {
    const store = createStewardLedgerStore(dir);

    // v2 write path: a free-text action string is not a typed action object.
    await expect(store.append(ledgerEntry({
      wakeId: 'wake-freetext',
      actions: ['placed a market buy for 50 shares'] as unknown as StewardDecisionLedgerEntryV2['actions'],
    }))).rejects.toThrow();

    // v1 legacy history: the same free-text action array is still READABLE
    // (reads stay lenient), typed as legacy unknown[].
    const legacy = {
      ...ledgerEntry({ wakeId: 'wake-legacy-v1' }),
      version: DECISION_LEDGER_SCHEMA_VERSION_V1,
      actions: ['free text is fine for v1 history'],
    };
    await mkdir(dirname(store.path()), { recursive: true });
    await writeFile(store.path(), `${JSON.stringify(legacy)}\n`, 'utf8');

    const entries = await store.read();
    expect(entries.map((e) => e.wakeId)).toEqual(['wake-legacy-v1']);
    expect(entries[0].version).toBe(DECISION_LEDGER_SCHEMA_VERSION_V1);
    expect(entries[0].actions).toEqual(['free text is fine for v1 history']);

    // The lenient parser also accepts it directly; the strict v2 parser does not.
    expect(parseStewardDecisionLedgerEntryLenient(legacy).wakeId).toBe('wake-legacy-v1');
    expect(() => parseStewardDecisionLedgerEntry(legacy)).toThrow();
  });

  // --- Issue #139: evidence self-reference must match top-level wakeId -----

  it('rejects an entry whose wake: evidence self-reference names a DIFFERENT wake (copied id)', async () => {
    const store = createStewardLedgerStore(dir);
    await expect(store.append(ledgerEntry({
      wakeId: 'wake-real',
      completion: { reason: 'done', evidenceRefs: ['wake:wake-copied-from-prior', 'tool:risk'] },
    }))).rejects.toThrow(/different wake|self-reference/);
  });

  it('rejects an entry with no wake: self-reference at all', async () => {
    const store = createStewardLedgerStore(dir);
    await expect(store.append(ledgerEntry({
      wakeId: 'wake-noself',
      completion: { reason: 'done', evidenceRefs: ['tool:risk'] },
    }))).rejects.toThrow(/self-reference/);
  });

  it('read-lenient / write-strict for the #139 self-reference (restores #125 semantics)', () => {
    // A pre-#139 v2 history line has no wake:<self> reference.
    const legacyV2MissingSelfRef = {
      ...ledgerEntry({ wakeId: 'wake-legacy-v2' }),
      completion: { reason: 'done', evidenceRefs: ['tool:risk'] },
    };
    // STRICT write path rejects it (missing self-ref)...
    expect(() => parseStewardDecisionLedgerEntry(legacyV2MissingSelfRef)).toThrow(/self-reference/);
    // ...but the LENIENT read path still accepts it as a structural v2 entry, so
    // historical reads / cost aggregation don't silently drop it.
    const read = parseStewardDecisionLedgerEntryLenient(legacyV2MissingSelfRef);
    expect(read.wakeId).toBe('wake-legacy-v2');
    expect(read.version).toBe(DECISION_LEDGER_SCHEMA_VERSION);

    // The v8matrix5 hybrid (evidence names a DIFFERENT wake) is rejected strict...
    const hybrid = {
      ...ledgerEntry({ wakeId: 'wake-a' }),
      completion: { reason: 'done', evidenceRefs: ['wake:wake-b', 'tool:risk'] },
    };
    expect(() => parseStewardDecisionLedgerEntry(hybrid)).toThrow(/different wake/);
    // ...and still readable structurally (it's the validator/marker/active-wake
    // gate that blocks it from finalizing, not the reader).
    expect(parseStewardDecisionLedgerEntryLenient(hybrid).wakeId).toBe('wake-a');
  });

  it('surfaces a misfiled entry (evidence names another wake) as an identity mismatch in the index (read-lenient / write-strict)', async () => {
    const store = createStewardLedgerStore(dir);
    const misfiled = {
      ...ledgerEntry({ wakeId: 'wake-typo-suffix' }),
      completion: { reason: 'done', evidenceRefs: ['wake:wake-actually-active', 'tool:risk'] },
    };
    // The STRICT write path rejects the contradictory self-reference (#139)...
    await expect(store.append(misfiled as unknown as StewardDecisionLedgerEntryV2)).rejects.toThrow(/different wake/);

    // ...but a raw line on disk still READS leniently (structural v2), so it
    // counts for cost/history — while identityMismatches flags it so the
    // supervisor can act on it.
    await mkdir(dirname(store.path()), { recursive: true });
    await writeFile(store.path(), `${JSON.stringify(misfiled)}\n`, 'utf8');
    const index = await store.readIndex();
    expect(index.identityMismatches).toEqual([
      { line: 1, entryWakeId: 'wake-typo-suffix', referencedWakeId: 'wake-actually-active' },
    ]);
    expect(index.firstWins.get('wake-typo-suffix')?.valid).toBe(true); // lenient read accepts it
  });

  it('takes the first entry on a duplicate wakeId and reports the duplicate (D3)', async () => {
    const store = createStewardLedgerStore(dir);
    const first = ledgerEntry({
      wakeId: 'wake-dup',
      at: '2026-07-08T14:01:00.000Z',
      decision: 'no_trade',
      thesis: 'first-wins entry is authoritative',
    });
    const second = ledgerEntry({
      wakeId: 'wake-dup',
      at: '2026-07-08T14:05:00.000Z',
      decision: 'propose_trade',
      thesis: 'a later append can never alter the recorded decision',
    });

    await mkdir(dirname(store.path()), { recursive: true });
    await writeFile(
      store.path(),
      `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`,
      'utf8',
    );

    // Reader returns the FIRST entry.
    const found = await store.findByWakeId('wake-dup');
    expect(found?.thesis).toBe('first-wins entry is authoritative');
    expect(found?.decision).toBe('no_trade');

    // Diagnostics surface the later duplicate as a violation.
    const diagnostics = await store.readDiagnostics();
    expect(diagnostics.duplicates).toEqual([
      { wakeId: 'wake-dup', firstLine: 1, duplicateLine: 2 },
    ]);
  });

  it('does not double-count a duplicate wakeId in cost aggregation (code review: cost.ts double-count)', async () => {
    // The earlier D3 duplicate test above uses ledgerEntry()'s default null
    // cost fields, which masks double-counting (null contributes 0 either
    // way). This test uses real non-null numeric cost fields on BOTH the
    // first entry and its later duplicate, so a naive entries.length /
    // summed-over-every-line aggregation would inflate cost.entries and
    // every USD field -- the exact state.json truth surface
    // tools/campaigns/run-cell.mjs reads as ledgerReportedCostUsd.
    const costFields = (overrides: Partial<Record<string, number>> = {}) => ({
      model: 'codex',
      inputTokens: 100,
      outputTokens: 50,
      modelCostUsd: 1,
      allocatedServerCostUsd: 0.5,
      tradingFeesUsd: 0.25,
      estimatedSlippageUsd: 0.1,
      totalEstimatedCostUsd: 1.85,
      ...overrides,
    });

    const store = createStewardLedgerStore(dir);
    const first = ledgerEntry({
      wakeId: 'wake-cost-dup',
      at: '2026-07-08T14:01:00.000Z',
      cost: costFields(),
    });
    // A later duplicate carrying its OWN non-null cost -- must be excluded
    // from aggregation entirely (first-wins), not just have its cost ignored.
    const duplicate = ledgerEntry({
      wakeId: 'wake-cost-dup',
      at: '2026-07-08T14:05:00.000Z',
      cost: costFields({ modelCostUsd: 999, totalEstimatedCostUsd: 999.85 }),
    });
    const other = ledgerEntry({
      wakeId: 'wake-other',
      at: '2026-07-08T14:02:00.000Z',
      cost: costFields({ modelCostUsd: 2, totalEstimatedCostUsd: 2.85 }),
    });

    await mkdir(dirname(store.path()), { recursive: true });
    await writeFile(
      store.path(),
      `${JSON.stringify(first)}\n${JSON.stringify(other)}\n${JSON.stringify(duplicate)}\n`,
      'utf8',
    );

    // readDiagnostics().entries still returns all 3 raw lines (audit trail).
    const allEntries = await store.read();
    expect(allEntries).toHaveLength(3);

    // Cost aggregation is first-wins per wakeId: 2 distinct wakes, and the
    // duplicate's inflated 999 must never be counted.
    const summary = summarizeStewardCosts(allEntries);
    expect(summary.entries).toBe(2);
    expect(summary.modelCostUsd).toBeCloseTo(1 + 2);
    expect(summary.totalEstimatedCostUsd).toBeCloseTo(1.85 + 2.85);
  });
});

describe('StewardLockStore', () => {
  it('guards one active wake per account and allows expired lock replacement', async () => {
    const store = createStewardLockStore(dir);
    const first = await store.acquire({
      accountId: 'mock-simulator-1',
      wakeId: 'wake-1',
      now: '2026-07-08T14:00:00.000Z',
      expiresAt: '2026-07-08T14:03:00.000Z',
    });

    expect(first.accountId).toBe('mock-simulator-1');
    expect(store.filenameFor('mock/simulator:1')).toBe('mock%2Fsimulator%3A1.json');
    await expect(store.acquire({
      accountId: 'mock-simulator-1',
      wakeId: 'wake-2',
      now: '2026-07-08T14:01:00.000Z',
      expiresAt: '2026-07-08T14:04:00.000Z',
    })).rejects.toBeInstanceOf(StewardLockConflictError);

    const replacement = await store.acquire({
      accountId: 'mock-simulator-1',
      wakeId: 'wake-2',
      now: '2026-07-08T14:03:01.000Z',
      expiresAt: '2026-07-08T14:06:00.000Z',
    });
    expect(replacement.wakeId).toBe('wake-2');
    expect(await store.release('mock-simulator-1', 'wake-1')).toBe(false);
    expect(await store.release('mock-simulator-1', 'wake-2')).toBe(true);
    expect(await store.get('mock-simulator-1')).toBeNull();
  });
});

describe('StewardSupervisor', () => {
  it('marks ledger-completed wakes done, releases locks, and writes cost state', async () => {
    const wakeStore = createStewardWakeStore(dir);
    const ledgerStore = createStewardLedgerStore(dir);
    const lockStore = createStewardLockStore(dir);
    await wakeStore.create({
      wakeId: 'wake-1',
      deadline: '2026-07-08T14:03:00.000Z',
      envelope,
      now: '2026-07-08T14:00:00.000Z',
    });
    await wakeStore.updateStatus('wake-1', 'injected', {
      now: '2026-07-08T14:00:05.000Z',
      injectedAt: '2026-07-08T14:00:05.000Z',
      sessionId: 'codex-session-1',
    });
    await lockStore.acquire({
      accountId: envelope.accountId,
      wakeId: 'wake-1',
      now: '2026-07-08T14:00:00.000Z',
      expiresAt: '2026-07-08T14:03:00.000Z',
    });
    const wake1Entry = ledgerEntry({
      wakeId: 'wake-1',
      cost: {
        model: 'codex',
        inputTokens: 100,
        outputTokens: 50,
        modelCostUsd: 180,
        allocatedServerCostUsd: 1,
        tradingFeesUsd: 2,
        estimatedSlippageUsd: 3,
        totalEstimatedCostUsd: null,
      },
    });
    await ledgerStore.append(wake1Entry);
    await publishMarker('wake-1', wake1Entry);

    const result = await createStewardSupervisor(dir).tick({
      now: '2026-07-08T14:01:30.000Z',
      isSessionRunning: () => true,
      config: { monthlyBudget: { modelUsd: 200 }, costPolicy: { warnAtPct: 80 } },
    });

    expect(result.transitions).toEqual([{
      wakeId: 'wake-1',
      from: 'injected',
      to: 'done',
      reason: 'ledger:done',
    }]);
    expect((await wakeStore.get('wake-1'))?.status).toBe('done');
    expect(await lockStore.get(envelope.accountId)).toBeNull();
    expect(result.cost).toMatchObject({
      entries: 1,
      inputTokens: 100,
      outputTokens: 50,
      modelCostUsd: 180,
      totalEstimatedCostUsd: 186,
    });
    expect(result.warnings).toHaveLength(1);

    const state = JSON.parse(await readFile(stewardStatePath(dir), 'utf8')) as { cost: { entries: number } };
    expect(state.cost.entries).toBe(1);
    const log = await readFile(stewardSupervisorLogPath(dir), 'utf8');
    expect(log).toContain('"type":"wake_completed"');
    expect(log).toContain('"type":"cost_summary"');
  });

  it('reconciles a good wake even when another wake\'s ledger line is malformed', async () => {
    const wakeStore = createStewardWakeStore(dir);
    const lockStore = createStewardLockStore(dir);
    const ledgerStore = createStewardLedgerStore(dir);
    const badEnvelope: StewardWakeEnvelope = { ...envelope, accountId: 'mock-simulator-2' };

    // wake-good: a normal wake with a well-formed ledger entry -> should
    // reconcile to 'done' same as any other tick.
    await wakeStore.create({
      wakeId: 'wake-good',
      deadline: '2026-07-08T14:03:00.000Z',
      envelope,
      now: '2026-07-08T14:00:00.000Z',
    });
    await wakeStore.updateStatus('wake-good', 'injected', {
      now: '2026-07-08T14:00:05.000Z',
      injectedAt: '2026-07-08T14:00:05.000Z',
      sessionId: 'session-good',
    });
    await lockStore.acquire({
      accountId: envelope.accountId,
      wakeId: 'wake-good',
      now: '2026-07-08T14:00:00.000Z',
      expiresAt: '2026-07-08T14:03:00.000Z',
    });

    // wake-bad: a DIFFERENT wake (different account) whose ledger line is
    // genuinely malformed (missing `decision`) -- must not block wake-good's
    // reconciliation in the same tick.
    await wakeStore.create({
      wakeId: 'wake-bad',
      deadline: '2026-07-08T14:03:00.000Z',
      envelope: badEnvelope,
      now: '2026-07-08T14:00:00.000Z',
    });
    await wakeStore.updateStatus('wake-bad', 'injected', {
      now: '2026-07-08T14:00:05.000Z',
      injectedAt: '2026-07-08T14:00:05.000Z',
      sessionId: 'session-bad',
    });
    await lockStore.acquire({
      accountId: 'mock-simulator-2',
      wakeId: 'wake-bad',
      now: '2026-07-08T14:00:00.000Z',
      expiresAt: '2026-07-08T14:03:00.000Z',
    });

    const goodEntry = ledgerEntry({ wakeId: 'wake-good', at: '2026-07-08T14:01:00.000Z' });
    const badEntry = {
      ...ledgerEntry({ wakeId: 'wake-bad', at: '2026-07-08T14:01:05.000Z' }),
    } as Record<string, unknown>;
    delete badEntry.decision;

    await mkdir(dirname(ledgerStore.path()), { recursive: true });
    await writeFile(
      ledgerStore.path(),
      `${JSON.stringify(goodEntry)}\n${JSON.stringify(badEntry)}\n`,
      'utf8',
    );
    await publishMarker('wake-good', goodEntry);

    const result = await createStewardSupervisor(dir).tick({
      now: '2026-07-08T14:01:30.000Z',
      isSessionRunning: () => true,
    });

    expect(result.transitions).toContainEqual({
      wakeId: 'wake-good',
      from: 'injected',
      to: 'done',
      reason: 'ledger:done',
    });
    expect((await wakeStore.get('wake-good'))?.status).toBe('done');
    expect(await lockStore.get(envelope.accountId)).toBeNull();

    // wake-bad has no PARSEABLE ledger entry this tick (its line was skipped,
    // not thrown), so the supervisor simply falls through to its
    // deadline/liveness checks same as "no entry yet" -- it does NOT crash the
    // whole tick, and wake-good still reconciled above.
    expect((await wakeStore.get('wake-bad'))?.status).toBe('injected');
    expect(await lockStore.get('mock-simulator-2')).not.toBeNull();
  });

  it('marks injected wakes stuck when the session is gone before deadline', async () => {
    const wakeStore = createStewardWakeStore(dir);
    const lockStore = createStewardLockStore(dir);
    await wakeStore.create({
      wakeId: 'wake-stuck',
      deadline: '2026-07-08T14:03:00.000Z',
      envelope,
      now: '2026-07-08T14:00:00.000Z',
    });
    await wakeStore.updateStatus('wake-stuck', 'injected', {
      now: '2026-07-08T14:00:05.000Z',
      injectedAt: '2026-07-08T14:00:05.000Z',
      sessionId: 'missing-session',
    });
    await lockStore.acquire({
      accountId: envelope.accountId,
      wakeId: 'wake-stuck',
      now: '2026-07-08T14:00:00.000Z',
      expiresAt: '2026-07-08T14:03:00.000Z',
    });

    const result = await createStewardSupervisor(dir).tick({
      now: '2026-07-08T14:01:00.000Z',
      isSessionRunning: () => false,
    });

    expect(result.transitions[0]).toMatchObject({
      wakeId: 'wake-stuck',
      from: 'injected',
      to: 'stuck',
      reason: 'session_not_running',
    });
    expect((await wakeStore.get('wake-stuck'))?.status).toBe('stuck');
    expect(await lockStore.get(envelope.accountId)).toBeNull();
  });

  it('reconciles across a mixed v1+v2 ledger and warns on a duplicate wakeId (D3)', async () => {
    const wakeStore = createStewardWakeStore(dir);
    const lockStore = createStewardLockStore(dir);
    const ledgerStore = createStewardLedgerStore(dir);
    const v2Envelope: StewardWakeEnvelope = { ...envelope, accountId: 'mock-simulator-2' };

    // wake-v1: a legacy v1 history entry (free-text actions), still a valid
    // terminal marker on the lenient read path.
    await wakeStore.create({
      wakeId: 'wake-v1',
      deadline: '2026-07-08T14:03:00.000Z',
      envelope,
      now: '2026-07-08T14:00:00.000Z',
    });
    await wakeStore.updateStatus('wake-v1', 'injected', {
      now: '2026-07-08T14:00:05.000Z',
      injectedAt: '2026-07-08T14:00:05.000Z',
      sessionId: 'session-v1',
    });
    await lockStore.acquire({
      accountId: envelope.accountId,
      wakeId: 'wake-v1',
      now: '2026-07-08T14:00:00.000Z',
      expiresAt: '2026-07-08T14:03:00.000Z',
    });

    // wake-v2: a strict v2 entry with a typed executed action.
    await wakeStore.create({
      wakeId: 'wake-v2',
      deadline: '2026-07-08T14:03:00.000Z',
      envelope: v2Envelope,
      now: '2026-07-08T14:00:00.000Z',
    });
    await wakeStore.updateStatus('wake-v2', 'injected', {
      now: '2026-07-08T14:00:05.000Z',
      injectedAt: '2026-07-08T14:00:05.000Z',
      sessionId: 'session-v2',
    });
    await lockStore.acquire({
      accountId: 'mock-simulator-2',
      wakeId: 'wake-v2',
      now: '2026-07-08T14:00:00.000Z',
      expiresAt: '2026-07-08T14:03:00.000Z',
    });

    const v1Entry = {
      ...ledgerEntry({ wakeId: 'wake-v1', at: '2026-07-08T14:01:00.000Z' }),
      version: DECISION_LEDGER_SCHEMA_VERSION_V1,
      actions: ['legacy free-text action'],
    };
    const v2Entry = ledgerEntry({
      wakeId: 'wake-v2',
      at: '2026-07-08T14:01:05.000Z',
      accountId: 'mock-simulator-2',
      decision: 'propose_trade',
      pendingHash: null,
      actions: [
        {
          kind: 'order_place',
          aliceId: 'mock-simulator-2/ASSET-A',
          params: { action: 'BUY' },
          commitHash: 'feedface',
          outcome: 'executed',
        },
      ],
    });
    // A later duplicate of wake-v1 that must NOT alter the recorded decision.
    const v1Dup = ledgerEntry({
      wakeId: 'wake-v1',
      at: '2026-07-08T14:02:00.000Z',
      decision: 'propose_trade',
    });

    await mkdir(dirname(ledgerStore.path()), { recursive: true });
    await writeFile(
      ledgerStore.path(),
      `${JSON.stringify(v1Entry)}\n${JSON.stringify(v2Entry)}\n${JSON.stringify(v1Dup)}\n`,
      'utf8',
    );
    await publishMarker('wake-v1', v1Entry);
    await publishMarker('wake-v2', v2Entry);

    const result = await createStewardSupervisor(dir).tick({
      now: '2026-07-08T14:01:30.000Z',
      isSessionRunning: () => true,
    });

    // Both the v1-history and the v2 wake reconcile to done in the same tick.
    expect(result.transitions).toContainEqual({
      wakeId: 'wake-v1',
      from: 'injected',
      to: 'done',
      reason: 'ledger:done',
    });
    expect(result.transitions).toContainEqual({
      wakeId: 'wake-v2',
      from: 'injected',
      to: 'done',
      reason: 'ledger:done',
    });
    expect((await wakeStore.get('wake-v1'))?.status).toBe('done');
    expect((await wakeStore.get('wake-v2'))?.status).toBe('done');

    // The later duplicate of wake-v1 is surfaced as a warning, not silently
    // taken as the decision.
    expect(result.warnings.some((w) => w.includes('duplicate ledger entry for wake wake-v1'))).toBe(true);
    const log = await readFile(stewardSupervisorLogPath(dir), 'utf8');
    expect(log).toContain('"type":"ledger_duplicates"');
  });

  it('surfaces an invalid (unparseable) ledger line as a warning + event (code review: silent invalid lines)', async () => {
    const wakeStore = createStewardWakeStore(dir);
    const lockStore = createStewardLockStore(dir);
    const ledgerStore = createStewardLedgerStore(dir);

    // wake-invalid: its ledger line is missing `decision`, so it never
    // reconciles via findByWakeId -- without this fix it would just sit
    // `injected` until timeout with no visible cause.
    await wakeStore.create({
      wakeId: 'wake-invalid',
      deadline: '2026-07-08T14:03:00.000Z',
      envelope,
      now: '2026-07-08T14:00:00.000Z',
    });
    await wakeStore.updateStatus('wake-invalid', 'injected', {
      now: '2026-07-08T14:00:05.000Z',
      injectedAt: '2026-07-08T14:00:05.000Z',
      sessionId: 'session-invalid',
    });
    await lockStore.acquire({
      accountId: envelope.accountId,
      wakeId: 'wake-invalid',
      now: '2026-07-08T14:00:00.000Z',
      expiresAt: '2026-07-08T14:03:00.000Z',
    });

    const badEntry = { ...ledgerEntry({ wakeId: 'wake-invalid' }) } as Record<string, unknown>;
    delete badEntry.decision;

    await mkdir(dirname(ledgerStore.path()), { recursive: true });
    await writeFile(ledgerStore.path(), `${JSON.stringify(badEntry)}\n`, 'utf8');

    const result = await createStewardSupervisor(dir).tick({
      now: '2026-07-08T14:01:30.000Z',
      isSessionRunning: () => true,
    });

    // Not reconciled (no parseable ledger entry), but the cause is now visible.
    expect((await wakeStore.get('wake-invalid'))?.status).toBe('injected');
    expect(result.warnings.some((w) => w.startsWith('invalid ledger line 1:'))).toBe(true);
    const log = await readFile(stewardSupervisorLogPath(dir), 'utf8');
    expect(log).toContain('"type":"ledger_invalid_lines"');
  });
});

describe('StewardSupervisor ledger integrity (issue #134)', () => {
  async function seedInjectedWake(wakeId: string, accountId: string = envelope.accountId): Promise<void> {
    const wakeStore = createStewardWakeStore(dir);
    const lockStore = createStewardLockStore(dir);
    await wakeStore.create({
      wakeId,
      deadline: '2026-07-08T14:03:00.000Z',
      envelope: { ...envelope, accountId },
      now: '2026-07-08T14:00:00.000Z',
    });
    await wakeStore.updateStatus(wakeId, 'injected', {
      now: '2026-07-08T14:00:05.000Z',
      injectedAt: '2026-07-08T14:00:05.000Z',
      sessionId: 'sess-integrity',
    });
    await lockStore.acquire({
      accountId,
      wakeId,
      now: '2026-07-08T14:00:00.000Z',
      expiresAt: '2026-07-08T14:03:00.000Z',
    });
  }

  it('records a corruption-evidence receipt on the first terminal reconciliation', async () => {
    const ledgerStore = createStewardLedgerStore(dir);
    await seedInjectedWake('wake-r1');
    const r1Entry = ledgerEntry({ wakeId: 'wake-r1' });
    await ledgerStore.append(r1Entry);
    await publishMarker('wake-r1', r1Entry);

    await createStewardSupervisor(dir).tick({ now: '2026-07-08T14:01:30.000Z', isSessionRunning: () => true });

    const wake = await createStewardWakeStore(dir).get('wake-r1');
    expect(wake?.status).toBe('done');
    expect(wake?.ledgerReceipt).toMatchObject({
      version: 1,
      wakeId: 'wake-r1',
      status: 'done',
      decision: 'no_trade',
    });
    expect(typeof wake?.ledgerReceipt?.fingerprint).toBe('string');
    expect(wake?.ledgerReceipt?.fingerprint.length).toBeGreaterThan(0);
    expect(wake?.ledgerReceipt?.bootstrapped).toBeUndefined();
  });

  it('emits a ledger_integrity_violation when a completed wake\'s ledger line is deleted (issue #134 regression 1)', async () => {
    const ledgerStore = createStewardLedgerStore(dir);
    await seedInjectedWake('wake-del');
    const delEntry = ledgerEntry({ wakeId: 'wake-del' });
    await ledgerStore.append(delEntry);
    await publishMarker('wake-del', delEntry);

    // Tick 1: transition to done + record receipt.
    const first = await createStewardSupervisor(dir).tick({ now: '2026-07-08T14:01:30.000Z', isSessionRunning: () => true });
    expect(first.transitions[0]).toMatchObject({ wakeId: 'wake-del', to: 'done' });
    expect(first.warnings.some((w) => w.includes('ledger integrity violation'))).toBe(false);

    // The persistent session deletes and rebuilds the ledger from a later week,
    // dropping wake-del's line entirely.
    await writeFile(ledgerStore.path(), '', 'utf8');

    // Tick 2: the terminal wake is re-reconciled and the loss is detected.
    const second = await createStewardSupervisor(dir).tick({ now: '2026-07-08T14:05:00.000Z', isSessionRunning: () => true });
    expect((await createStewardWakeStore(dir).get('wake-del'))?.status).toBe('done');
    expect(second.warnings.some((w) => w.includes('ledger integrity violation for wake wake-del'))).toBe(true);
    const log = await readFile(stewardSupervisorLogPath(dir), 'utf8');
    expect(log).toContain('"type":"ledger_integrity_violation"');
    expect(log).toContain('"kind":"entry_missing"');
  });

  it('emits a ledger_integrity_violation when the first-wins entry is mutated in place (issue #134 regression 2)', async () => {
    const ledgerStore = createStewardLedgerStore(dir);
    await seedInjectedWake('wake-mut');
    const mutOriginal = ledgerEntry({ wakeId: 'wake-mut', thesis: 'original thesis' });
    await ledgerStore.append(mutOriginal);
    await publishMarker('wake-mut', mutOriginal);
    await createStewardSupervisor(dir).tick({ now: '2026-07-08T14:01:30.000Z', isSessionRunning: () => true });

    // A whitespace/format-only rewrite must NOT trip the alarm (requirement 7):
    // re-serialize the same entry with indentation, on one line.
    const original = ledgerEntry({ wakeId: 'wake-mut', thesis: 'original thesis' });
    await writeFile(ledgerStore.path(), `${JSON.stringify(original, null, 2).replace(/\n/g, ' ')}\n`, 'utf8');
    const reformat = await createStewardSupervisor(dir).tick({ now: '2026-07-08T14:04:00.000Z', isSessionRunning: () => true });
    expect(reformat.warnings.some((w) => w.includes('ledger integrity violation'))).toBe(false);

    // A SEMANTIC change (different thesis + decision) is a mutation.
    await writeFile(
      ledgerStore.path(),
      `${JSON.stringify(ledgerEntry({ wakeId: 'wake-mut', thesis: 'rewritten thesis', decision: 'propose_trade' }))}\n`,
      'utf8',
    );
    const mutated = await createStewardSupervisor(dir).tick({ now: '2026-07-08T14:05:00.000Z', isSessionRunning: () => true });
    expect(mutated.warnings.some((w) => w.includes('ledger integrity violation for wake wake-mut'))).toBe(true);
    const log = await readFile(stewardSupervisorLogPath(dir), 'utf8');
    expect(log).toContain('"kind":"entry_mutated"');
  });

  it('bootstraps a receipt once for a pre-#134 terminal wake, then guards it', async () => {
    const wakeStore = createStewardWakeStore(dir);
    const ledgerStore = createStewardLedgerStore(dir);
    // A wake that was DISPATCHED (has injectedAt) and reached terminal BEFORE
    // receipts existed: done, no receipt.
    await wakeStore.create({ wakeId: 'wake-legacy', deadline: '2026-07-08T14:03:00.000Z', envelope, now: '2026-07-08T14:00:00.000Z' });
    await wakeStore.updateStatus('wake-legacy', 'done', {
      now: '2026-07-08T14:01:00.000Z',
      injectedAt: '2026-07-08T14:00:05.000Z',
      completedAt: '2026-07-08T14:01:00.000Z',
    });
    await ledgerStore.append(ledgerEntry({ wakeId: 'wake-legacy' }));
    expect((await wakeStore.get('wake-legacy'))?.ledgerReceipt).toBeUndefined();

    // Tick: back-fill a bootstrapped receipt, no violation.
    const boot = await createStewardSupervisor(dir).tick({ now: '2026-07-08T14:02:00.000Z', isSessionRunning: () => true });
    expect(boot.warnings.some((w) => w.includes('ledger integrity violation'))).toBe(false);
    expect((await wakeStore.get('wake-legacy'))?.ledgerReceipt?.bootstrapped).toBe(true);

    // Now deletion is caught against the bootstrapped receipt.
    await writeFile(ledgerStore.path(), '', 'utf8');
    const after = await createStewardSupervisor(dir).tick({ now: '2026-07-08T14:03:30.000Z', isSessionRunning: () => true });
    expect(after.warnings.some((w) => w.includes('ledger integrity violation for wake wake-legacy'))).toBe(true);
  });

  it('surfaces honestly (never fabricates) a DISPATCHED terminal wake with no receipt AND no ledger entry', async () => {
    const wakeStore = createStewardWakeStore(dir);
    await wakeStore.create({ wakeId: 'wake-orphan', deadline: '2026-07-08T14:03:00.000Z', envelope, now: '2026-07-08T14:00:00.000Z' });
    await wakeStore.updateStatus('wake-orphan', 'done', {
      now: '2026-07-08T14:01:00.000Z',
      injectedAt: '2026-07-08T14:00:05.000Z',
      completedAt: '2026-07-08T14:01:00.000Z',
    });

    const result = await createStewardSupervisor(dir).tick({ now: '2026-07-08T14:02:00.000Z', isSessionRunning: () => true });
    expect(result.warnings.some((w) => w.includes('ledger integrity violation for wake wake-orphan'))).toBe(true);
    expect((await wakeStore.get('wake-orphan'))?.ledgerReceipt).toBeUndefined();
    const log = await readFile(stewardSupervisorLogPath(dir), 'utf8');
    expect(log).toContain('"kind":"entry_missing_no_receipt"');
  });

  it('does not flag timeout/stuck terminal wakes (they carry no ledger entry)', async () => {
    const wakeStore = createStewardWakeStore(dir);
    await wakeStore.create({ wakeId: 'wake-to', deadline: '2026-07-08T14:03:00.000Z', envelope, now: '2026-07-08T14:00:00.000Z' });
    await wakeStore.updateStatus('wake-to', 'timeout', { now: '2026-07-08T14:04:00.000Z', completedAt: '2026-07-08T14:04:00.000Z' });

    const result = await createStewardSupervisor(dir).tick({ now: '2026-07-08T14:05:00.000Z', isSessionRunning: () => true });
    expect(result.warnings.some((w) => w.includes('ledger integrity violation'))).toBe(false);
  });

  it('does NOT flag a never-dispatched terminal error (no injectedAt, no receipt) as an integrity violation (PR #135 regression 1)', async () => {
    // A POST-time session-select/inject failure marks the wake terminal `error`
    // with NO injectedAt and NO ledger entry. It was never ledger-backed, so it
    // must not become a perpetual false alarm.
    const wakeStore = createStewardWakeStore(dir);
    await wakeStore.create({ wakeId: 'wake-nodispatch', deadline: '2026-07-08T14:03:00.000Z', envelope, now: '2026-07-08T14:00:00.000Z' });
    await wakeStore.updateStatus('wake-nodispatch', 'error', {
      now: '2026-07-08T14:00:02.000Z',
      completedAt: '2026-07-08T14:00:02.000Z',
      error: 'no_agent_runtime',
    });
    expect((await wakeStore.get('wake-nodispatch'))?.injectedAt).toBeNull();

    const result = await createStewardSupervisor(dir).tick({ now: '2026-07-08T14:05:00.000Z', isSessionRunning: () => true });
    expect(result.warnings.some((w) => w.includes('ledger integrity violation'))).toBe(false);
    const log = await readFile(stewardSupervisorLogPath(dir), 'utf8').catch(() => '');
    expect(log).not.toContain('"type":"ledger_integrity_violation"');
  });

  it('still reconciles a genuine ledger-backed error and then guards it (PR #135 regression 1)', async () => {
    const ledgerStore = createStewardLedgerStore(dir);
    await seedInjectedWake('wake-realerr');
    const realErrEntry = ledgerEntry({
      wakeId: 'wake-realerr',
      status: 'error',
      completion: { reason: 'tool failed hard', evidenceRefs: ['wake:wake-realerr'] },
    });
    await ledgerStore.append(realErrEntry);
    await publishMarker('wake-realerr', realErrEntry);

    const first = await createStewardSupervisor(dir).tick({ now: '2026-07-08T14:01:30.000Z', isSessionRunning: () => true });
    expect(first.transitions[0]).toMatchObject({ wakeId: 'wake-realerr', to: 'error' });
    expect((await createStewardWakeStore(dir).get('wake-realerr'))?.ledgerReceipt?.status).toBe('error');

    await writeFile(ledgerStore.path(), '', 'utf8');
    const second = await createStewardSupervisor(dir).tick({ now: '2026-07-08T14:05:00.000Z', isSessionRunning: () => true });
    expect(second.warnings.some((w) => w.includes('ledger integrity violation for wake wake-realerr'))).toBe(true);
  });

  it('appends a persistent violation event only ONCE across repeated ticks, and recovers (PR #135 regression 3)', async () => {
    const ledgerStore = createStewardLedgerStore(dir);
    await seedInjectedWake('wake-dedup');
    const dedupEntry = ledgerEntry({ wakeId: 'wake-dedup' });
    await ledgerStore.append(dedupEntry);
    await publishMarker('wake-dedup', dedupEntry);
    await createStewardSupervisor(dir).tick({ now: '2026-07-08T14:01:30.000Z', isSessionRunning: () => true });

    // Delete the entry, then tick THREE times — the violation persists but the
    // structured event must be appended only once (bounded supervisor.jsonl).
    await writeFile(ledgerStore.path(), '', 'utf8');
    const t1 = await createStewardSupervisor(dir).tick({ now: '2026-07-08T14:05:00.000Z', isSessionRunning: () => true });
    const t2 = await createStewardSupervisor(dir).tick({ now: '2026-07-08T14:06:00.000Z', isSessionRunning: () => true });
    const t3 = await createStewardSupervisor(dir).tick({ now: '2026-07-08T14:07:00.000Z', isSessionRunning: () => true });
    // Warning surfaces every tick (still visible)...
    for (const t of [t1, t2, t3]) {
      expect(t.warnings.some((w) => w.includes('ledger integrity violation for wake wake-dedup'))).toBe(true);
    }
    // ...but only ONE structured violation event was appended.
    const log = await readFile(stewardSupervisorLogPath(dir), 'utf8');
    const violationEvents = log.split('\n').filter((l) => l.includes('"type":"ledger_integrity_violation"') && l.includes('wake-dedup'));
    expect(violationEvents).toHaveLength(1);
    expect((await createStewardWakeStore(dir).get('wake-dedup'))?.ledgerIntegrity?.kind).toBe('entry_missing');

    // Recovery: restore the exact entry → marker cleared + recovered event.
    await ledgerStore.append(ledgerEntry({ wakeId: 'wake-dedup' }));
    const t4 = await createStewardSupervisor(dir).tick({ now: '2026-07-08T14:08:00.000Z', isSessionRunning: () => true });
    expect(t4.warnings.some((w) => w.includes('ledger integrity violation for wake wake-dedup'))).toBe(false);
    expect((await createStewardWakeStore(dir).get('wake-dedup'))?.ledgerIntegrity).toBeUndefined();
    const log2 = await readFile(stewardSupervisorLogPath(dir), 'utf8');
    expect(log2).toContain('"type":"ledger_integrity_recovered"');
  });

  it('parses the ledger only ONCE per tick regardless of how many terminal wakes exist (PR #135 regression 2)', async () => {
    const ledgerStore = createStewardLedgerStore(dir);
    // Six dispatched, completed wakes on distinct accounts (one active wake per
    // account is the lock rule), each with its own ledger entry + receipt.
    for (let i = 1; i <= 6; i++) {
      const id = `wake-scale-${i}`;
      await seedInjectedWake(id, `acct-scale-${i}`);
      const e = ledgerEntry({ wakeId: id, accountId: `acct-scale-${i}` });
      await ledgerStore.append(e);
      await publishMarker(id, e);
    }
    await createStewardSupervisor(dir).tick({ now: '2026-07-08T14:01:30.000Z', isSessionRunning: () => true });

    // Next tick: all six are terminal and get reconciled. The supervisor must
    // read/parse the ledger exactly once, not once per wake.
    const spy = vi.spyOn(StewardLedgerStore.prototype, 'readIndex');
    try {
      await createStewardSupervisor(dir).tick({ now: '2026-07-08T14:02:00.000Z', isSessionRunning: () => true });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('StewardSupervisor finalize barrier (issue #136)', () => {
  async function seedInjectedWake(wakeId: string): Promise<void> {
    const wakeStore = createStewardWakeStore(dir);
    const lockStore = createStewardLockStore(dir);
    await wakeStore.create({ wakeId, deadline: '2026-07-08T14:03:00.000Z', envelope, now: '2026-07-08T14:00:00.000Z' });
    await wakeStore.updateStatus(wakeId, 'injected', {
      now: '2026-07-08T14:00:05.000Z', injectedAt: '2026-07-08T14:00:05.000Z', sessionId: 'sess-136',
    });
    await lockStore.acquire({
      accountId: envelope.accountId, wakeId,
      now: '2026-07-08T14:00:00.000Z', expiresAt: '2026-07-08T14:03:00.000Z',
    });
  }

  it('does NOT terminalize a parseable draft that has no finalization marker (regression 1)', async () => {
    const ledgerStore = createStewardLedgerStore(dir);
    await seedInjectedWake('wake-draft');
    await ledgerStore.append(ledgerEntry({ wakeId: 'wake-draft' }));
    // No marker published — the agent has written the line but not validated.

    const result = await createStewardSupervisor(dir).tick({ now: '2026-07-08T14:01:30.000Z', isSessionRunning: () => true });
    expect(result.transitions).toEqual([]);
    expect((await createStewardWakeStore(dir).get('wake-draft'))?.status).toBe('injected');
    expect((await createStewardWakeStore(dir).get('wake-draft'))?.ledgerReceipt).toBeUndefined();
  });

  it('does NOT terminalize when the entry was corrected after validation (marker fingerprint mismatch), and warns (regression 2)', async () => {
    const ledgerStore = createStewardLedgerStore(dir);
    await seedInjectedWake('wake-correct');
    const draft = ledgerEntry({ wakeId: 'wake-correct', thesis: 'draft thesis' });
    await ledgerStore.append(draft);
    await publishMarker('wake-correct', draft); // validated the draft

    // A #125-permitted in-place correction — but NOT re-validated: the marker
    // still points at the draft fingerprint.
    const corrected = ledgerEntry({ wakeId: 'wake-correct', thesis: 'corrected thesis', decision: 'propose_trade' });
    await writeFile(ledgerStore.path(), `${JSON.stringify(corrected)}\n`, 'utf8');

    const result = await createStewardSupervisor(dir).tick({ now: '2026-07-08T14:01:30.000Z', isSessionRunning: () => true });
    expect(result.transitions).toEqual([]);
    expect((await createStewardWakeStore(dir).get('wake-correct'))?.status).toBe('injected');
    expect(result.warnings.some((w) => w.includes('finalize marker for wake wake-correct does not match'))).toBe(true);
  });

  it('terminalizes with the CORRECTED fingerprint after the validator is re-run on the corrected line (regression 3)', async () => {
    const ledgerStore = createStewardLedgerStore(dir);
    await seedInjectedWake('wake-recommit');
    const draft = ledgerEntry({ wakeId: 'wake-recommit', thesis: 'draft thesis' });
    await ledgerStore.append(draft);
    await publishMarker('wake-recommit', draft);

    const corrected = ledgerEntry({ wakeId: 'wake-recommit', thesis: 'corrected thesis', decision: 'propose_trade' });
    await writeFile(ledgerStore.path(), `${JSON.stringify(corrected)}\n`, 'utf8');
    // Re-run validation on the corrected line: marker is atomically replaced.
    await publishMarker('wake-recommit', corrected);

    const result = await createStewardSupervisor(dir).tick({ now: '2026-07-08T14:01:30.000Z', isSessionRunning: () => true });
    expect(result.transitions[0]).toMatchObject({ wakeId: 'wake-recommit', to: 'done' });
    const wake = await createStewardWakeStore(dir).get('wake-recommit');
    // Receipt captured the CORRECTED entry, so a later #134 check won't false-flag.
    expect(wake?.ledgerReceipt?.fingerprint).toBe(canonicalDecisionFingerprint(corrected));
  });

  it('after clean terminalization, a later in-place mutation STILL triggers a #134 violation (regression 4)', async () => {
    const ledgerStore = createStewardLedgerStore(dir);
    await seedInjectedWake('wake-post');
    const entry = ledgerEntry({ wakeId: 'wake-post', thesis: 'validated thesis' });
    await ledgerStore.append(entry);
    await publishMarker('wake-post', entry);
    await createStewardSupervisor(dir).tick({ now: '2026-07-08T14:01:30.000Z', isSessionRunning: () => true });

    // Now the wake is terminal with a receipt. A post-terminal rewrite is a
    // genuine #134 corruption, NOT a legal pre-terminal correction.
    await writeFile(
      ledgerStore.path(),
      `${JSON.stringify(ledgerEntry({ wakeId: 'wake-post', thesis: 'rewritten after completion', decision: 'propose_trade' }))}\n`,
      'utf8',
    );
    const result = await createStewardSupervisor(dir).tick({ now: '2026-07-08T14:05:00.000Z', isSessionRunning: () => true });
    expect(result.warnings.some((w) => w.includes('ledger integrity violation for wake wake-post'))).toBe(true);
  });

  it('legacy in-flight wakes (no finalizeProtocol) still terminalize from raw presence (bounded compatibility)', async () => {
    const wakeStore = createStewardWakeStore(dir);
    const lockStore = createStewardLockStore(dir);
    const ledgerStore = createStewardLedgerStore(dir);
    await seedInjectedWake('wake-legacy-inflight');
    // Simulate a wake created before the barrier shipped: strip finalizeProtocol.
    const path = wakeStore.pathFor('wake-legacy-inflight');
    const rec = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    delete rec.finalizeProtocol;
    await writeFile(path, JSON.stringify(rec, null, 2), 'utf8');
    void lockStore;

    await ledgerStore.append(ledgerEntry({ wakeId: 'wake-legacy-inflight' }));
    // No marker — but a legacy wake terminalizes from raw presence.
    const result = await createStewardSupervisor(dir).tick({ now: '2026-07-08T14:01:30.000Z', isSessionRunning: () => true });
    expect(result.transitions[0]).toMatchObject({ wakeId: 'wake-legacy-inflight', to: 'done' });
  });
});

describe('StewardSupervisor active identity mismatch (issue #139)', () => {
  async function seedInjectedWake(wakeId: string): Promise<void> {
    const wakeStore = createStewardWakeStore(dir);
    const lockStore = createStewardLockStore(dir);
    await wakeStore.create({ wakeId, deadline: '2026-07-08T14:03:00.000Z', envelope, now: '2026-07-08T14:00:00.000Z' });
    await wakeStore.updateStatus(wakeId, 'injected', {
      now: '2026-07-08T14:00:05.000Z', injectedAt: '2026-07-08T14:00:05.000Z', sessionId: 'sess-139',
    });
    await lockStore.acquire({
      accountId: envelope.accountId, wakeId,
      now: '2026-07-08T14:00:00.000Z', expiresAt: '2026-07-08T14:03:00.000Z',
    });
  }

  /** Write a raw misfiled entry: top-level wakeId is the typo, evidence
   *  correctly self-references the active wake. */
  async function writeMisfiledLedger(topLevelWakeId: string, referencedWakeId: string): Promise<void> {
    const ledgerStore = createStewardLedgerStore(dir);
    const misfiled = {
      ...ledgerEntry({ wakeId: topLevelWakeId }),
      completion: { reason: 'checklist complete', evidenceRefs: [`wake:${referencedWakeId}`, 'tool:risk'] },
    };
    await mkdir(dirname(ledgerStore.path()), { recursive: true });
    await writeFile(ledgerStore.path(), `${JSON.stringify(misfiled)}\n`, 'utf8');
  }

  it('emits an actionable ledger_identity_mismatch for the active wake, deduped across ticks, and does NOT terminalize (regression: copied suffix)', async () => {
    await seedInjectedWake('wake-active-real');
    // A steward copied a prior wake's suffix into the top-level id; evidence
    // still self-references the real active wake.
    await writeMisfiledLedger('wake-prior-suffix-typo', 'wake-active-real');

    const t1 = await createStewardSupervisor(dir).tick({ now: '2026-07-08T14:01:00.000Z', isSessionRunning: () => true });
    // The real wake did NOT terminalize (its entry is filed under the wrong id).
    expect(t1.transitions).toEqual([]);
    expect((await createStewardWakeStore(dir).get('wake-active-real'))?.status).toBe('injected');
    expect(t1.warnings.some((w) => w.includes('ledger identity mismatch for active wake wake-active-real'))).toBe(true);

    const t2 = await createStewardSupervisor(dir).tick({ now: '2026-07-08T14:01:30.000Z', isSessionRunning: () => true });
    // Warning re-surfaces every tick (actionable), but the structured event is
    // written only ONCE (bounded supervisor.jsonl).
    expect(t2.warnings.some((w) => w.includes('ledger identity mismatch for active wake wake-active-real'))).toBe(true);
    const log = await readFile(stewardSupervisorLogPath(dir), 'utf8');
    const events = log.split('\n').filter((l) => l.includes('"type":"ledger_identity_mismatch"') && l.includes('wake-active-real'));
    expect(events).toHaveLength(1);
    expect((await createStewardWakeStore(dir).get('wake-active-real'))?.ledgerIntegrity?.kind).toBe('active_identity_mismatch');
  });

  it('a lenient-readable v2 entry missing the #139 self-reference still cannot finalize an active wake (no strict-validated marker)', async () => {
    const ledgerStore = createStewardLedgerStore(dir);
    await seedInjectedWake('wake-noselfref');
    // A pre-#139-shaped entry (no wake:<self>) — lenient-readable, but the strict
    // generated validator would refuse to publish a marker for it.
    const missingSelfRef = {
      ...ledgerEntry({ wakeId: 'wake-noselfref' }),
      completion: { reason: 'checklist complete', evidenceRefs: ['tool:risk'] },
    };
    await mkdir(dirname(ledgerStore.path()), { recursive: true });
    await writeFile(ledgerStore.path(), `${JSON.stringify(missingSelfRef)}\n`, 'utf8');
    // No marker published — the finalize gate must hold.
    const result = await createStewardSupervisor(dir).tick({ now: '2026-07-08T14:01:00.000Z', isSessionRunning: () => true });
    expect(result.transitions).toEqual([]);
    expect((await createStewardWakeStore(dir).get('wake-noselfref'))?.status).toBe('injected');
  });

  it('clears a stale active_identity_mismatch marker when the wake times out (non-ledger-backed terminal)', async () => {
    await seedInjectedWake('wake-to-mismatch');
    await writeMisfiledLedger('wake-wrong-to', 'wake-to-mismatch');
    await createStewardSupervisor(dir).tick({ now: '2026-07-08T14:01:00.000Z', isSessionRunning: () => true });
    expect((await createStewardWakeStore(dir).get('wake-to-mismatch'))?.ledgerIntegrity?.kind).toBe('active_identity_mismatch');

    // Past the 14:03 deadline → timeout, which must clear the stale marker.
    const result = await createStewardSupervisor(dir).tick({ now: '2026-07-08T14:05:00.000Z', isSessionRunning: () => true });
    expect(result.transitions.some((t) => t.wakeId === 'wake-to-mismatch' && t.to === 'timeout')).toBe(true);
    const wake = await createStewardWakeStore(dir).get('wake-to-mismatch');
    expect(wake?.status).toBe('timeout');
    expect(wake?.ledgerIntegrity).toBeUndefined();
  });

  it('clears a stale active_identity_mismatch marker when the wake goes stuck', async () => {
    await seedInjectedWake('wake-stuck-mismatch');
    await writeMisfiledLedger('wake-wrong-stuck', 'wake-stuck-mismatch');
    await createStewardSupervisor(dir).tick({ now: '2026-07-08T14:01:00.000Z', isSessionRunning: () => true });
    expect((await createStewardWakeStore(dir).get('wake-stuck-mismatch'))?.ledgerIntegrity?.kind).toBe('active_identity_mismatch');

    // Session gone, still before deadline → stuck, which must clear the marker.
    const result = await createStewardSupervisor(dir).tick({ now: '2026-07-08T14:02:00.000Z', isSessionRunning: () => false });
    expect(result.transitions.some((t) => t.wakeId === 'wake-stuck-mismatch' && t.to === 'stuck')).toBe(true);
    const wake = await createStewardWakeStore(dir).get('wake-stuck-mismatch');
    expect(wake?.status).toBe('stuck');
    expect(wake?.ledgerIntegrity).toBeUndefined();
  });

  it('clears the mismatch and terminalizes once the entry is re-filed under the correct wakeId and re-validated (recovery)', async () => {
    await seedInjectedWake('wake-fixme');
    await writeMisfiledLedger('wake-wrong-id', 'wake-fixme');
    await createStewardSupervisor(dir).tick({ now: '2026-07-08T14:01:00.000Z', isSessionRunning: () => true });
    expect((await createStewardWakeStore(dir).get('wake-fixme'))?.ledgerIntegrity?.kind).toBe('active_identity_mismatch');

    // The steward corrects the top-level wakeId and re-validates (marker).
    const ledgerStore = createStewardLedgerStore(dir);
    const corrected = ledgerEntry({ wakeId: 'wake-fixme' });
    await writeFile(ledgerStore.path(), `${JSON.stringify(corrected)}\n`, 'utf8');
    await publishMarker('wake-fixme', corrected);

    const result = await createStewardSupervisor(dir).tick({ now: '2026-07-08T14:01:30.000Z', isSessionRunning: () => true });
    expect(result.transitions[0]).toMatchObject({ wakeId: 'wake-fixme', to: 'done' });
    const wake = await createStewardWakeStore(dir).get('wake-fixme');
    expect(wake?.status).toBe('done');
    expect(wake?.ledgerIntegrity).toBeUndefined(); // mismatch marker cleared on terminalization
  });
});

describe('StewardSupervisor + atomic ledger writer (issue #140)', () => {
  async function seedCommittedDone(wakeId: string): Promise<void> {
    const wakeStore = createStewardWakeStore(dir);
    const lockStore = createStewardLockStore(dir);
    await wakeStore.create({ wakeId, deadline: '2026-07-08T14:03:00.000Z', envelope, now: '2026-07-08T14:00:00.000Z' });
    await wakeStore.updateStatus(wakeId, 'injected', { now: '2026-07-08T14:00:05.000Z', injectedAt: '2026-07-08T14:00:05.000Z', sessionId: 'sess-140' });
    await lockStore.acquire({ accountId: envelope.accountId, wakeId, now: '2026-07-08T14:00:00.000Z', expiresAt: '2026-07-08T14:03:00.000Z' });
    const e = ledgerEntry({ wakeId });
    await createStewardLedgerStore(dir).append(e);
    await publishMarker(wakeId, e);
    await createStewardSupervisor(dir).tick({ now: '2026-07-08T14:01:30.000Z', isSessionRunning: () => true });
  }

  it('atomic appends interleaved with supervisor ticks never falsely flag a committed wake as entry_missing', async () => {
    await seedCommittedDone('wake-committed');
    expect((await createStewardWakeStore(dir).get('wake-committed'))?.status).toBe('done');
    const store = createStewardLedgerStore(dir);
    for (let i = 0; i < 8; i++) {
      // Each append is a full atomic replace of decisions.jsonl — a concurrent
      // reader (the supervisor) only ever sees old-complete or new-complete, so
      // the committed wake's line is never momentarily absent.
      await store.append(ledgerEntry({ wakeId: `wake-noise-${i}`, accountId: `acct-${i}` }));
      const r = await createStewardSupervisor(dir).tick({ now: '2026-07-08T14:05:00.000Z', isSessionRunning: () => true });
      expect(r.warnings.some((w) => w.includes('ledger integrity violation for wake wake-committed'))).toBe(false);
    }
  });

  it('a DIRECT truncate of decisions.jsonl is STILL detected as #134 corruption (Solution A does not weaken detection)', async () => {
    await seedCommittedDone('wake-trunc');
    // The old failure mode: a direct write that empties/rewrites the file. This
    // is now unsupported (the validator is the only writer), but if it happens
    // it must still be caught — the evidence rules are not softened.
    await writeFile(createStewardLedgerStore(dir).path(), '', 'utf8');
    const r = await createStewardSupervisor(dir).tick({ now: '2026-07-08T14:06:00.000Z', isSessionRunning: () => true });
    expect(r.warnings.some((w) => w.includes('ledger integrity violation for wake wake-trunc'))).toBe(true);
    const log = await readFile(stewardSupervisorLogPath(dir), 'utf8');
    expect(log).toContain('"kind":"entry_missing"');
  });
});

describe('StewardSupervisor timeout attribution (issue #132)', () => {
  async function seedTimedOutWake(): Promise<void> {
    const wakeStore = createStewardWakeStore(dir);
    const lockStore = createStewardLockStore(dir);
    await wakeStore.create({
      wakeId: 'wake-timeout',
      deadline: '2026-07-08T14:03:00.000Z',
      envelope,
      now: '2026-07-08T14:00:00.000Z',
    });
    await wakeStore.updateStatus('wake-timeout', 'injected', {
      now: '2026-07-08T14:00:05.000Z',
      injectedAt: '2026-07-08T14:00:05.000Z',
      sessionId: 'sess-poisoned',
    });
    await lockStore.acquire({
      accountId: envelope.accountId,
      wakeId: 'wake-timeout',
      now: '2026-07-08T14:00:00.000Z',
      expiresAt: '2026-07-08T14:03:00.000Z',
    });
  }

  it('classifies a deadline-past wake as context_overflow when telemetry shows the window exceeded', async () => {
    await seedTimedOutWake();

    const result = await createStewardSupervisor(dir).tick({
      now: '2026-07-08T14:05:00.000Z', // past the 14:03 deadline
      isSessionRunning: () => true,
      readContextTelemetry: async () => ({
        inputTokens: 125765,
        modelContextWindow: 121600,
        source: '/ws/rollout.jsonl',
      }),
    });

    expect(result.transitions[0]).toMatchObject({ wakeId: 'wake-timeout', to: 'timeout' });
    const wake = await createStewardWakeStore(dir).get('wake-timeout');
    expect(wake?.status).toBe('timeout');
    expect(wake?.attribution).toEqual({
      kind: 'context_overflow',
      inputTokens: 125765,
      modelContextWindow: 121600,
    });
    const log = await readFile(stewardSupervisorLogPath(dir), 'utf8');
    expect(log).toContain('"type":"wake_timeout"');
    expect(log).toContain('"attribution":"context_overflow"');
  });

  it('records a plain timeout (no attribution) when telemetry is under the window', async () => {
    await seedTimedOutWake();

    await createStewardSupervisor(dir).tick({
      now: '2026-07-08T14:05:00.000Z',
      isSessionRunning: () => true,
      readContextTelemetry: async () => ({
        inputTokens: 40000,
        modelContextWindow: 121600,
        source: '/ws/rollout.jsonl',
      }),
    });

    const wake = await createStewardWakeStore(dir).get('wake-timeout');
    expect(wake?.status).toBe('timeout');
    expect(wake?.attribution).toBeUndefined();
    const log = await readFile(stewardSupervisorLogPath(dir), 'utf8');
    expect(log).not.toContain('"attribution":"context_overflow"');
  });

  it('falls back to a plain timeout AND warns when the telemetry read throws', async () => {
    await seedTimedOutWake();

    const result = await createStewardSupervisor(dir).tick({
      now: '2026-07-08T14:05:00.000Z',
      isSessionRunning: () => true,
      readContextTelemetry: async () => {
        throw new Error('rollout unreadable');
      },
    });

    const wake = await createStewardWakeStore(dir).get('wake-timeout');
    expect(wake?.status).toBe('timeout');
    expect(wake?.attribution).toBeUndefined();
    expect(result.warnings.some((w) => w.includes('context telemetry read failed for session sess-poisoned'))).toBe(
      true,
    );
    const log = await readFile(stewardSupervisorLogPath(dir), 'utf8');
    expect(log).toContain('"telemetryWarning"');
  });

  it(
    'falls back to a plain timeout AND warns when telemetry resolves to null for the tracked ' +
      'session (rollout genuinely absent/unlocatable — PR #133 review)',
    async () => {
      await seedTimedOutWake();

      const result = await createStewardSupervisor(dir).tick({
        now: '2026-07-08T14:05:00.000Z',
        isSessionRunning: () => true,
        readContextTelemetry: async () => null,
      });

      const wake = await createStewardWakeStore(dir).get('wake-timeout');
      expect(wake?.status).toBe('timeout');
      expect(wake?.attribution).toBeUndefined();
      expect(
        result.warnings.some((w) => w.includes('context telemetry unavailable for session sess-poisoned')),
      ).toBe(true);
      const log = await readFile(stewardSupervisorLogPath(dir), 'utf8');
      expect(log).toContain('"telemetryWarning"');
    },
  );

  it('records a plain timeout with NO warning when no telemetry reader is provided', async () => {
    await seedTimedOutWake();

    const result = await createStewardSupervisor(dir).tick({
      now: '2026-07-08T14:05:00.000Z',
      isSessionRunning: () => true,
    });

    // No reader supplied at all is a known/expected omission by the caller,
    // not a degraded read — must not warn (issue #132 / PR #133 review).
    expect(result.warnings.some((w) => w.includes('context telemetry'))).toBe(false);
    const wake = await createStewardWakeStore(dir).get('wake-timeout');
    expect(wake?.status).toBe('timeout');
    expect(wake?.attribution).toBeUndefined();
  });
});

describe('StewardSupervisor machine control face (issue #146)', () => {
  const THREAD_ID = 'thread-0199-aabb';

  /** Seed an injected MACHINE wake whose `sessionId` carries the thread UUID. */
  async function seedInjectedMachineWake(deadline: string): Promise<void> {
    const wakeStore = createStewardWakeStore(dir);
    const lockStore = createStewardLockStore(dir);
    await wakeStore.create({
      wakeId: 'wake-m',
      deadline,
      envelope,
      now: '2026-07-08T14:00:00.000Z',
      controlFace: 'machine',
      sessionId: THREAD_ID,
    });
    await wakeStore.updateStatus('wake-m', 'injected', {
      now: '2026-07-08T14:00:05.000Z',
      injectedAt: '2026-07-08T14:00:05.000Z',
      sessionId: THREAD_ID,
    });
    await lockStore.acquire({
      accountId: envelope.accountId,
      wakeId: 'wake-m',
      now: '2026-07-08T14:00:00.000Z',
      expiresAt: deadline,
    });
  }

  it('(a) does NOT mark a machine wake stuck while its thread is live', async () => {
    await seedInjectedMachineWake('2026-07-08T14:03:00.000Z');
    const isMachineThreadLive = vi.fn(() => true);
    // Provide a PTY probe that would report the session gone — it must never be
    // consulted for a machine wake.
    const isSessionRunning = vi.fn(() => false);

    const result = await createStewardSupervisor(dir).tick({
      now: '2026-07-08T14:01:00.000Z', // before deadline
      isSessionRunning,
      isMachineThreadLive,
    });

    expect(result.transitions).toHaveLength(0);
    expect((await createStewardWakeStore(dir).get('wake-m'))?.status).toBe('injected');
    expect(isMachineThreadLive).toHaveBeenCalledWith(THREAD_ID);
    expect(isSessionRunning).not.toHaveBeenCalled();
  });

  it('(b) marks a machine wake stuck when the thread is gone, with PTY-parity event', async () => {
    await seedInjectedMachineWake('2026-07-08T14:03:00.000Z');
    const lockStore = createStewardLockStore(dir);

    const result = await createStewardSupervisor(dir).tick({
      now: '2026-07-08T14:01:00.000Z', // before deadline
      isSessionRunning: () => true, // PTY probe would say "alive" — ignored
      isMachineThreadLive: () => false,
    });

    // Identical transition shape to the PTY stuck test above (line ~800).
    expect(result.transitions[0]).toMatchObject({
      wakeId: 'wake-m',
      from: 'injected',
      to: 'stuck',
      reason: 'session_not_running',
    });
    expect((await createStewardWakeStore(dir).get('wake-m'))?.status).toBe('stuck');
    expect(await lockStore.get(envelope.accountId)).toBeNull();
    // Same wake_stuck event the PTY path emits, carrying the thread UUID as its
    // sessionId — event emission parity.
    const log = await readFile(stewardSupervisorLogPath(dir), 'utf8');
    expect(log).toContain('"type":"wake_stuck"');
    expect(log).toContain(`"sessionId":"${THREAD_ID}"`);
  });

  it('(c) attributes a machine wake timeout from driver telemetry, not the PTY rollout', async () => {
    await seedInjectedMachineWake('2026-07-08T14:03:00.000Z');
    // A PTY rollout reader that would throw if consulted — proves the machine
    // wake never touches it.
    const readContextTelemetry = vi.fn(async () => {
      throw new Error('PTY rollout must not be read for a machine wake');
    });

    const result = await createStewardSupervisor(dir).tick({
      now: '2026-07-08T14:05:00.000Z', // past the 14:03 deadline
      isSessionRunning: () => true,
      isMachineThreadLive: () => true,
      readContextTelemetry,
      readMachineTelemetry: () => ({
        totalTokens: 130000,
        inputTokens: 125765,
        cachedInputTokens: 4000,
        outputTokens: 4235,
        contextWindow: 121600,
        updatedAt: '2026-07-08T14:04:30.000Z',
      }),
    });

    expect(result.transitions[0]).toMatchObject({ wakeId: 'wake-m', to: 'timeout' });
    const wake = await createStewardWakeStore(dir).get('wake-m');
    expect(wake?.status).toBe('timeout');
    expect(wake?.attribution).toEqual({
      kind: 'context_overflow',
      inputTokens: 125765,
      modelContextWindow: 121600,
    });
    expect(readContextTelemetry).not.toHaveBeenCalled();
    const log = await readFile(stewardSupervisorLogPath(dir), 'utf8');
    expect(log).toContain('"attribution":"context_overflow"');
  });

  it('(d) a PTY wake never consults the machine liveness probe', async () => {
    const wakeStore = createStewardWakeStore(dir);
    const lockStore = createStewardLockStore(dir);
    await wakeStore.create({
      wakeId: 'wake-pty',
      deadline: '2026-07-08T14:03:00.000Z',
      envelope,
      now: '2026-07-08T14:00:00.000Z',
    });
    await wakeStore.updateStatus('wake-pty', 'injected', {
      now: '2026-07-08T14:00:05.000Z',
      injectedAt: '2026-07-08T14:00:05.000Z',
      sessionId: 'pty-session-1',
    });
    await lockStore.acquire({
      accountId: envelope.accountId,
      wakeId: 'wake-pty',
      now: '2026-07-08T14:00:00.000Z',
      expiresAt: '2026-07-08T14:03:00.000Z',
    });
    const isMachineThreadLive = vi.fn(() => true);

    const result = await createStewardSupervisor(dir).tick({
      now: '2026-07-08T14:01:00.000Z', // before deadline
      isSessionRunning: () => false, // PTY session gone -> stuck via the old path
      isMachineThreadLive,
    });

    expect(result.transitions[0]).toMatchObject({
      wakeId: 'wake-pty',
      to: 'stuck',
      reason: 'session_not_running',
    });
    expect(isMachineThreadLive).not.toHaveBeenCalled();
  });
});
