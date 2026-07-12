import { z } from 'zod';

export const STEWARD_STATIC_MODEL_CATALOG_VERSION = 1;
export const STEWARD_MODEL_COST_ACCOUNTING_VERSION = 1;
export const STEWARD_MODEL_COST_REQUEST_VERSION = 1;
export const STEWARD_MODEL_COST_SELECTION_POLICY = Object.freeze({
  id: 'steward-model-cost-lowest-cost',
  version: 1,
  order: 'estimated_cost_asc,quality_score_desc,model_id_asc',
  rounding: 'ceil_input_and_output_cost_to_micro_usd',
} as const);

const nonEmptyStringSchema = z.string().trim().min(1);
const safeCountSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const optionalQuotaSchema = safeCountSchema.nullable();

const staticModelSchema = z.object({
  id: nonEmptyStringSchema,
  enabled: z.boolean(),
  capabilities: z.array(nonEmptyStringSchema).min(1),
  qualityScore: z.number().int().min(0).max(100),
  pricing: z.object({
    inputMicrosPerMillionTokens: safeCountSchema,
    outputMicrosPerMillionTokens: safeCountSchema,
  }).strict(),
  quota: z.object({
    maxRequests: optionalQuotaSchema,
    maxInputTokens: optionalQuotaSchema,
    maxOutputTokens: optionalQuotaSchema,
    maxCostMicros: optionalQuotaSchema,
  }).strict(),
}).strict().superRefine((model, ctx) => {
  if (new Set(model.capabilities).size !== model.capabilities.length) {
    ctx.addIssue({ code: 'custom', path: ['capabilities'], message: 'capabilities must be unique' });
  }
});

export const stewardStaticModelCatalogSchema = z.object({
  schema: z.literal('steward-static-model-catalog/1'),
  version: z.literal(STEWARD_STATIC_MODEL_CATALOG_VERSION),
  source: z.enum(['static', 'fixture']),
  catalogId: nonEmptyStringSchema,
  models: z.array(staticModelSchema).min(1),
}).strict().superRefine((catalog, ctx) => {
  const seen = new Set<string>();
  for (const [index, model] of catalog.models.entries()) {
    if (seen.has(model.id)) {
      ctx.addIssue({ code: 'custom', path: ['models', index, 'id'], message: `duplicate model id: ${model.id}` });
    }
    seen.add(model.id);
  }
});

const accountingEntrySchema = z.object({
  kind: z.enum(['reservation', 'usage']),
  runId: nonEmptyStringSchema,
  wakeId: nonEmptyStringSchema,
  modelId: nonEmptyStringSchema,
  inputTokens: safeCountSchema,
  outputTokens: safeCountSchema,
  costMicros: safeCountSchema,
}).strict();

export const stewardModelCostAccountingSchema = z.object({
  schema: z.literal('steward-model-cost-accounting/1'),
  version: z.literal(STEWARD_MODEL_COST_ACCOUNTING_VERSION),
  catalogId: nonEmptyStringSchema,
  catalogVersion: z.number().int().positive(),
  periodId: nonEmptyStringSchema,
  budgetMicros: safeCountSchema,
  entries: z.array(accountingEntrySchema),
}).strict().superRefine((accounting, ctx) => {
  const seen = new Set<string>();
  for (const [index, entry] of accounting.entries.entries()) {
    if (seen.has(entry.runId)) {
      ctx.addIssue({ code: 'custom', path: ['entries', index, 'runId'], message: `duplicate run id: ${entry.runId}` });
    }
    seen.add(entry.runId);
  }
});

export const stewardModelCostRequestSchema = z.object({
  schema: z.literal('steward-model-cost-request/1'),
  version: z.literal(STEWARD_MODEL_COST_REQUEST_VERSION),
  runId: nonEmptyStringSchema,
  wakeId: nonEmptyStringSchema,
  requiredCapabilities: z.array(nonEmptyStringSchema),
  minimumQualityScore: z.number().int().min(0).max(100),
  estimatedInputTokens: safeCountSchema,
  estimatedOutputTokens: safeCountSchema,
  maxCostMicros: safeCountSchema,
}).strict().superRefine((request, ctx) => {
  if (new Set(request.requiredCapabilities).size !== request.requiredCapabilities.length) {
    ctx.addIssue({
      code: 'custom',
      path: ['requiredCapabilities'],
      message: 'requiredCapabilities must be unique',
    });
  }
});

