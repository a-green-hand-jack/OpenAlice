/**
 * Issue #134 regression 3: the campaign harness must reject a finalization
 * whose per-week terminal ledger-backed statuses and final ledger entries
 * diverge — it may not write a trustworthy result that says "six done" while
 * exporting five decisions. The pure set-equality helper lives in the campaign
 * lib (orchestrator tooling, outside src/); this spec exercises it from an
 * included test directory so it runs under `pnpm test`.
 */
import { describe, expect, it } from 'vitest';

import { auditFinalization } from '../../../tools/campaigns/_lib.mjs';

describe('auditFinalization (issue #134)', () => {
  const week = (n: number, status: string) => ({ wakeId: `wake-${n}`, status });
  const ledger = (n: number) => ({ wakeId: `wake-${n}` });

  it('is valid when six terminal done wakes match six ledger entries', () => {
    const weeks = [1, 2, 3, 4, 5, 6].map((n) => week(n, 'done'));
    const ledgerEntries = [1, 2, 3, 4, 5, 6].map(ledger);
    const audit = auditFinalization({ weeks, ledgerEntries });
    expect(audit.valid).toBe(true);
    expect(audit.terminalLedgerBackedWakes).toBe(6);
    expect(audit.finalLedgerEntries).toBe(6);
  });

  it('rejects six terminal done wakes against five final ledger entries', () => {
    // The exact bug: week 1 completed done, but its ledger line was deleted and
    // never rebuilt, so only weeks 2-6 survive in the final ledger.
    const weeks = [1, 2, 3, 4, 5, 6].map((n) => week(n, 'done'));
    const ledgerEntries = [2, 3, 4, 5, 6].map(ledger);
    const audit = auditFinalization({ weeks, ledgerEntries });
    expect(audit.valid).toBe(false);
    expect(audit.terminalLedgerBackedWakes).toBe(6);
    expect(audit.finalLedgerEntries).toBe(5);
    expect(audit.missingFromLedger).toEqual(['wake-1']);
    expect(audit.extraInLedger).toEqual([]);
  });

  it('flags a ledger entry with no matching terminal ledger-backed wake', () => {
    const weeks = [1, 2].map((n) => week(n, 'done'));
    const ledgerEntries = [1, 2, 3].map(ledger);
    const audit = auditFinalization({ weeks, ledgerEntries });
    expect(audit.valid).toBe(false);
    expect(audit.extraInLedger).toEqual(['wake-3']);
  });

  it('excludes timeout/stuck weeks from the ledger-backed set (they need no entry)', () => {
    const weeks = [week(1, 'done'), week(2, 'timeout'), week(3, 'stuck')];
    const ledgerEntries = [ledger(1)];
    const audit = auditFinalization({ weeks, ledgerEntries });
    expect(audit.valid).toBe(true);
    expect(audit.terminalLedgerBackedWakes).toBe(1);
  });

  it('treats blocked and error as ledger-backed terminal statuses', () => {
    const weeks = [week(1, 'blocked'), week(2, 'error')];
    const audit = auditFinalization({ weeks, ledgerEntries: [ledger(1)] });
    expect(audit.valid).toBe(false);
    expect(audit.missingFromLedger).toEqual(['wake-2']);
  });
});
