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
