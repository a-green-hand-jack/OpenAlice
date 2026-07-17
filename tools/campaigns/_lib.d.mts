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

export interface EntrustedUnitMandate {
  version: 1;
  mandateId: string;
  entrustedUnitId: string;
  parentMandateId: null;
  accountId: string;
  capital: { currency: string; limit: string };
  scope: { kind: 'instrument_whitelist'; instruments: string[] };
  validFrom: string;
  validUntil: string;
  heartbeat: { intervalMs: number; graceMs: number };
  riskEnvelope: CampaignRiskEnvelope;
}

export function buildCampaignMandate(input: Omit<EntrustedUnitMandate, 'version' | 'parentMandateId' | 'scope'> & { scope: string[] }): EntrustedUnitMandate;

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

// Added for issue #261 so the leading-`--` argv-tolerance regression spec
// can import `parseLabArgs` under the root `tsc --noEmit`.
export function parseLabArgs(argv: string[]): { configPath: string };

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
  dispatch: 'direct' | 'scheduled';
  mandate: {
    id: string;
    entrustedUnitId: string;
    capital: { currency: string; limit: string };
    validForMs: number;
    heartbeat: { intervalMs: number; graceMs: number };
  } | null;
  restartAfterWake: number | null;
  totalRuns: number;
}

export function validateExperimentConfig(config: unknown): LabExperimentConfig;

export function runCellDispatchArgs(dispatch?: 'direct' | 'scheduled'): string[];
export function utaChecklistVerified(weeks: Array<{ checklist?: Record<string, unknown> | null }>): boolean;
export function wakeEnvelopeIdentity(wake: unknown): {
  mandateId: string | null;
  entrustedUnitId: string | null;
};
export function wakeEnvelopeIdentityVerified(
  wake: unknown,
  expectedMandate: { mandateId?: unknown; entrustedUnitId?: unknown } | null | undefined,
): boolean;

export interface ScheduledStewardIssueInput {
  issueId: string;
  at: string;
  accountId: string;
  deadlineMs: number;
  agent: string;
  marketContext: Record<string, unknown>;
  riskContext: Record<string, unknown>;
  mandate: EntrustedUnitMandate;
}

export function buildScheduledStewardIssue(input: ScheduledStewardIssueInput): string;

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

// Added for issue #259 review follow-up (CRITICAL/HIGH/LOW fixes) so
// `scripts/alice-lab.spec.ts` can import the stack-teardown / boot-race
// decision helpers under the root `tsc --noEmit`.
export function isPortFreeError(err: unknown): boolean;

export interface LabTeardownOutcomeInput {
  armId: string;
  port: number;
  freed: boolean;
  timeoutMs: number;
}

export type LabTeardownOutcome = { ok: true } | { ok: false; reason: string };

export function deriveTeardownOutcome(input: LabTeardownOutcomeInput): LabTeardownOutcome;

export interface LabBootOutcomeInput {
  ready: boolean;
  exited: boolean;
  exitCode?: number | null;
  exitSignal?: string | null;
  timeoutMs: number;
}

export type LabBootOutcome =
  | { ok: true }
  | { ok: false; status: 'exited' | 'timeout'; reason: string };

export function deriveBootOutcome(input: LabBootOutcomeInput): LabBootOutcome;

export function lastLogLines(text: string, n?: number): string;
