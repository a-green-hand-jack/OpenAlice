/**
 * Issue #134 (PR #135 review) — fingerprint parity + selection.
 *
 * The canonical semantic fingerprint is re-implemented in the generated JS
 * validator (`templates/steward/bootstrap.mjs`). This pins a GOLDEN vector:
 * the SAME constant is asserted here (TS) and, via a receipt whose
 * `fingerprint` is this constant, by the generated validator in
 * `bootstrap.spec.ts` — so the two implementations can never silently diverge.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  canonicalDecisionFingerprint,
  canonicalIntentFingerprint,
  canonicalizeJson,
  createStewardLedgerStore,
} from './index.js';

/** The pinned golden ledger entry. If the projection/canonicalization changes,
 *  update GOLDEN_FINGERPRINT here AND the copy asserted in bootstrap.spec.ts. */
export const GOLDEN_ENTRY = {
  version: 2,
  wakeId: 'golden-wake',
  at: '2026-07-11T00:00:00.000Z',
  accountId: 'mock-simulator-1',
  decision: 'no_trade',
  status: 'done',
  completion: { reason: 'checklist complete; no entry signal', evidenceRefs: ['wake:golden-wake', 'tool:risk'] },
  checklist: { account: 'ok', positions: 'ok', orders: 'ok', risk: 'NORMAL', market: 'open', history: 'checked' },
  thesis: 'No trade: no thesis or entry signal.',
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
} as const;

export const GOLDEN_FINGERPRINT = 'a00e0bc4ff92f38b3e7bfab09e797e73d5f9248664cee740ac1efedf4849ef9f';

describe('canonicalDecisionFingerprint (issue #134)', () => {
  it('matches the pinned golden vector (parity anchor with the generated JS validator)', () => {
    expect(canonicalDecisionFingerprint(GOLDEN_ENTRY)).toBe(GOLDEN_FINGERPRINT);
  });

  it('is invariant to key order and unknown top-level fields (requirement 7)', () => {
    const reordered = {
      unknownExtra: 'ignore me',
      cost: GOLDEN_ENTRY.cost,
      wakeId: GOLDEN_ENTRY.wakeId,
      version: 2,
      at: GOLDEN_ENTRY.at,
      accountId: GOLDEN_ENTRY.accountId,
      decision: 'no_trade',
      status: 'done',
      completion: GOLDEN_ENTRY.completion,
      checklist: GOLDEN_ENTRY.checklist,
      thesis: GOLDEN_ENTRY.thesis,
      actions: [],
      pendingHash: null,
      invalidation: GOLDEN_ENTRY.invalidation,
    };
    expect(canonicalDecisionFingerprint(reordered)).toBe(GOLDEN_FINGERPRINT);
  });

  it('changes when a semantic field changes', () => {
    expect(canonicalDecisionFingerprint({ ...GOLDEN_ENTRY, decision: 'propose_trade' })).not.toBe(GOLDEN_FINGERPRINT);
  });

  it('retains nested disk-origin __proto__/constructor as canonical data and fingerprints them', () => {
    const hostile = JSON.parse(
      '{"a":1,"nested":{"z":1,"__proto__":{"polluted":true},"constructor":{"prototype":{"constructorPolluted":true}}}}',
    ) as Record<string, unknown>;
    const canonical = canonicalizeJson(hostile) as Record<string, unknown>;
    const nested = canonical['nested'] as Record<string, unknown>;

    expect(Object.getPrototypeOf(canonical)).toBeNull();
    expect(Object.getPrototypeOf(nested)).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(nested, '__proto__')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(nested, 'constructor')).toBe(true);
    expect(nested['__proto__']).toEqual({ polluted: true });
    expect(nested['constructor']).toEqual({ prototype: { constructorPolluted: true } });
    expect(JSON.stringify(canonical)).toBe(
      '{"a":1,"nested":{"__proto__":{"polluted":true},"constructor":{"prototype":{"constructorPolluted":true}},"z":1}}',
    );

    const withoutProto = JSON.parse(JSON.stringify(hostile)) as Record<string, unknown>;
    delete (withoutProto['nested'] as Record<string, unknown>)['__proto__'];
    const withoutConstructor = JSON.parse(JSON.stringify(withoutProto)) as Record<string, unknown>;
    delete (withoutConstructor['nested'] as Record<string, unknown>)['constructor'];
    expect(canonicalIntentFingerprint(hostile)).not.toBe(canonicalIntentFingerprint(withoutProto));
    expect(canonicalIntentFingerprint(withoutProto)).not.toBe(canonicalIntentFingerprint(withoutConstructor));

    const ledgerWithHostileParams = {
      ...GOLDEN_ENTRY,
      actions: [{ kind: 'git_reject', params: hostile, outcome: 'awaiting_approval' }],
    };
    const ledgerWithoutProto = {
      ...GOLDEN_ENTRY,
      actions: [{ kind: 'git_reject', params: withoutProto, outcome: 'awaiting_approval' }],
    };
    expect(canonicalDecisionFingerprint(ledgerWithHostileParams))
      .not.toBe(canonicalDecisionFingerprint(ledgerWithoutProto));
    expect((Object.prototype as { polluted?: unknown }).polluted).toBeUndefined();
    expect((Object.prototype as { constructorPolluted?: unknown }).constructorPolluted).toBeUndefined();
  });
});

describe('ledger first-wins selection (issue #134 parity)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ledger-index-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('selects the FIRST JSON-parseable line for a wakeId even when it is schema-invalid, and marks it invalid', async () => {
    const store = createStewardLedgerStore(dir);
    // Line 1: JSON-valid but schema-invalid (missing decision) for wake-X.
    const invalidFirst = { ...GOLDEN_ENTRY, wakeId: 'wake-X' } as Record<string, unknown>;
    delete invalidFirst.decision;
    // Line 2: a fully valid later entry for the same wakeId.
    const validSecond = { ...GOLDEN_ENTRY, wakeId: 'wake-X' };

    await mkdir(dirname(store.path()), { recursive: true });
    await writeFile(
      store.path(),
      `${JSON.stringify(invalidFirst)}\n${JSON.stringify(validSecond)}\n`,
      'utf8',
    );

    const index = await store.readIndex();
    const fw = index.firstWins.get('wake-X');
    expect(fw?.line).toBe(1);              // the FIRST JSON line wins (parity with the JS validator)
    expect(fw?.valid).toBe(false);         // ...and it is flagged, not silently skipped for the valid one
    expect(fw?.entry).toBeNull();
    // Its fingerprint is over that first line's semantic projection.
    expect(fw?.fingerprint).toBe(canonicalDecisionFingerprint(invalidFirst));
    // The schema-invalid line is surfaced as invalid.
    expect(index.invalid.some((l) => l.line === 1)).toBe(true);
  });
});
