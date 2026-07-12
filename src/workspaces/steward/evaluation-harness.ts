import { z } from 'zod';

import {
  validateStewardEvaluationDataManifest,
  type StewardEvaluationContent,
  type StewardEvaluationManifestValidation,
} from './evaluation-data-manifest.js';

export const STEWARD_WAKE_EVALUATION_INPUT_VERSION = 1;
export const STEWARD_WAKE_EVALUATION_REPORT_VERSION = 1;

const nonEmptyStringSchema = z.string().trim().min(1);
const checkSchema = z.object({
  id: nonEmptyStringSchema,
  passed: z.boolean(),
  detail: nonEmptyStringSchema.nullable(),
}).strict();

const uniqueChecks = (
  checks: readonly { readonly id: string }[],
  ctx: z.RefinementCtx,
  path: string,
) => {
  const seen = new Set<string>();
  for (const [index, check] of checks.entries()) {
    if (seen.has(check.id)) {
      ctx.addIssue({
        code: 'custom',
        path: [path, index, 'id'],
        message: `duplicate check id: ${check.id}`,
      });
    }
    seen.add(check.id);
  }
};

export const stewardWakeEvaluationInputSchema = z.object({
  schema: z.literal('steward-wake-evaluation-input/1'),
  version: z.literal(STEWARD_WAKE_EVALUATION_INPUT_VERSION),
  wakeId: nonEmptyStringSchema,
  protocol: z.object({
    wakeDelivered: z.boolean(),
    ledgerValidated: z.boolean(),
    finalizeMatched: z.boolean(),
    lockIntegrity: z.boolean(),
    recoveryIntegrity: z.enum(['passed', 'failed', 'not_required']),
  }).strict(),
  decision: z.object({
    contractValid: z.boolean(),
    qualityChecks: z.array(checkSchema).min(1),
  }).strict(),
  execution: z.object({
    requested: z.boolean(),
    riskEnvelopeValid: z.boolean(),
    fidelityChecks: z.array(checkSchema),
    containment: z.array(z.object({
      code: z.enum([
        'guard_refused',
        'policy_denied',
        'risk_envelope_missing',
        'envelope_version_changed',
        'state_version_changed',
      ]),
      detail: nonEmptyStringSchema,
    }).strict()),
  }).strict(),
  dataManifest: z.unknown(),
}).strict().superRefine((input, ctx) => {
  uniqueChecks(input.decision.qualityChecks, ctx, 'decision.qualityChecks');
  uniqueChecks(input.execution.fidelityChecks, ctx, 'execution.fidelityChecks');
  if (input.execution.requested && input.execution.fidelityChecks.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['execution', 'fidelityChecks'],
      message: 'requested execution requires at least one fidelity check',
    });
  }
});

export type StewardWakeEvaluationInput = z.infer<typeof stewardWakeEvaluationInputSchema>;
export type StewardEvaluationLayer = 'protocol' | 'decision' | 'execution';
export type StewardEvaluationVerdict = 'pass' | 'fail' | 'not_evaluated';
export type StewardEvaluationOutcomeStatus = StewardEvaluationVerdict | 'observed';

export interface StewardEvaluationOutcome {
  readonly layer: StewardEvaluationLayer;
  readonly classification: 'gate' | 'score' | 'containment';
  readonly code: string;
  readonly status: StewardEvaluationOutcomeStatus;
  readonly detail: string;
}

export interface StewardEvaluationLayerReport {
  readonly layer: StewardEvaluationLayer;
  readonly verdict: StewardEvaluationVerdict;
  readonly gate: 'open' | 'closed';
  readonly gateReason: string | null;
  readonly outcomes: readonly StewardEvaluationOutcome[];
}

export interface StewardWakeEvaluationReport {
  readonly schema: 'steward-wake-evaluation-report/1';
  readonly version: typeof STEWARD_WAKE_EVALUATION_REPORT_VERSION;
  readonly wakeId: string;
  readonly protocol: StewardEvaluationLayerReport;
  readonly decision: StewardEvaluationLayerReport & {
    readonly manifest: StewardEvaluationManifestValidation;
  };
  readonly execution: StewardEvaluationLayerReport & {
    readonly containment: readonly StewardEvaluationOutcome[];
  };
  /** Flat, mechanically attributed view. Every outcome carries exactly one layer. */
  readonly outcomes: readonly StewardEvaluationOutcome[];
}

