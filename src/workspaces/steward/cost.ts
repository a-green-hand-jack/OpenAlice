import {
  STEWARD_STATE_SCHEMA_VERSION,
  stewardStateSchema,
  type StewardCostSummary,
  type StewardDecisionLedgerEntry,
  type StewardState,
} from './types.js';

export interface StewardCostPolicyInput {
  readonly monthlyBudget?: Record<string, unknown>;
  readonly costPolicy?: Record<string, unknown>;
}

export function summarizeStewardCosts(
  entries: readonly StewardDecisionLedgerEntry[],
): StewardCostSummary {
  const summary: StewardCostSummary = {
    entries: entries.length,
    inputTokens: 0,
    outputTokens: 0,
    modelCostUsd: 0,
    allocatedServerCostUsd: 0,
    tradingFeesUsd: 0,
    estimatedSlippageUsd: 0,
    totalEstimatedCostUsd: 0,
  };

  for (const entry of entries) {
    summary.inputTokens += entry.cost.inputTokens ?? 0;
    summary.outputTokens += entry.cost.outputTokens ?? 0;
    summary.modelCostUsd += entry.cost.modelCostUsd ?? 0;
    summary.allocatedServerCostUsd += entry.cost.allocatedServerCostUsd ?? 0;
    summary.tradingFeesUsd += entry.cost.tradingFeesUsd ?? 0;
    summary.estimatedSlippageUsd += entry.cost.estimatedSlippageUsd ?? 0;
    summary.totalEstimatedCostUsd += entry.cost.totalEstimatedCostUsd ??
      (entry.cost.modelCostUsd ?? 0) +
      (entry.cost.allocatedServerCostUsd ?? 0) +
      (entry.cost.tradingFeesUsd ?? 0) +
      (entry.cost.estimatedSlippageUsd ?? 0);
  }

  return summary;
}

export function buildStewardState(input: {
  readonly entries: readonly StewardDecisionLedgerEntry[];
  readonly config?: StewardCostPolicyInput;
  readonly now: string;
}): StewardState {
  const cost = summarizeStewardCosts(input.entries);
  return stewardStateSchema.parse({
    version: STEWARD_STATE_SCHEMA_VERSION,
    updatedAt: input.now,
    cost,
    warnings: costWarnings(cost, input.config),
  });
}

function costWarnings(
  cost: StewardCostSummary,
  config: StewardCostPolicyInput | undefined,
): string[] {
  const modelBudget = numberField(config?.monthlyBudget?.['modelUsd']);
  const serverBudget = numberField(config?.monthlyBudget?.['serverUsd']);
  const warnAtPct = numberField(config?.costPolicy?.['warnAtPct']) ?? 80;
  const warnings: string[] = [];

  if (modelBudget !== null && modelBudget > 0) {
    const warnAt = modelBudget * warnAtPct / 100;
    if (cost.modelCostUsd >= warnAt) {
      warnings.push(`model cost ${cost.modelCostUsd.toFixed(4)} >= ${warnAtPct}% of budget ${modelBudget.toFixed(4)}`);
    }
  }
  if (serverBudget !== null && serverBudget > 0) {
    const warnAt = serverBudget * warnAtPct / 100;
    if (cost.allocatedServerCostUsd >= warnAt) {
      warnings.push(`server cost ${cost.allocatedServerCostUsd.toFixed(4)} >= ${warnAtPct}% of budget ${serverBudget.toFixed(4)}`);
    }
  }

  return warnings;
}

function numberField(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
