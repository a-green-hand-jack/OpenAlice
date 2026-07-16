import { describe, expect, it } from 'vitest'

import { shouldCleanup } from '../tools/campaigns/_lib.mjs'

/**
 * Regression spec for issue #256: `tools/campaigns/run-cell.mjs` cleaned up
 * the workspace + mock account it created in a finally block regardless of
 * whether the run succeeded or aborted on a thrown error (e.g. a mid-run 500
 * on a wake POST). That destroyed the workspace's ledger/wakes/supervisor
 * evidence needed for root-cause analysis of the failure. `shouldCleanup`
 * is the pure decision the restructured finally block now consults.
 */
describe('run-cell.mjs shouldCleanup (issue #256)', () => {
  it('cleans up after a successful run without --keep', () => {
    expect(shouldCleanup({ succeeded: true, keep: false })).toBe(true)
  })

  it('keeps a successful run when --keep was passed', () => {
    expect(shouldCleanup({ succeeded: true, keep: true })).toBe(false)
  })

  it('keeps a failed run for forensics even without --keep', () => {
    expect(shouldCleanup({ succeeded: false, keep: false })).toBe(false)
  })

  it('keeps a failed run for forensics when --keep was also passed', () => {
    expect(shouldCleanup({ succeeded: false, keep: true })).toBe(false)
  })
})