export type StewardStaticModelCatalog = z.infer<typeof stewardStaticModelCatalogSchema>;
export type StewardStaticModel = StewardStaticModelCatalog['models'][number];
export type StewardModelCostAccounting = z.infer<typeof stewardModelCostAccountingSchema>;
export type StewardModelCostEntry = StewardModelCostAccounting['entries'][number];
export type StewardModelCostRequest = z.infer<typeof stewardModelCostRequestSchema>;

export type StewardModelRejectionCode =
  | 'disabled'
  | 'capability_missing'
  | 'quality_below_minimum'
  | 'request_cost_cap'
  | 'global_budget'
  | 'request_quota'
  | 'input_token_quota'
  | 'output_token_quota'
  | 'model_cost_quota';

export interface StewardModelCandidateRejection {
  readonly modelId: string;
  readonly reasons: readonly StewardModelRejectionCode[];
  readonly estimatedCostMicros: number;
}

export type StewardModelScheduleResult =
  | {
      readonly status: 'selected';
      readonly policy: typeof STEWARD_MODEL_COST_SELECTION_POLICY;
      readonly modelId: string;
      readonly estimatedCostMicros: number;
      readonly reservation: StewardModelCostEntry;
      readonly accounting: StewardModelCostAccounting;
      readonly rejections: readonly StewardModelCandidateRejection[];
    }
  | {
      readonly status: 'rejected';
      readonly policy: typeof STEWARD_MODEL_COST_SELECTION_POLICY;
      readonly code: 'invalid_input' | 'accounting_invalid' | 'duplicate_run' | 'no_eligible_model';
      readonly detail: string;
      readonly rejections: readonly StewardModelCandidateRejection[];
    };

export interface StewardModelCostSummary {
  readonly requests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMicros: number;
  readonly remainingBudgetMicros: number;
  readonly byModel: Readonly<Record<string, {
    readonly requests: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly costMicros: number;
  }>>;
}

type StewardModelUsage = StewardModelCostSummary['byModel'][string];

const ZERO_MODEL_USAGE: StewardModelUsage = Object.freeze({
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  costMicros: 0,
});

/**
 * Selects and reserves a model from caller-supplied static data only. There is
 * intentionally no endpoint, client, provider callback, or model invocation in
 * this surface: scheduling is a deterministic pure accounting transition.
 */
