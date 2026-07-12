import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { canonicalIntentFingerprint } from './ledger-receipt.js';
import {
  compareStewardSizingSourceVersions,
  selectStewardProtection,
  sizeStewardDecision,
  stewardSizingOutcomeSchema,
} from './sizing.js';

const here = dirname(fileURLToPath(import.meta.url));

function jsonFixture<T>(path: string): T {
  return JSON.parse(readFileSync(join(here, path), 'utf8')) as T;
}

const singleLedger = jsonFixture<Record<string, unknown>>(
  '../../../tools/steward-contract-proof/fixtures/d2/ledger-v3-single.json',
);
const portfolioLedger = jsonFixture<Record<string, unknown>>(
  '../../../tools/steward-contract-proof/fixtures/d2/ledger-v3-portfolio.json',
);
const fingerprintGoldens = jsonFixture<Record<string, string>>(
  '../../../tools/steward-contract-proof/fixtures/d2/fingerprint-goldens.json',
);
const protectionCases = jsonFixture<{
  cases: Array<{
    name: string;
    capabilities: Record<string, unknown>;
    request: Record<string, unknown>;
    expected: Record<string, unknown>;
  }>;
}>('../../../tools/steward-contract-proof/fixtures/d2/broker-protection-cases.json');
const sizingGoldens = jsonFixture<{
  cases: Array<{
    name: string;
    account: {
      equity: string;
      positionQuantity: string;
      markPrice: string | null;
      quantityIncrement: string;
    };
    caps: {
      maxPositionPctOfEquity: string;
      maxSingleOrderPctOfEquity: string;
      remainingLossPctOfEquity: string;
    };
    capabilities: Record<string, unknown>;
    expected: {
      kind: string;
      quantity?: string;
      protectionOrderType?: string | null;
      limitPrice?: string;
      code?: string;
    };
  }>;
}>('./fixtures/deterministic-sizing-goldens.json');

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function singleIntent(): Record<string, unknown> {
  return clone(singleLedger['intent'] as Record<string, unknown>);
}

function portfolioIntent(): Record<string, unknown> {
  return clone(portfolioLedger['intent'] as Record<string, unknown>);
}

function sizingInput(overrides: {
  readonly rawIntent?: unknown;
  readonly decision?: 'propose_change' | 'reduce_risk';
  readonly account?: Partial<{
    accountId: string;
    accountStateVersion: string | number;
    equity: string;
    instrument: Partial<{
      instrument: string;
      positionQuantity: string;
      markPrice: string | null;
      contractMultiplier: string;
      quantityIncrement: string;
    }>;
  }>;
  readonly risk?: Record<string, unknown>;
  readonly brokerCapabilities?: Record<string, unknown>;
} = {}) {
  const intent = overrides.rawIntent ?? singleIntent();
  const accountInstrument = {
    instrument: 'mock-simulator-1/ASSET-A',
    positionQuantity: '0',
    markPrice: '100' as string | null,
    contractMultiplier: '1',
    quantityIncrement: '1',
    ...(overrides.account?.instrument ?? {}),
  };
  return {
    decisionWakeId: 'wake-v3-single',
    accountId: 'mock-simulator-1',
    decision: overrides.decision ?? 'propose_change',
    rawIntent: intent,
    snapshot: {
      snapshotId: (intent as Record<string, unknown>)['snapshotId'] ?? 'snap:wake-v3-single',
      snapshotSha256: (intent as Record<string, unknown>)['snapshotSha256'] ?? '0'.repeat(64),
    },
    account: {
      accountId: 'mock-simulator-1',
      accountStateVersion: 'account-state:1',
      equity: '10000',
      ...overrides.account,
      instrument: accountInstrument,
    },
    risk: overrides.risk ?? {
      accountId: 'mock-simulator-1',
      riskStateVersion: 'risk-state:1',
      envelope: {
        kind: 'available',
        envelopeVersion: 3,
        scopeAllowed: true,
        increaseAllowed: true,
        caps: {
          maxPositionPctOfEquity: '25',
          maxSingleOrderPctOfEquity: '20',
          remainingLossPctOfEquity: '5',
        },
      },
    },
    brokerCapabilities: overrides.brokerCapabilities ?? {
      capabilitiesStateVersion: 'broker-capabilities:1',
      market: true,
      stop: true,
      stopLimit: { supported: true, limitOffsetBps: 25 },
    },
  };
}

