import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';
import {
  UTA_STEWARD_WORKSPACE_AUTHZ_HEADER,
  createUTAClient,
} from '@traderalice/uta-protocol';

import {
  UTAAccountSDK,
  type BoundUTAAccountStewardMutationCapability,
} from '../../services/uta-client/UTAAccountSDK.js';
import { createStewardExecutionRecordStore } from './execution-record.js';
import {
  STEWARD_UTA_MUTATION_BOUNDARY_VERSION,
  STEWARD_UTA_MUTATION_MINIMUM_AUTHZ_LEVEL,
  StewardSizingIntegrationError,
  integrateStewardSizingOutcome,
  type IntegrateStewardSizingInput,
  type StewardUtaMutationRequest,
  type StewardUtaMutationResponse,
} from './sizing-integration.js';
import {
  compareStewardSizingSourceVersions,
  sizeStewardDecision,
  type StewardSizingOutcome,
  type StewardSizingSourceVersions,
} from './sizing.js';

const here = dirname(fileURLToPath(import.meta.url));
const singleLedger = JSON.parse(readFileSync(
  join(here, '../../../tools/steward-contract-proof/fixtures/d2/ledger-v3-single.json'),
  'utf8',
)) as Record<string, unknown>;
const portfolioLedger = JSON.parse(readFileSync(
  join(here, '../../../tools/steward-contract-proof/fixtures/d2/ledger-v3-portfolio.json'),
  'utf8',
)) as Record<string, unknown>;

const ACCOUNT_ID = 'mock-simulator-1';
const UTA_MUTATION_REFERENCE = 'uta-mutation:wake-v3-single:1';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function rawSingleIntent(): Record<string, unknown> {
  return clone(singleLedger['intent'] as Record<string, unknown>);
}