export function scheduleStewardModelCost(input: {
  readonly catalog: unknown;
  readonly accounting: unknown;
  readonly request: unknown;
}): StewardModelScheduleResult {
  const catalogResult = stewardStaticModelCatalogSchema.safeParse(input.catalog);
  const accountingResult = stewardModelCostAccountingSchema.safeParse(input.accounting);
  const requestResult = stewardModelCostRequestSchema.safeParse(input.request);
  if (!catalogResult.success || !accountingResult.success || !requestResult.success) {
    return {
      status: 'rejected',
      policy: STEWARD_MODEL_COST_SELECTION_POLICY,
      code: 'invalid_input',
      detail: [
        ...(!catalogResult.success ? catalogResult.error.issues.map((issue) => `catalog.${issue.path.join('.')}: ${issue.message}`) : []),
        ...(!accountingResult.success ? accountingResult.error.issues.map((issue) => `accounting.${issue.path.join('.')}: ${issue.message}`) : []),
        ...(!requestResult.success ? requestResult.error.issues.map((issue) => `request.${issue.path.join('.')}: ${issue.message}`) : []),
      ].join('; '),
      rejections: [],
    };
  }

  const catalog = catalogResult.data;
  const accounting = accountingResult.data;
  const request = requestResult.data;
  let accountingProblem: string | null;
  try {
    accountingProblem = validateAccounting(catalog, accounting);
  } catch (err) {
    accountingProblem = err instanceof Error ? err.message : String(err);
  }
  if (accountingProblem !== null) {
    return {
      status: 'rejected',
      policy: STEWARD_MODEL_COST_SELECTION_POLICY,
      code: 'accounting_invalid',
      detail: accountingProblem,
      rejections: [],
    };
  }
  if (accounting.entries.some((entry) => entry.runId === request.runId)) {
    return {
      status: 'rejected',
      policy: STEWARD_MODEL_COST_SELECTION_POLICY,
      code: 'duplicate_run',
      detail: request.runId,
      rejections: [],
    };
  }

  let summary: StewardModelCostSummary;
  let candidates: ReturnType<typeof assessCandidate>[];
  try {
    summary = summarizeStewardModelCosts(catalog, accounting);
    candidates = catalog.models.map((model) => assessCandidate(model, request, summary, accounting));
  } catch (err) {
    return {
      status: 'rejected',
      policy: STEWARD_MODEL_COST_SELECTION_POLICY,
      code: 'invalid_input',
      detail: err instanceof Error ? err.message : String(err),
      rejections: [],
    };
  }
  const eligible = candidates
    .filter((candidate) => candidate.reasons.length === 0)
    .sort((left, right) =>
      left.estimatedCostMicros - right.estimatedCostMicros ||
      right.model.qualityScore - left.model.qualityScore ||
      compareStableText(left.model.id, right.model.id));
  const rejections = candidates
    .filter((candidate) => candidate.reasons.length > 0)
    .sort((left, right) => compareStableText(left.model.id, right.model.id))
    .map((candidate) => ({
      modelId: candidate.model.id,
      reasons: candidate.reasons,
      estimatedCostMicros: candidate.estimatedCostMicros,
    }));
  const selected = eligible[0];
  if (!selected) {
    return {
      status: 'rejected',
      policy: STEWARD_MODEL_COST_SELECTION_POLICY,
      code: 'no_eligible_model',
      detail: 'every static catalog candidate failed capability, quality, quota, or cost gates',
      rejections,
    };
  }

  const reservation: StewardModelCostEntry = {
    kind: 'reservation',
    runId: request.runId,
    wakeId: request.wakeId,
    modelId: selected.model.id,
    inputTokens: request.estimatedInputTokens,
    outputTokens: request.estimatedOutputTokens,
    costMicros: selected.estimatedCostMicros,
  };
  return {
    status: 'selected',
    policy: STEWARD_MODEL_COST_SELECTION_POLICY,
    modelId: selected.model.id,
    estimatedCostMicros: selected.estimatedCostMicros,
    reservation,
    accounting: {
      ...accounting,
      entries: [...accounting.entries, reservation],
    },
    rejections,
  };
}

export function summarizeStewardModelCosts(
  catalogInput: unknown,
  accountingInput: unknown,
): StewardModelCostSummary {
  const catalog = stewardStaticModelCatalogSchema.parse(catalogInput);
  const accounting = stewardModelCostAccountingSchema.parse(accountingInput);
  const accountingProblem = validateAccounting(catalog, accounting);
  if (accountingProblem !== null) throw new Error(accountingProblem);

  const byModel = new Map<string, {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    costMicros: number;
  }>();
  let inputTokens = 0;
  let outputTokens = 0;
  let costMicros = 0;
  for (const entry of accounting.entries) {
    const current = byModel.get(entry.modelId) ?? {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      costMicros: 0,
    };
    current.requests = safeAdd(current.requests, 1, 'model request count');
    current.inputTokens = safeAdd(current.inputTokens, entry.inputTokens, 'model input tokens');
    current.outputTokens = safeAdd(current.outputTokens, entry.outputTokens, 'model output tokens');
    current.costMicros = safeAdd(current.costMicros, entry.costMicros, 'model cost');
    byModel.set(entry.modelId, current);
    inputTokens = safeAdd(inputTokens, entry.inputTokens, 'total input tokens');
    outputTokens = safeAdd(outputTokens, entry.outputTokens, 'total output tokens');
    costMicros = safeAdd(costMicros, entry.costMicros, 'total model cost');
  }
  return {
    requests: accounting.entries.length,
    inputTokens,
    outputTokens,
    costMicros,
    remainingBudgetMicros: Math.max(0, accounting.budgetMicros - costMicros),
    byModel: Object.fromEntries(byModel),
  };
}