describe('D2 deterministic sizing golden vectors', () => {
  it.each(sizingGoldens.cases)('$name', (testCase) => {
    const intent = singleIntent();
    if (testCase.account.markPrice === null) {
      intent['direction'] = 'flat';
      intent['targetExposure'] = { minPct: 0, maxPct: 0 };
      intent['maxAcceptableLossPct'] = 0;
    }
    const result = sizeStewardDecision(sizingInput({
      rawIntent: intent,
      account: {
        equity: testCase.account.equity,
        instrument: {
          positionQuantity: testCase.account.positionQuantity,
          markPrice: testCase.account.markPrice,
          quantityIncrement: testCase.account.quantityIncrement,
        },
      },
      risk: {
        accountId: 'mock-simulator-1',
        riskStateVersion: 'risk-state:golden',
        envelope: {
          kind: 'available',
          envelopeVersion: 3,
          scopeAllowed: true,
          increaseAllowed: true,
          caps: testCase.caps,
        },
      },
      brokerCapabilities: {
        capabilitiesStateVersion: 'broker-capabilities:golden',
        ...testCase.capabilities,
      },
    }));

    expect(result.kind).toBe(testCase.expected.kind);
    if (result.kind === 'rejected') {
      expect(result.code).toBe(testCase.expected.code);
      return;
    }
    expect(result.kind).not.toBe('portfolio_shadow');
    if (result.kind === 'portfolio_shadow') return;
    expect(result.operations[0]?.totalQuantity).toBe(testCase.expected.quantity);
    expect(result.protections[0]?.orderType ?? null).toBe(testCase.expected.protectionOrderType);
    if (testCase.expected.limitPrice !== undefined) {
      expect(result.protections[0]).toMatchObject({ limitPrice: testCase.expected.limitPrice });
    }
  });

  it('matches the approved raw-intent fingerprint and broker protection vectors', () => {
    const intent = singleIntent();
    expect(canonicalIntentFingerprint(intent)).toBe(fingerprintGoldens['singleIntent']);
    for (const testCase of protectionCases.cases) {
      expect(selectStewardProtection(
        { capabilitiesStateVersion: 'broker-capabilities:fixture', ...testCase.capabilities },
        testCase.request,
      ), testCase.name).toEqual(testCase.expected);
    }
  });
});

