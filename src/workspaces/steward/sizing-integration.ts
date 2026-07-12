import {
  STEWARD_UTA_MUTATION_BOUNDARY_VERSION,
  stewardUtaMutationRequestSchema,
  stewardUtaMutationResponseSchema,
  type StewardSizingSourceVersions,
  type StewardUtaMutationRejectionCode,
  type StewardUtaMutationRequest,
  type StewardUtaMutationResponse,
} from '@traderalice/uta-protocol';
import type { BoundUTAAccountStewardMutationCapability } from '../../services/uta-client/UTAAccountSDK.js';

import {
  buildStewardExecutionRecord,
  type StewardExecutionRecord,
  type StewardExecutionRecordStore,
} from './execution-record.js';
import {
  stewardSizingOutcomeSchema,
  type StewardSizingOutcome,
} from './sizing.js';

export {
  STEWARD_UTA_MUTATION_BOUNDARY_VERSION,
  STEWARD_UTA_MUTATION_MINIMUM_AUTHZ_LEVEL,
  stewardUtaMutationRequestSchema,
  stewardUtaMutationResponseSchema,
} from '@traderalice/uta-protocol';
export type {
  StewardUtaMutationRejectionCode,
  StewardUtaMutationRequest,
  StewardUtaMutationResponse,
} from '@traderalice/uta-protocol';

export interface IntegrateStewardSizingInput {
  readonly rawIntent: unknown;
  readonly sizingOutcome: StewardSizingOutcome;
  /** Opaque UTA-owned mutation/idempotency reference shared by the immutable
   * record and every UTA operation request. */
  readonly utaMutationReference: string;
  readonly utaMutationCapability: BoundUTAAccountStewardMutationCapability;
  readonly executionRecordStore: Pick<StewardExecutionRecordStore, 'publish'>;
}

export type StewardSizingIntegrationRejectionCode =
  | StewardUtaMutationRejectionCode
  | 'invalid_expected_envelope_version'
  | 'source_state_invalid'
  | 'source_state_changed'
  | 'uta_boundary_response_mismatch';

export type StewardSizingIntegrationResult =
  | {
      readonly status: 'not_executable';
      readonly code: Extract<StewardSizingOutcome, { kind: 'rejected' }>['code'] | 'portfolio_proposal_only';
    }
  | {
      readonly status: 'rejected';
      readonly code: StewardSizingIntegrationRejectionCode;
      readonly operationId?: string;
      readonly changed?: readonly (keyof StewardSizingSourceVersions)[];
      readonly executionRecord?: StewardExecutionRecord;
    }
  | {
      readonly status: 'operations_accepted';
      readonly executionRecord: StewardExecutionRecord;
      readonly operationCount: number;
      readonly deduplicatedCount: number;
    };

export class StewardSizingIntegrationError extends Error {
  constructor(readonly code: 'agent_quantity_forbidden', message: string) {
    super(message);
    this.name = 'StewardSizingIntegrationError';
  }
}

/**
 * Publish a deterministic pre-operation record, then submit each operation to
 * the single UTA-owned mutation boundary. This adapter performs no admission
 * check and has no generic dispatch callback: UTA remains authoritative for
 * authorization, source-version comparison, idempotency, and invocation.
 */
export async function integrateStewardSizingOutcome(
  input: IntegrateStewardSizingInput,
): Promise<StewardSizingIntegrationResult> {
  const outcome = stewardSizingOutcomeSchema.parse(input.sizingOutcome);
  if (outcome.kind === 'portfolio_shadow') {
    return { status: 'not_executable', code: outcome.code };
  }
  if (outcome.kind === 'rejected') {
    return { status: 'not_executable', code: outcome.code };
  }
  if (input.utaMutationCapability.accountId !== outcome.accountId) {
    return { status: 'rejected', code: 'account_identity_mismatch' };
  }
  if (containsKey(input.rawIntent, 'totalQuantity')) {
    throw new StewardSizingIntegrationError(
      'agent_quantity_forbidden',
      'Execution integration refuses raw Decision Intent quantities.',
    );
  }

  const expectedEnvelopeVersion = outcome.sourceStateVersions.riskEnvelope;
  if (
    typeof expectedEnvelopeVersion !== 'number'
    || !Number.isInteger(expectedEnvelopeVersion)
    || expectedEnvelopeVersion <= 0
  ) {
    return {
      status: 'rejected',
      code: 'invalid_expected_envelope_version',
    };
  }

  const executionRecord = await input.executionRecordStore.publish(buildStewardExecutionRecord({
    decisionWakeId: outcome.decisionWakeId,
    accountId: outcome.accountId,
    rawIntent: input.rawIntent,
    snapshot: {
      snapshotId: outcome.snapshotId,
      snapshotSha256: outcome.snapshotSha256,
    },
    utaMutationReference: input.utaMutationReference,
    sizingOutcome: outcome,
  }));

  let deduplicatedCount = 0;
  for (const operation of outcome.operations) {
    const protection = outcome.protections.find((candidate) =>
      candidate.operationId === operation.operationId);
    const request = immutableMutationRequest({
      version: STEWARD_UTA_MUTATION_BOUNDARY_VERSION,
      accountId: outcome.accountId,
      utaMutationReference: executionRecord.utaMutationReference,
      expectedSourceVersions: outcome.sourceStateVersions,
      operation,
      ...(operation.effect === 'increase' ? { protection } : {}),
    });
    const responseInput = await input.utaMutationCapability.invokeOperation(request);
    const parsed = stewardUtaMutationResponseSchema.safeParse(responseInput);
    if (!parsed.success || !responseMatchesRequest(parsed.data, request)) {
      return {
        status: 'rejected',
        code: 'uta_boundary_response_mismatch',
        operationId: operation.operationId,
        executionRecord,
      };
    }
    const response = parsed.data;
    if (response.status === 'rejected') {
      return {
        status: 'rejected',
        code: response.code,
        operationId: operation.operationId,
        ...(response.changed ? { changed: response.changed } : {}),
        executionRecord,
      };
    }
    if (response.deduplicated) deduplicatedCount += 1;
  }

  return {
    status: 'operations_accepted',
    executionRecord,
    operationCount: outcome.operations.length,
    deduplicatedCount,
  };
}

function immutableMutationRequest(input: unknown): StewardUtaMutationRequest {
  const request = stewardUtaMutationRequestSchema.parse(input);
  if ('protection' in request) {
    return Object.freeze({
      ...request,
      expectedSourceVersions: Object.freeze({ ...request.expectedSourceVersions }),
      operation: Object.freeze({ ...request.operation }),
      protection: Object.freeze({ ...request.protection }),
    });
  }
  return Object.freeze({
    ...request,
    expectedSourceVersions: Object.freeze({ ...request.expectedSourceVersions }),
    operation: Object.freeze({ ...request.operation }),
  });
}

function responseMatchesRequest(
  response: StewardUtaMutationResponse,
  request: StewardUtaMutationRequest,
): boolean {
  return response.accountId === request.accountId
    && response.utaMutationReference === request.utaMutationReference
    && response.operationId === request.operation.operationId;
}

function containsKey(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((item) => containsKey(item, key));
  if (value === null || typeof value !== 'object') return false;
  const source = value as Record<string, unknown>;
  return Object.prototype.hasOwnProperty.call(source, key)
    || Object.values(source).some((item) => containsKey(item, key));
}