export function calculateStewardModelCostMicros(
  model: Pick<StewardStaticModel, 'pricing'>,
  inputTokens: number,
  outputTokens: number,
): number {
  const input = safeCountSchema.parse(inputTokens);
  const output = safeCountSchema.parse(outputTokens);
  const inputCost = roundedUpMicros(input, model.pricing.inputMicrosPerMillionTokens);
  const outputCost = roundedUpMicros(output, model.pricing.outputMicrosPerMillionTokens);
  const total = inputCost + outputCost;
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('model cost exceeds Number.MAX_SAFE_INTEGER micro-USD');
  }
  return Number(total);
}

function validateAccounting(
  catalog: StewardStaticModelCatalog,
  accounting: StewardModelCostAccounting,
): string | null {
  if (accounting.catalogId !== catalog.catalogId || accounting.catalogVersion !== catalog.version) {
    return `accounting catalog ${accounting.catalogId}@${accounting.catalogVersion} does not match ${catalog.catalogId}@${catalog.version}`;
  }
  const modelById = new Map(catalog.models.map((model) => [model.id, model]));
  for (const entry of accounting.entries) {
    const model = modelById.get(entry.modelId);
    if (!model) return `accounting entry ${entry.runId} references unknown model ${entry.modelId}`;
    const expectedCost = calculateStewardModelCostMicros(model, entry.inputTokens, entry.outputTokens);
    if (entry.costMicros !== expectedCost) {
      return `accounting entry ${entry.runId} cost ${entry.costMicros} != deterministic cost ${expectedCost}`;
    }
  }
  return null;
}

function assessCandidate(
  model: StewardStaticModel,
  request: StewardModelCostRequest,
  summary: StewardModelCostSummary,
  accounting: StewardModelCostAccounting,
): {
  model: StewardStaticModel;
  estimatedCostMicros: number;
  reasons: StewardModelRejectionCode[];
} {
  const estimatedCostMicros = calculateStewardModelCostMicros(
    model,
    request.estimatedInputTokens,
    request.estimatedOutputTokens,
  );
  const usage = modelUsage(summary, model.id);
  const reasons: StewardModelRejectionCode[] = [];
  if (!model.enabled) reasons.push('disabled');
  if (request.requiredCapabilities.some((capability) => !model.capabilities.includes(capability))) {
    reasons.push('capability_missing');
  }
  if (model.qualityScore < request.minimumQualityScore) reasons.push('quality_below_minimum');
  if (estimatedCostMicros > request.maxCostMicros) reasons.push('request_cost_cap');
  if (summary.costMicros + estimatedCostMicros > accounting.budgetMicros) reasons.push('global_budget');
  if (exceeds(usage.requests, 1, model.quota.maxRequests)) reasons.push('request_quota');
  if (exceeds(usage.inputTokens, request.estimatedInputTokens, model.quota.maxInputTokens)) {
    reasons.push('input_token_quota');
  }
  if (exceeds(usage.outputTokens, request.estimatedOutputTokens, model.quota.maxOutputTokens)) {
    reasons.push('output_token_quota');
  }
  if (exceeds(usage.costMicros, estimatedCostMicros, model.quota.maxCostMicros)) {
    reasons.push('model_cost_quota');
  }
  return { model, estimatedCostMicros, reasons };
}

function modelUsage(summary: StewardModelCostSummary, modelId: string): StewardModelUsage {
  return Object.prototype.hasOwnProperty.call(summary.byModel, modelId)
    ? summary.byModel[modelId]!
    : ZERO_MODEL_USAGE;
}

function exceeds(used: number, requested: number, limit: number | null): boolean {
  return limit !== null && used + requested > limit;
}

function roundedUpMicros(tokens: number, microsPerMillionTokens: number): bigint {
  if (tokens === 0 || microsPerMillionTokens === 0) return 0n;
  const numerator = BigInt(tokens) * BigInt(microsPerMillionTokens);
  return (numerator + 999_999n) / 1_000_000n;
}

function compareStableText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function safeAdd(left: number, right: number, label: string): number {
  const total = left + right;
  if (!Number.isSafeInteger(total)) throw new Error(`${label} exceeds Number.MAX_SAFE_INTEGER`);
  return total;
}