describe('D2 sizing safety boundaries', () => {
  it('rejects agent-authored totalQuantity before schema normalization', () => {
    const rawIntent = singleIntent();
    rawIntent['totalQuantity'] = '999999';
    const result = sizeStewardDecision(sizingInput({ rawIntent }));
    expect(result).toMatchObject({ kind: 'rejected', code: 'agent_quantity_forbidden' });
    expect(result.intentFingerprint).toBe(canonicalIntentFingerprint(rawIntent));
  });

  it('keeps portfolio intent proposal-only even with executable-looking inputs', () => {
    const rawIntent = portfolioIntent();
    const result = sizeStewardDecision({
      ...sizingInput({ rawIntent }),
      decisionWakeId: 'wake-v3-portfolio',
      snapshot: {
        snapshotId: rawIntent['snapshotId'],
        snapshotSha256: rawIntent['snapshotSha256'],
      },
    });
    expect(result).toMatchObject({
      kind: 'portfolio_shadow',
      code: 'portfolio_proposal_only',
      targetCount: 2,
    });
    expect('operations' in result).toBe(false);
  });

  it('fails closed for missing envelopes, missing prices, invalid stops, and naked entry capability', () => {
    const missingEnvelope = sizeStewardDecision(sizingInput({
      risk: { accountId: 'mock-simulator-1', riskStateVersion: 'risk:missing', envelope: { kind: 'missing' } },
    }));
    expect(missingEnvelope).toMatchObject({ kind: 'rejected', code: 'envelope_missing' });

    const unpriceable = sizeStewardDecision(sizingInput({
      account: { instrument: { markPrice: null } },
    }));
    expect(unpriceable).toMatchObject({ kind: 'rejected', code: 'unpriceable' });

    const wronglySided = singleIntent();
    wronglySided['invalidation'] = [{ kind: 'price_below', value: '104', note: 'wrong side' }];
    const noStop = sizeStewardDecision(sizingInput({ rawIntent: wronglySided }));
    expect(noStop).toMatchObject({ kind: 'rejected', code: 'no_priceable_invalidation' });

    const noProtection = sizeStewardDecision(sizingInput({
      brokerCapabilities: {
        capabilitiesStateVersion: 'broker:none',
        market: true,
        stop: false,
        stopLimit: { supported: false },
      },
    }));
    expect(noProtection).toMatchObject({ kind: 'rejected', code: 'protective_order_unsupported' });
  });

  it.each([
    {
      name: 'position cap',
      caps: {
        maxPositionPctOfEquity: '12',
        maxSingleOrderPctOfEquity: '20',
        remainingLossPctOfEquity: '5',
      },
      expectedCap: 'riskEnvelope.maxPositionPctOfEquity',
    },
    {
      name: 'remaining loss cap',
      caps: {
        maxPositionPctOfEquity: '25',
        maxSingleOrderPctOfEquity: '20',
        remainingLossPctOfEquity: '0.7',
      },
      expectedCap: 'riskEnvelope.remainingLossPctOfEquity',
    },
  ])('intersects target exposure with the $name using Decimal arithmetic', ({ caps, expectedCap }) => {
    const result = sizeStewardDecision(sizingInput({
      risk: {
        accountId: 'mock-simulator-1',
        riskStateVersion: 'risk:cap-test',
        envelope: {
          kind: 'available',
          envelopeVersion: 3,
          scopeAllowed: true,
          increaseAllowed: true,
          caps,
        },
      },
    }));
    expect(result).toMatchObject({
      kind: 'clipped',
      operations: [{ totalQuantity: '12' }],
    });
    if (result.kind === 'clipped') expect(result.appliedCaps).toContain(expectedCap);
  });

  it('rejects when the loss ceiling falls below the agent target minimum', () => {
    const result = sizeStewardDecision(sizingInput({
      risk: {
        accountId: 'mock-simulator-1',
        riskStateVersion: 'risk:no-intersection',
        envelope: {
          kind: 'available',
          envelopeVersion: 3,
          scopeAllowed: true,
          increaseAllowed: true,
          caps: {
            maxPositionPctOfEquity: '25',
            maxSingleOrderPctOfEquity: '20',
            remainingLossPctOfEquity: '0.5',
          },
        },
      },
    }));
    expect(result).toMatchObject({ kind: 'rejected', code: 'empty_feasible_quantity' });
  });

  it('records the agent loss budget when it is the binding loss constraint', () => {
    const rawIntent = singleIntent();
    rawIntent['maxAcceptableLossPct'] = 0.7;
    const result = sizeStewardDecision(sizingInput({ rawIntent }));
    expect(result).toMatchObject({ kind: 'clipped', operations: [{ totalQuantity: '12' }] });
    if (result.kind === 'clipped') {
      expect(result.appliedCaps).toContain('intent.maxAcceptableLossPct');
      expect(result.appliedCaps).not.toContain('riskEnvelope.remainingLossPctOfEquity');
    }
  });

  it('splits a direction flip into a market reduction and one protected increase', () => {
    const result = sizeStewardDecision(sizingInput({
      account: { instrument: { positionQuantity: '-5' } },
    }));
    expect(result).toMatchObject({
      kind: 'proposal',
      operations: [
        { effect: 'reduce', side: 'BUY', totalQuantity: '5' },
        { effect: 'increase', side: 'BUY', totalQuantity: '15' },
      ],
    });
    if (result.kind === 'proposal' || result.kind === 'clipped') {
      expect(result.protections).toHaveLength(1);
      expect(result.protections[0]?.operationId).toBe(result.operations[1]?.operationId);
    }

    const noMarket = sizeStewardDecision(sizingInput({
      account: { instrument: { positionQuantity: '-5' } },
      brokerCapabilities: {
        capabilitiesStateVersion: 'broker:no-market-flip',
        market: false,
        stop: true,
        stopLimit: { supported: false },
      },
    }));
    expect(noMarket).toMatchObject({ kind: 'rejected', code: 'market_reduce_risk_unsupported' });
  });

  it('allows an in-scope-independent reduction under reduce-only but rejects new exposure', () => {
    const reduceRiskView = {
      accountId: 'mock-simulator-1',
      riskStateVersion: 'risk:reduce-only',
      envelope: {
        kind: 'available',
        envelopeVersion: 3,
        scopeAllowed: false,
        increaseAllowed: false,
        caps: {
          maxPositionPctOfEquity: '10',
          maxSingleOrderPctOfEquity: '20',
          remainingLossPctOfEquity: '0',
        },
      },
    };
    const reduction = sizeStewardDecision(sizingInput({
      account: { instrument: { positionQuantity: '20' } },
      risk: reduceRiskView,
    }));
    expect(reduction).toMatchObject({
      kind: 'proposal',
      operations: [{ effect: 'reduce', side: 'SELL', totalQuantity: '5' }],
      protections: [],
    });

    const increase = sizeStewardDecision(sizingInput({
      account: { instrument: { positionQuantity: '5' } },
      risk: reduceRiskView,
    }));
    expect(increase).toMatchObject({ kind: 'rejected', code: 'scope_violation' });
  });

  it('rejects a broker operation quantity that cannot align to the declared increment', () => {
    const rawIntent = singleIntent();
    rawIntent['direction'] = 'flat';
    rawIntent['targetExposure'] = { minPct: 0, maxPct: 0 };
    const result = sizeStewardDecision(sizingInput({
      rawIntent,
      account: { instrument: { positionQuantity: '7.5', markPrice: null, quantityIncrement: '1' } },
    }));
    expect(result).toMatchObject({ kind: 'rejected', code: 'empty_feasible_quantity' });
  });

  it('lets a deterministic flat reduction proceed without a loss budget but never without market reduction support', () => {
    const rawIntent = singleIntent();
    rawIntent['direction'] = 'flat';
    rawIntent['targetExposure'] = { minPct: 0, maxPct: 0 };
    rawIntent['maxAcceptableLossPct'] = 0;
    const base = sizingInput({
      rawIntent,
      decision: 'reduce_risk',
      account: { instrument: { positionQuantity: '-7.5', markPrice: null, quantityIncrement: '0.5' } },
    });
    const reduced = sizeStewardDecision(base);
    expect(reduced).toMatchObject({
      kind: 'proposal',
      operations: [{ effect: 'reduce', side: 'BUY', totalQuantity: '7.5' }],
      protections: [],
    });

    const unsupported = sizeStewardDecision({
      ...base,
      brokerCapabilities: {
        capabilitiesStateVersion: 'broker:no-market',
        market: false,
        stop: true,
        stopLimit: { supported: false },
      },
    });
    expect(unsupported).toMatchObject({ kind: 'rejected', code: 'market_reduce_risk_unsupported' });
  });

  it('records every relevant source version directly on SizingOutcome', () => {
    const result = sizeStewardDecision(sizingInput());
    expect(result.sourceStateVersions).toEqual({
      accountState: 'account-state:1',
      riskState: 'risk-state:1',
      riskEnvelope: 3,
      brokerCapabilities: 'broker-capabilities:1',
    });
    expect(stewardSizingOutcomeSchema.parse(result)).toEqual(result);
  });
});

describe('D2 source-state version barrier', () => {
  const expected = {
    accountState: 'account:1',
    riskState: 'risk:1',
    riskEnvelope: 3,
    brokerCapabilities: 'broker:1',
  };

  it('accepts an exact reread and identifies envelope churn separately', () => {
    expect(compareStewardSizingSourceVersions(expected, clone(expected))).toEqual({ ok: true });
    expect(compareStewardSizingSourceVersions(expected, { ...expected, riskEnvelope: 4 })).toMatchObject({
      ok: false,
      code: 'envelope_version_changed',
      changed: ['riskEnvelope'],
    });
  });

  it('rejects every other source-state change and does not normalize version types', () => {
    for (const [key, value] of [
      ['accountState', 'account:2'],
      ['riskState', 'risk:2'],
      ['brokerCapabilities', 'broker:2'],
      ['riskEnvelope', '3'],
    ] as const) {
      const result = compareStewardSizingSourceVersions(expected, { ...expected, [key]: value });
      expect(result).toMatchObject({ ok: false, changed: [key] });
      if (key !== 'riskEnvelope') expect(result).toMatchObject({ code: 'source_state_changed' });
    }
  });
});
