// Minimal ambient types for the campaign harness lib (plain-Node ESM,
// orchestrator tooling outside src/). Only the members consumed from
// TypeScript are declared — the harness itself runs as untyped JS. Added for
// issue #134 so the `auditFinalization` regression spec can import it under the
// root `tsc --noEmit`.

export interface FinalizationAuditInput {
  weeks?: Array<{ wakeId?: string; status?: string }>;
  ledgerEntries?: Array<{ wakeId?: string }>;
}

export interface FinalizationAudit {
  valid: boolean;
  terminalLedgerBackedWakes: number;
  finalLedgerEntries: number;
  missingFromLedger: string[];
  extraInLedger: string[];
}

export function auditFinalization(input?: FinalizationAuditInput): FinalizationAudit;

export interface FinalizationTrustInput extends FinalizationAuditInput {
  integrityViolations?: unknown[];
}

export interface FinalizationTrust {
  trustworthy: boolean;
  audit: FinalizationAudit & { setEqual: boolean; integrityViolations: unknown[] };
}

export function finalizationTrust(input?: FinalizationTrustInput): FinalizationTrust;

export const LEDGER_BACKED_TERMINAL: Set<string>;

// Added for issue #253 so the risk-envelope regression spec can import
// `buildCampaignRiskEnvelope` under the root `tsc --noEmit`.
export interface CampaignRiskEnvelope {
  version: number;
  maxPositionPctOfEquity: number;
  maxSingleOrderPctOfEquity: number;
  maxDailyLossPct: number;
  maxDrawdownPct: number;
  scope: { kind: 'whitelist'; symbols: string[] };
  autonomyCeiling: string;
  revoked: boolean;
  revokedReason: string | null;
}

export function buildCampaignRiskEnvelope(
  codename: string,
  opts?: { maxDdPct?: number; maxPosPct?: number },
): CampaignRiskEnvelope;

// Added for issue #253 (review follow-up) so the regression spec can assert
// on the exact `POST /api/trading/config/uta` body run-cell.mjs sends,
// instead of only on `buildCampaignRiskEnvelope` in isolation.
export interface CampaignAccountCreatePayload {
  presetId: string;
  presetConfig: { cash: number };
  label: string;
  guards: Array<{ type: string; options: Record<string, unknown> }>;
  riskEnvelope: CampaignRiskEnvelope;
}

export function buildCampaignAccountCreatePayload(
  codename: string,
  runId: string,
  opts?: { maxDdPct?: number; maxPosPct?: number },
): CampaignAccountCreatePayload;

// Added for issue #256 so the keep-on-error regression spec can import
// `shouldCleanup` under the root `tsc --noEmit`.
export function shouldCleanup(input: { succeeded: boolean; keep: boolean }): boolean;

// Added for issue #259 (alice-lab experiment matrix runner) so
// `scripts/alice-lab.spec.ts` can import the pure decision-logic exports
// under the root `tsc --noEmit`.
export const DEFAULT_LAB_BASE_PORT: number;

export interface LabArm {
  id: string;
  agent: string;
  model: string;
  overlayDir?: string;
}

export interface LabExperimentConfig {
  name: string;
  weeks: number;
  rounds: number;
  cells: string[];
  arms: LabArm[];
  maxRuns: number;
  allowHoldout: boolean;
  basePort: number;
  totalRuns: number;
}

export function validateExperimentConfig(config: unknown): LabExperimentConfig;

export function generateRunId(name: string, armId: string, cell: string, round: number): string;

export interface LabPortBlock {
  web: number;
  mcp: number;
  uta: number;
  ui: number;
}

export function derivePortBlock(basePort?: number): LabPortBlock;

export interface LabRunResult {
  status: 'ok' | 'failed' | 'skipped';
}

export function deriveExitCode(runs: LabRunResult[]): number;
