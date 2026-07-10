import { createHash } from 'node:crypto';

import {
  STEWARD_LEDGER_RECEIPT_SCHEMA_VERSION,
  type StewardDecisionLedgerEntry,
  type StewardLedgerReceipt,
  type StewardLedgerStatus,
} from './types.js';

/**
 * Canonical-JSON fingerprinting for decision-ledger entries (issue #134).
 *
 * The ledger is a tamper-evidence surface: a wake that the supervisor already
 * drove to `done|blocked|error` must not be able to lose or silently mutate its
 * first-wins entry. We detect that by comparing a fingerprint captured at the
 * first terminal reconciliation (the receipt) against the entry on every later
 * tick.
 *
 * The fingerprint is over the CANONICAL form of the PARSED entry, not the raw
 * line: keys are recursively sorted and re-serialized. So a format-only rewrite
 * (whitespace, key reordering) round-trips to the same hash and never trips a
 * false tamper alarm (issue #134 requirement 7), while any semantic change
 * (a different decision/status/thesis/action) changes it. The exact same
 * canonicalization is re-implemented in the generated workspace validator
 * (`templates/steward/bootstrap.mjs`) so the two sides agree byte-for-byte —
 * keep them in lockstep if either changes.
 */
export function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      out[key] = canonicalizeJson(source[key]);
    }
    return out;
  }
  return value;
}

/** SHA-256 (hex) of the canonical JSON form of a parsed ledger entry. Accepts
 *  a raw `JSON.parse` result or a zod-parsed entry — canonicalization erases
 *  the difference for all fields the ledger actually carries. */
export function canonicalDecisionFingerprint(entry: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalizeJson(entry))).digest('hex');
}

/**
 * Build the immutable receipt for a first-wins ledger entry. `status` is the
 * terminal ledger status the supervisor is reconciling to; `fingerprint` is the
 * pre-computed {@link canonicalDecisionFingerprint} of that entry.
 */
export function buildLedgerReceipt(input: {
  readonly entry: StewardDecisionLedgerEntry;
  readonly status: StewardLedgerStatus;
  readonly fingerprint: string;
  readonly recordedAt: string;
  readonly bootstrapped?: boolean;
}): StewardLedgerReceipt {
  return {
    version: STEWARD_LEDGER_RECEIPT_SCHEMA_VERSION,
    wakeId: input.entry.wakeId,
    status: input.status,
    decision: input.entry.decision,
    at: input.entry.at,
    accountId: input.entry.accountId,
    fingerprint: input.fingerprint,
    recordedAt: input.recordedAt,
    ...(input.bootstrapped ? { bootstrapped: true } : {}),
  };
}