export function evaluateStewardWake(
  rawInput: unknown,
  contentByRef: Readonly<Record<string, StewardEvaluationContent>>,
): StewardWakeEvaluationReport {
  const input = stewardWakeEvaluationInputSchema.parse(rawInput);
  const manifest = validateStewardEvaluationDataManifest(
    input.dataManifest,
    contentByRef,
    input.wakeId,
  );

  const protocolOutcomes: StewardEvaluationOutcome[] = [
    protocolOutcome('wake_delivery', input.protocol.wakeDelivered, 'wake delivery'),
    protocolOutcome('ledger_validation', input.protocol.ledgerValidated, 'ledger validation'),
    protocolOutcome('finalize_match', input.protocol.finalizeMatched, 'finalize marker match'),
    protocolOutcome('lock_integrity', input.protocol.lockIntegrity, 'account lock integrity'),
    protocolOutcome(
      'recovery_integrity',
      input.protocol.recoveryIntegrity !== 'failed',
      input.protocol.recoveryIntegrity === 'not_required' ? 'recovery not required' : 'recovery integrity',
    ),
  ];
  const protocolPassed = protocolOutcomes.every((outcome) => outcome.status === 'pass');
  const protocol: StewardEvaluationLayerReport = {
    layer: 'protocol',
    verdict: protocolPassed ? 'pass' : 'fail',
    gate: protocolPassed ? 'open' : 'closed',
    gateReason: protocolPassed ? null : 'protocol_failed',
    outcomes: protocolOutcomes,
  };

  const decisionGateReason = protocolPassed ? null : 'protocol_failed';
  const decisionOutcomes: StewardEvaluationOutcome[] = [
    decisionOutcome(
      'decision_contract',
      input.decision.contractValid,
      'decision contract validity',
      decisionGateReason,
    ),
    decisionOutcome(
      'data_manifest',
      manifest.valid,
      manifest.valid
        ? 'per-wake data manifest valid'
        : manifest.violations.map((violation) => violation.code).join(','),
      decisionGateReason,
    ),
    ...input.decision.qualityChecks.map((check) => decisionOutcome(
      `quality:${check.id}`,
      check.passed,
      check.detail ?? check.id,
      decisionGateReason,
    )),
  ];
  const decisionVerdict: StewardEvaluationVerdict = decisionGateReason !== null
    ? 'not_evaluated'
    : decisionOutcomes.every((outcome) => outcome.status === 'pass') ? 'pass' : 'fail';
  const decision: StewardWakeEvaluationReport['decision'] = {
    layer: 'decision',
    verdict: decisionVerdict,
    gate: decisionGateReason === null ? 'open' : 'closed',
    gateReason: decisionGateReason,
    outcomes: decisionOutcomes,
    manifest,
  };

  const executionGateReason = !protocolPassed
    ? 'protocol_failed'
    : !input.decision.contractValid
      ? 'decision_contract_invalid'
      : !input.execution.riskEnvelopeValid
        ? 'risk_envelope_invalid'
        : !input.execution.requested
          ? 'execution_not_requested'
          : null;
  const executionOutcomes: StewardEvaluationOutcome[] = [
    executionOutcome(
      'risk_envelope',
      input.execution.riskEnvelopeValid,
      'mandatory risk envelope validity',
      executionGateReason,
    ),
    ...input.execution.fidelityChecks.map((check) => executionOutcome(
      `fidelity:${check.id}`,
      check.passed,
      check.detail ?? check.id,
      executionGateReason,
    )),
  ];
  const containment = input.execution.containment.map((event): StewardEvaluationOutcome => ({
    layer: 'execution',
    classification: 'containment',
    code: `containment:${event.code}`,
    status: 'observed',
    detail: event.detail,
  }));
  const executionVerdict: StewardEvaluationVerdict = executionGateReason !== null
    ? 'not_evaluated'
    : executionOutcomes.every((outcome) => outcome.status === 'pass') ? 'pass' : 'fail';
  const execution: StewardWakeEvaluationReport['execution'] = {
    layer: 'execution',
    verdict: executionVerdict,
    gate: executionGateReason === null ? 'open' : 'closed',
    gateReason: executionGateReason,
    outcomes: [...executionOutcomes, ...containment],
    containment,
  };

  const outcomes = [...protocol.outcomes, ...decision.outcomes, ...execution.outcomes];
  return {
    schema: 'steward-wake-evaluation-report/1',
    version: STEWARD_WAKE_EVALUATION_REPORT_VERSION,
    wakeId: input.wakeId,
    protocol,
    decision,
    execution,
    outcomes,
  };
}

function protocolOutcome(code: string, passed: boolean, detail: string): StewardEvaluationOutcome {
  return {
    layer: 'protocol',
    classification: 'gate',
    code,
    status: passed ? 'pass' : 'fail',
    detail,
  };
}

function decisionOutcome(
  code: string,
  passed: boolean,
  detail: string,
  gateReason: string | null,
): StewardEvaluationOutcome {
  return {
    layer: 'decision',
    classification: code.startsWith('quality:') ? 'score' : 'gate',
    code,
    status: gateReason === null ? passed ? 'pass' : 'fail' : 'not_evaluated',
    detail: gateReason ?? detail,
  };
}

function executionOutcome(
  code: string,
  passed: boolean,
  detail: string,
  gateReason: string | null,
): StewardEvaluationOutcome {
  return {
    layer: 'execution',
    classification: code.startsWith('fidelity:') ? 'score' : 'gate',
    code,
    status: gateReason === null ? passed ? 'pass' : 'fail' : 'not_evaluated',
    detail: gateReason ?? detail,
  };
}
