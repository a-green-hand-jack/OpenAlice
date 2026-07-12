import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  StewardExecutionRecordConflictError,
  StewardExecutionRecordCorruptionError,
  buildStewardExecutionRecord,
  canonicalExecutionRecordFingerprint,
  createStewardExecutionRecordStore,
  stewardExecutionRecordSchema,
} from './execution-record.js';
import { canonicalIntentFingerprint, canonicalizeJson } from './ledger-receipt.js';
import { sizeStewardDecision, stewardSizingOutcomeSchema } from './sizing.js';

const here = dirname(fileURLToPath(import.meta.url));
const singleLedger = JSON.parse(readFileSync(
  join(here, '../../../tools/steward-contract-proof/fixtures/d2/ledger-v3-single.json'),
  'utf8',
)) as Record<string, unknown>;
const fingerprintGoldens = JSON.parse(readFileSync(
  join(here, '../../../tools/steward-contract-proof/fixtures/d2/fingerprint-goldens.json'),
  'utf8',
)) as Record<string, string>;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function rawIntent(): Record<string, unknown> {
  return clone(singleLedger['intent'] as Record<string, unknown>);
}

function sizingOutcome(intent = rawIntent()) {
  return sizeStewardDecision({
    decisionWakeId: 'wake-v3-single',
    accountId: 'mock-simulator-1',
    decision: 'propose_change',
    rawIntent: intent,
    snapshot: {
      snapshotId: intent['snapshotId'],
      snapshotSha256: intent['snapshotSha256'],
    },
    account: {
      accountId: 'mock-simulator-1',
      accountStateVersion: 'account-state:1',
      equity: '10000',
      instrument: {
        instrument: 'mock-simulator-1/ASSET-A',
        positionQuantity: '0',
        markPrice: '100',
        contractMultiplier: '1',
        quantityIncrement: '1',
      },
    },
    risk: {
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
    brokerCapabilities: {
      capabilitiesStateVersion: 'broker-capabilities:1',
      market: true,
      stop: true,
      stopLimit: { supported: false },
    },
  });
}

function executionRecord() {
  const intent = rawIntent();
  return buildStewardExecutionRecord({
    decisionWakeId: 'wake-v3-single',
    accountId: 'mock-simulator-1',
    rawIntent: intent,
    snapshot: {
      snapshotId: String(intent['snapshotId']),
      snapshotSha256: String(intent['snapshotSha256']),
    },
    sizingOutcome: sizingOutcome(intent),
  });
}

async function withWorkspace<T>(run: (workspace: string) => Promise<T>): Promise<T> {
  const workspace = await mkdtemp(join(tmpdir(), 'openalice-execution-record-'));
  try {
    return await run(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

describe('D2 deterministic Execution Record', () => {
  it('binds raw intent, snapshot identity, SizingOutcome, and source versions', () => {
    const record = executionRecord();
    expect(record.intentFingerprint).toBe(fingerprintGoldens['singleIntent']);
    expect(record.intentFingerprint).toBe(canonicalIntentFingerprint(rawIntent()));
    expect(record.recordId).toBe(`execution:wake-v3-single:${record.intentFingerprint}`);
    expect(record.snapshotId).toBe('snap:wake-v3-single');
    expect(record.sourceStateVersions).toEqual(record.sizingOutcome.sourceStateVersions);
    expect(record.venueOutcomes).toEqual([]);
    expect(record.reconciliation.status).toBe('not_dispatched');
    expect(record.recordFingerprint).toBe(canonicalExecutionRecordFingerprint(record));
    expect(stewardExecutionRecordSchema.parse(record)).toEqual(record);
  });

  it('refuses normalized or substituted linkage', () => {
    const intent = rawIntent();
    const outcome = sizingOutcome(intent);
    const substituted = { ...intent, confidence: 'high' };
    expect(() => buildStewardExecutionRecord({
      decisionWakeId: 'wake-v3-single',
      accountId: 'mock-simulator-1',
      rawIntent: substituted,
      snapshot: {
        snapshotId: String(intent['snapshotId']),
        snapshotSha256: String(intent['snapshotSha256']),
      },
      sizingOutcome: outcome,
    })).toThrow(/intent_fingerprint_mismatch/);

    expect(() => buildStewardExecutionRecord({
      decisionWakeId: 'wake-other',
      accountId: 'mock-simulator-1',
      rawIntent: intent,
      snapshot: {
        snapshotId: String(intent['snapshotId']),
        snapshotSha256: String(intent['snapshotSha256']),
      },
      sizingOutcome: outcome,
    })).toThrow(/wake_id_mismatch/);
  });

  it('keeps nested raw __proto__/constructor intent keys distinct through sizing and record publication', async () => {
    await withWorkspace(async (workspace) => {
      const cleanIntent = rawIntent();
      const cleanRaw = JSON.stringify(cleanIntent);
      const hostileRaw = cleanRaw.replace(
        '"targetExposure":{',
        '"targetExposure":{"__proto__":{"polluted":true},"constructor":{"prototype":{"constructorPolluted":true}},',
      );
      expect(hostileRaw).not.toBe(cleanRaw);
      const hostileIntent = JSON.parse(hostileRaw) as Record<string, unknown>;
      const hostileExposure = hostileIntent['targetExposure'] as Record<string, unknown>;
      const canonicalExposure = (
        canonicalizeJson(hostileIntent) as Record<string, unknown>
      )['targetExposure'] as Record<string, unknown>;
      expect(Object.prototype.hasOwnProperty.call(hostileExposure, '__proto__')).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(hostileExposure, 'constructor')).toBe(true);
      expect(Object.getPrototypeOf(canonicalExposure)).toBeNull();
      expect(Object.prototype.hasOwnProperty.call(canonicalExposure, '__proto__')).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(canonicalExposure, 'constructor')).toBe(true);
      const clean = buildStewardExecutionRecord({
        decisionWakeId: 'wake-v3-single',
        accountId: 'mock-simulator-1',
        rawIntent: cleanIntent,
        snapshot: {
          snapshotId: String(cleanIntent['snapshotId']),
          snapshotSha256: String(cleanIntent['snapshotSha256']),
        },
        sizingOutcome: sizingOutcome(cleanIntent),
      });
      const hostile = buildStewardExecutionRecord({
        decisionWakeId: 'wake-v3-single',
        accountId: 'mock-simulator-1',
        rawIntent: hostileIntent,
        snapshot: {
          snapshotId: String(hostileIntent['snapshotId']),
          snapshotSha256: String(hostileIntent['snapshotSha256']),
        },
        sizingOutcome: sizingOutcome(hostileIntent),
      });

      expect(hostile.sizingOutcome).toMatchObject({ kind: 'rejected', code: 'invalid_intent' });
      expect(hostile.intentFingerprint).not.toBe(clean.intentFingerprint);
      expect(hostile.recordId).not.toBe(clean.recordId);
      expect((Object.prototype as { polluted?: unknown }).polluted).toBeUndefined();
      expect((Object.prototype as { constructorPolluted?: unknown }).constructorPolluted).toBeUndefined();

      const store = createStewardExecutionRecordStore(workspace);
      await expect(store.publish(clean)).resolves.toEqual(clean);
      await expect(store.publish(hostile)).resolves.toEqual(hostile);
      await expect(store.publish(hostile)).resolves.toEqual(hostile);
      expect(await readdir(join(workspace, '.alice', 'steward', 'execution-records'))).toHaveLength(2);
    });
  });
});

describe('D2 immutable Execution Record store', () => {
  it('adopts exact duplicate publications, including concurrent duplicates', async () => {
    await withWorkspace(async (workspace) => {
      const store = createStewardExecutionRecordStore(workspace);
      const record = executionRecord();
      const results = await Promise.all(Array.from({ length: 128 }, () => store.publish(record)));
      expect(results.every((result) => result.recordFingerprint === record.recordFingerprint)).toBe(true);
      expect(await store.read(record.recordId)).toEqual(record);
      expect(await readdir(join(workspace, '.alice', 'steward', 'execution-records'))).toHaveLength(1);
    });
  });

  it('rejects a same-identity duplicate from a different source-state version', async () => {
    await withWorkspace(async (workspace) => {
      const store = createStewardExecutionRecordStore(workspace);
      const original = executionRecord();
      await store.publish(original);

      const changedOutcome = clone(original.sizingOutcome);
      changedOutcome.sourceStateVersions.accountState = 'account-state:2';
      const parsedChangedOutcome = stewardSizingOutcomeSchema.parse(changedOutcome);
      const intent = rawIntent();
      const divergent = buildStewardExecutionRecord({
        decisionWakeId: original.decisionWakeId,
        accountId: original.accountId,
        rawIntent: intent,
        snapshot: {
          snapshotId: original.snapshotId,
          snapshotSha256: original.snapshotSha256,
        },
        sizingOutcome: parsedChangedOutcome,
      });
      expect(divergent.recordId).toBe(original.recordId);
      expect(divergent.recordFingerprint).not.toBe(original.recordFingerprint);
      await expect(store.publish(divergent)).rejects.toBeInstanceOf(StewardExecutionRecordConflictError);
      expect(await store.read(original.recordId)).toEqual(original);
    });
  });

  it('has exactly one immutable winner under adversarial divergent-version contention', async () => {
    await withWorkspace(async (workspace) => {
      const store = createStewardExecutionRecordStore(workspace);
      const first = executionRecord();
      const changedOutcome = clone(first.sizingOutcome);
      changedOutcome.sourceStateVersions.riskState = 'risk-state:2';
      const intent = rawIntent();
      const second = buildStewardExecutionRecord({
        decisionWakeId: first.decisionWakeId,
        accountId: first.accountId,
        rawIntent: intent,
        snapshot: { snapshotId: first.snapshotId, snapshotSha256: first.snapshotSha256 },
        sizingOutcome: stewardSizingOutcomeSchema.parse(changedOutcome),
      });

      const attempts = Array.from({ length: 512 }, (_, index) => store.publish(index % 2 === 0 ? first : second));
      const results = await Promise.allSettled(attempts);
      const winner = await store.read(first.recordId);
      expect(winner).not.toBeNull();
      const fulfilled = results.filter((result): result is PromiseFulfilledResult<typeof first> => result.status === 'fulfilled');
      const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      expect(fulfilled.length).toBeGreaterThan(0);
      expect(rejected.length).toBeGreaterThan(0);
      expect(fulfilled.every((result) => result.value.recordFingerprint === winner?.recordFingerprint)).toBe(true);
      expect(rejected.every((result) => result.reason instanceof StewardExecutionRecordConflictError)).toBe(true);
      expect(await readdir(join(workspace, '.alice', 'steward', 'execution-records'))).toHaveLength(1);
    });
  });

  it('detects corruption and never overwrites it while adopting a duplicate', async () => {
    await withWorkspace(async (workspace) => {
      const store = createStewardExecutionRecordStore(workspace);
      const record = executionRecord();
      await store.publish(record);
      await writeFile(store.path(record.recordId), `${JSON.stringify({ ...record, accountId: 'tampered' })}\n`, 'utf8');

      await expect(store.read(record.recordId)).rejects.toBeInstanceOf(StewardExecutionRecordCorruptionError);
      await expect(store.publish(record)).rejects.toBeInstanceOf(StewardExecutionRecordCorruptionError);
    });
  });

  it('rejects in-memory fingerprint and version-link tampering before publication', async () => {
    await withWorkspace(async (workspace) => {
      const store = createStewardExecutionRecordStore(workspace);
      const record = executionRecord();
      await expect(store.publish({ ...record, recordFingerprint: 'f'.repeat(64) })).rejects.toThrow(/fingerprint mismatch/);

      const mismatched = clone(record) as Record<string, unknown>;
      mismatched['sourceStateVersions'] = {
        ...(mismatched['sourceStateVersions'] as Record<string, unknown>),
        riskEnvelope: 4,
      };
      mismatched['recordFingerprint'] = canonicalExecutionRecordFingerprint(mismatched);
      expect(stewardExecutionRecordSchema.safeParse(mismatched).success).toBe(false);
    });
  });
});