function sizingOutcome(positionQuantity = '0'): StewardSizingOutcome {
  const rawIntent = rawSingleIntent();
  return sizeStewardDecision({
    decisionWakeId: 'wake-v3-single',
    accountId: ACCOUNT_ID,
    decision: 'propose_change',
    rawIntent,
    snapshot: {
      snapshotId: rawIntent['snapshotId'],
      snapshotSha256: rawIntent['snapshotSha256'],
    },
    account: {
      accountId: ACCOUNT_ID,
      accountStateVersion: 'account-state:1',
      equity: '10000',
      instrument: {
        instrument: `${ACCOUNT_ID}/ASSET-A`,
        positionQuantity,
        markPrice: '100',
        contractMultiplier: '1',
        quantityIncrement: '1',
      },
    },
    risk: {
      accountId: ACCOUNT_ID,
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

interface UtaBoundaryHarnessOptions {
  readonly boundAccountId?: string;
  readonly trustedWorkspaceAuthzLevel?: 'read_only' | 'paper' | 'small_live' | 'limited_autonomy';
  readonly initialSourceVersions: StewardSizingSourceVersions;
  readonly dispatch?: (request: StewardUtaMutationRequest) => Promise<void>;
  readonly loseFirstAcknowledgement?: boolean;
}

function createUtaBoundaryHarness(options: UtaBoundaryHarnessOptions) {
  let sourceVersions = clone(options.initialSourceVersions);
  let loseFirstAcknowledgement = options.loseFirstAcknowledgement ?? false;
  const completed = new Set<string>();
  const requests: StewardUtaMutationRequest[] = [];
  const dispatch = vi.fn(options.dispatch ?? (async () => undefined));

  const client = createUTAClient({
    baseUrl: 'http://uta.test',
    internalToken: 'test-internal-token',
    fetch: async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as StewardUtaMutationRequest;
      requests.push(request);
      const base = {
        version: STEWARD_UTA_MUTATION_BOUNDARY_VERSION,
        accountId: ACCOUNT_ID,
        utaMutationReference: request.utaMutationReference,
        operationId: request.operation.operationId,
      } as const;

      // This simulates the UTA-owned boundary: authz comes from its trusted
      // binding and the D2 mutation minimum cannot be supplied by Alice.
      const workspaceAuthzLevel = new Headers(init?.headers)
        .get(UTA_STEWARD_WORKSPACE_AUTHZ_HEADER);
      if (workspaceAuthzLevel === 'read_only') {
        return jsonResponse({ ...base, status: 'rejected', code: 'authz_below_required' });
      }
      expect(STEWARD_UTA_MUTATION_MINIMUM_AUTHZ_LEVEL).toBe('paper');

      const idempotencyKey = `${request.utaMutationReference}\0${request.operation.operationId}`;
      if (completed.has(idempotencyKey)) {
        return jsonResponse({ ...base, status: 'accepted', deduplicated: true });
      }

      const comparison = compareStewardSizingSourceVersions(
        request.expectedSourceVersions,
        sourceVersions,
      );
      if (!comparison.ok) {
        return jsonResponse({
          ...base,
          status: 'rejected',
          code: comparison.code,
          changed: [...comparison.changed],
        });
      }

      await dispatch(request);
      completed.add(idempotencyKey);
      if (loseFirstAcknowledgement) {
        loseFirstAcknowledgement = false;
        throw new Error('UTA acknowledgement lost after owned invocation');
      }
      return jsonResponse({ ...base, status: 'accepted', deduplicated: false });
    },
  });
  const account = new UTAAccountSDK({ client, id: options.boundAccountId ?? ACCOUNT_ID });
  const capability = account.bindStewardMutationCapability(
    () => options.trustedWorkspaceAuthzLevel ?? 'paper',
  );

  return {
    capability,
    dispatch,
    requests,
    setSourceVersions(value: StewardSizingSourceVersions) {
      sourceVersions = clone(value);
    },
  };
}

function jsonResponse(body: StewardUtaMutationResponse): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function integrationInput(input: {
  readonly outcome?: StewardSizingOutcome;
  readonly rawIntent?: unknown;
  readonly workspace: string;
  readonly capability: BoundUTAAccountStewardMutationCapability;
}): IntegrateStewardSizingInput {
  return {
    rawIntent: input.rawIntent ?? rawSingleIntent(),
    sizingOutcome: input.outcome ?? sizingOutcome(),
    utaMutationReference: UTA_MUTATION_REFERENCE,
    utaMutationCapability: input.capability,
    executionRecordStore: createStewardExecutionRecordStore(input.workspace),
  };
}

async function withWorkspace<T>(run: (workspace: string) => Promise<T>): Promise<T> {
  const workspace = await mkdtemp(join(tmpdir(), 'openalice-sizing-integration-'));
  try {
    return await run(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

describe('D2 deterministic sizing integration', () => {
  it('sends only deterministic quantity through the UTA-owned boundary and publishes a separate record', async () => {
    await withWorkspace(async (workspace) => {
      const outcome = sizingOutcome();
      const executable = outcome.kind === 'proposal' || outcome.kind === 'clipped' ? outcome : null;
      expect(executable).not.toBeNull();
      const uta = createUtaBoundaryHarness({ initialSourceVersions: outcome.sourceStateVersions });
      const store = createStewardExecutionRecordStore(workspace);

      const result = await integrateStewardSizingOutcome({
        ...integrationInput({ workspace, outcome, capability: uta.capability }),
        executionRecordStore: store,
      });

      expect(result.status).toBe('operations_accepted');
      if (result.status !== 'operations_accepted') return;
      expect(uta.dispatch).toHaveBeenCalledTimes(1);
      expect(uta.requests).toHaveLength(1);
      expect(uta.requests[0]?.operation.totalQuantity).toBe('15');
      expect(uta.requests[0]).toHaveProperty(
        'protection.triggerPrice',
        executable?.protections[0]?.triggerPrice,
      );
      expect(uta.requests[0]).not.toHaveProperty('rawIntent');
      expect(uta.requests[0]).not.toHaveProperty('workspaceAuthzLevel');
      expect(uta.requests[0]).not.toHaveProperty('minimumAuthzLevel');
      expect(uta.requests[0]?.expectedSourceVersions).toEqual(executable?.sourceStateVersions);
      expect(uta.requests[0]?.utaMutationReference).toBe(result.executionRecord.utaMutationReference);
      expect(result.executionRecord).not.toHaveProperty('venueOutcomes');
      expect(result.executionRecord).not.toHaveProperty('reconciliation');
      expect(result.executionRecord).not.toHaveProperty('mutationLifecycle');
      await expect(store.publish(result.executionRecord)).resolves.toEqual(result.executionRecord);
      expect(await readdir(join(workspace, '.alice', 'steward', 'execution-records'))).toHaveLength(1);
    });
  });

  it('leaves envelope admission and all source-version drift checks inside the UTA boundary', async () => {
    await withWorkspace(async (workspace) => {
      const outcome = sizingOutcome();
      const drifted = { ...outcome.sourceStateVersions, riskEnvelope: 4 };
      const uta = createUtaBoundaryHarness({ initialSourceVersions: drifted });

      const result = await integrateStewardSizingOutcome(integrationInput({
        workspace,
        outcome,
        capability: uta.capability,
      }));

      expect(result).toMatchObject({
        status: 'rejected',
        code: 'envelope_version_changed',
        changed: ['riskEnvelope'],
      });
      expect(uta.requests).toHaveLength(1);
      expect(uta.dispatch).not.toHaveBeenCalled();
    });
  });

  it('rechecks inside UTA for every operation and blocks a later operation after source drift', async () => {
    await withWorkspace(async (workspace) => {
      const outcome = sizingOutcome('-5');
      const executable = outcome.kind === 'proposal' || outcome.kind === 'clipped' ? outcome : null;
      expect(executable?.operations).toMatchObject([
        { effect: 'reduce', totalQuantity: '5' },
        { effect: 'increase', totalQuantity: '15' },
      ]);
      const uta = createUtaBoundaryHarness({
        initialSourceVersions: outcome.sourceStateVersions,
        dispatch: async () => {
          uta.setSourceVersions({ ...outcome.sourceStateVersions, riskState: 'risk-state:2' });
        },
      });

      const result = await integrateStewardSizingOutcome(integrationInput({
        workspace,
        outcome,
        capability: uta.capability,
      }));

      expect(result).toMatchObject({
        status: 'rejected',
        code: 'source_state_changed',
        operationId: executable?.operations[1]?.operationId,
        changed: ['riskState'],
      });
      expect(uta.requests).toHaveLength(2);
      expect(uta.requests[0]).not.toHaveProperty('protection');
      expect(uta.requests[1]).toHaveProperty('protection.operationId', executable?.operations[1]?.operationId);
      expect(uta.dispatch).toHaveBeenCalledTimes(1);
    });
  });

  it.each([
    { attemptedOverride: { minimumAuthzLevel: 'read_only' }, label: 'weaker minimum' },
    { attemptedOverride: { workspaceAuthzLevel: 'limited_autonomy' }, label: 'stronger workspace claim' },
  ])('ignores a caller-supplied $label and uses the trusted UTA authz binding', async ({ attemptedOverride }) => {
    await withWorkspace(async (workspace) => {
      const outcome = sizingOutcome();
      const uta = createUtaBoundaryHarness({
        trustedWorkspaceAuthzLevel: 'read_only',
        initialSourceVersions: outcome.sourceStateVersions,
      });
      const hostile = {
        ...integrationInput({ workspace, outcome, capability: uta.capability }),
        ...attemptedOverride,
      } as IntegrateStewardSizingInput;

      const result = await integrateStewardSizingOutcome(hostile);

      expect(result).toMatchObject({ status: 'rejected', code: 'authz_below_required' });
      expect(uta.dispatch).not.toHaveBeenCalled();
      expect(uta.requests[0]).not.toHaveProperty('minimumAuthzLevel');
      expect(uta.requests[0]).not.toHaveProperty('workspaceAuthzLevel');
    });
  });

  it('rejects a capability bound to a different account before record publication or HTTP invocation', async () => {
    await withWorkspace(async (workspace) => {
      const outcome = sizingOutcome();
      const uta = createUtaBoundaryHarness({
        boundAccountId: 'mock-simulator-other',
        initialSourceVersions: outcome.sourceStateVersions,
      });

      const result = await integrateStewardSizingOutcome(integrationInput({
        workspace,
        outcome,
        capability: uta.capability,
      }));

      expect(result).toEqual({ status: 'rejected', code: 'account_identity_mismatch' });
      expect(uta.requests).toHaveLength(0);
      expect(uta.dispatch).not.toHaveBeenCalled();
      await expect(readdir(join(workspace, '.alice', 'steward', 'execution-records')))
        .rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('reuses the same UTA reference and operation id after a lost acknowledgement', async () => {
    await withWorkspace(async (workspace) => {
      const outcome = sizingOutcome();
      const uta = createUtaBoundaryHarness({
        initialSourceVersions: outcome.sourceStateVersions,
        loseFirstAcknowledgement: true,
      });
      const input = integrationInput({ workspace, outcome, capability: uta.capability });

      await expect(integrateStewardSizingOutcome(input)).rejects.toThrow(/acknowledgement lost/);
      const retry = await integrateStewardSizingOutcome(input);

      expect(retry).toMatchObject({
        status: 'operations_accepted',
        operationCount: 1,
        deduplicatedCount: 1,
      });
      expect(uta.dispatch).toHaveBeenCalledTimes(1);
      expect(uta.requests).toHaveLength(2);
      expect(uta.requests[0]?.utaMutationReference).toBe(UTA_MUTATION_REFERENCE);
      expect(uta.requests[1]?.utaMutationReference).toBe(UTA_MUTATION_REFERENCE);
      expect(uta.requests[1]?.operation.operationId).toBe(uta.requests[0]?.operation.operationId);
      expect(await readdir(join(workspace, '.alice', 'steward', 'execution-records'))).toHaveLength(1);
      if (retry.status === 'operations_accepted') {
        expect(retry.executionRecord).not.toHaveProperty('venueOutcomes');
        expect(retry.executionRecord).not.toHaveProperty('mutationLifecycle');
      }
    });
  });

  it('keeps portfolio outcomes and unprotected increases non-executable', async () => {
    await withWorkspace(async (workspace) => {
      const portfolioIntent = clone(portfolioLedger['intent'] as Record<string, unknown>);
      const portfolio = sizeStewardDecision({
        decisionWakeId: 'wake-v3-portfolio',
        accountId: ACCOUNT_ID,
        decision: 'propose_change',
        rawIntent: portfolioIntent,
        snapshot: {
          snapshotId: portfolioIntent['snapshotId'],
          snapshotSha256: portfolioIntent['snapshotSha256'],
        },
        account: {
          accountId: ACCOUNT_ID,
          accountStateVersion: 'account-state:1',
          equity: '10000',
          instrument: {
            instrument: `${ACCOUNT_ID}/ASSET-A`,
            positionQuantity: '0',
            markPrice: '100',
            contractMultiplier: '1',
            quantityIncrement: '1',
          },
        },
        risk: {
          accountId: ACCOUNT_ID,
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
      const uta = createUtaBoundaryHarness({ initialSourceVersions: portfolio.sourceStateVersions });
      const result = await integrateStewardSizingOutcome(integrationInput({
        workspace,
        outcome: portfolio,
        rawIntent: portfolioIntent,
        capability: uta.capability,
      }));
      expect(result).toEqual({ status: 'not_executable', code: 'portfolio_proposal_only' });
      expect(uta.requests).toHaveLength(0);
      expect(uta.dispatch).not.toHaveBeenCalled();

      const executable = sizingOutcome();
      const unprotected = { ...executable, protections: [] } as StewardSizingOutcome;
      await expect(integrateStewardSizingOutcome(integrationInput({
        workspace,
        outcome: unprotected,
        capability: uta.capability,
      }))).rejects.toThrow(/matching protections/);
    });
  });

  it('refuses raw intent quantities before reaching the UTA boundary', async () => {
    await withWorkspace(async (workspace) => {
      const outcome = sizingOutcome();
      const rawIntent = rawSingleIntent();
      rawIntent['totalQuantity'] = '999999';
      const uta = createUtaBoundaryHarness({ initialSourceVersions: outcome.sourceStateVersions });

      await expect(integrateStewardSizingOutcome(integrationInput({
        workspace,
        outcome,
        rawIntent,
        capability: uta.capability,
      }))).rejects.toBeInstanceOf(StewardSizingIntegrationError);
      expect(uta.requests).toHaveLength(0);
      expect(uta.dispatch).not.toHaveBeenCalled();
    });
  });
});
