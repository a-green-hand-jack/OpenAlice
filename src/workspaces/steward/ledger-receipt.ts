import { createHash } from 'node:crypto';

import {
  STEWARD_LEDGER_RECEIPT_SCHEMA_VERSION,
  type StewardDecisionLedgerEntry,
  type StewardLedgerReceipt,
  type StewardLedgerStatus,
} from './types.js';

/**
 * Canonical fingerprinting for decision-ledger entries (issue #134).
 *
 * Purpose and honest scope: this is **corruption-evident**, not tamper-proof.
 * The receipt, the wake record, and the ledger all live in the same
 * agent-writable workspace trust domain, so a determined writer could rewrite
 * all three consistently. What this DOES catch is accidental drift — the real
 * failure that motivated it: a persistent session deleting/rebuilding
 * `decisions.jsonl` and dropping an already-completed wake's entry. It flags a
 * completed decision that later disappears or changes, without a coordinated
 * rewrite.
 *
 * The fingerprint is over the CANONICAL SEMANTIC PROJECTION of the entry, not
 * the raw JSON line:
 *   - only the known ledger fields are hashed; unknown top-level passthrough
 *     keys are dropped, so a benign extra key never reads as a mutation;
 *   - keys are recursively sorted and re-serialized, so whitespace / key-order
 *     rewrites round-trip to the same hash (issue #134 requirement 7).
 * A semantic change (decision/status/thesis/actions/…) changes it.
 *
 * The projection + canonicalization is re-implemented byte-for-byte in the
 * generated workspace validator (`templates/steward/bootstrap.mjs`). A pinned
 * golden-vector SHA-256 is asserted by BOTH implementations (see
 * `ledger-receipt.spec.ts` and `bootstrap.spec.ts`) so they can never silently
 * diverge — keep all three in lockstep if the projection changes.
 */

/** The known top-level ledger fields, in the order the projection reads them.
 *  Unknown (passthrough) keys are intentionally excluded from the fingerprint.
 *  MUST stay identical to `LEDGER_SEMANTIC_KEYS` in the generated validator. */
export const LEDGER_SEMANTIC_KEYS = [
  'version',
  'wakeId',
  'at',
  'accountId',
  'decision',
  'status',
  'context',
  'completion',
  'checklist',
  'thesis',
  'actions',
  'pendingHash',
  'invalidation',
  'cost',
  'intent',
  'thesisDispositions',
] as const;

/** Recursively sort object keys so serialization is order-independent. Arrays
 *  keep their order (semantically significant); scalars pass through. */
export function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    // Disk JSON can carry an own "__proto__" key. A normal object assignment
    // would invoke Object.prototype's legacy setter and silently drop that key,
    // making two different raw intents hash identically. A null-prototype
    // object keeps every JSON key as ordinary enumerable data while preserving
    // the exact canonical JSON byte output for all existing values.
    const out = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(source).sort()) {
      out[key] = canonicalizeJson(source[key]);
    }
    return out;
  }
  return value;
}

/** Project a parsed ledger object onto its known semantic fields only (drops
 *  unknown top-level keys). Nested objects are kept whole (their content is
 *  semantic). */
export function semanticLedgerProjection(entry: unknown): Record<string, unknown> {
  const source = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of LEDGER_SEMANTIC_KEYS) {
    if (key in source) out[key] = source[key];
  }
  return out;
}

/** SHA-256 (hex) of the canonical semantic projection of a parsed ledger entry.
 *  Accepts a raw `JSON.parse` result or a typed entry — the projection erases
 *  the difference (unknown keys dropped, known keys hashed as-is). */
export function canonicalDecisionFingerprint(entry: unknown): string {
  const canonical = canonicalizeJson(semanticLedgerProjection(entry));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** SHA-256 of the raw Decision Intent after key-order-only canonicalization.
 *
 * Unlike {@link canonicalDecisionFingerprint}, this deliberately does not
 * project through a parsed schema. Every value present on disk is part of the
 * identity, including a forbidden/unknown field. That keeps the audit link
 * stable across sizing and Execution Record publication without normalizing a
 * malformed agent proposal into a different intent. */
export function canonicalIntentFingerprint(intent: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalizeJson(intent)))
    .digest('hex');
}

/**
 * Build the receipt for a first-wins ledger entry. `status` is the terminal
 * ledger status being reconciled; `fingerprint` is the pre-computed
 * {@link canonicalDecisionFingerprint} of that entry. `bootstrapped` marks a
 * receipt back-filled from a pre-#134 terminal wake's CURRENT entry — an honest
 * limitation: detection for that wake starts here, and the current entry is
 * trusted once (we never had the original).
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
