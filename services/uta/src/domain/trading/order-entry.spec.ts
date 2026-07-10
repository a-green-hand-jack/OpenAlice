import { describe, it, expect, vi } from 'vitest'
import { executeOneShotOrder } from './order-entry.js'
import type { UnifiedTradingAccount } from './UnifiedTradingAccount.js'
import type { PushResult } from './git/types.js'

/**
 * Build a minimal UTA double covering only the methods the one-shot
 * pipeline touches: commit, push, reject. Returned alongside spies
 * the test can assert on.
 */
function makeFakeUta(overrides: {
  commit?: () => { hash: string }
  push?: (approver?: unknown, opts?: { expectedHash: string }) => Promise<PushResult>
  reject?: () => Promise<void>
} = {}) {
  const reject = overrides.reject ?? vi.fn(async () => {})
  const commit = overrides.commit ?? vi.fn(() => ({ hash: 'abcd1234' }))
  const push = overrides.push ?? vi.fn(async () => ({
    hash: 'abc', message: 'ok', operationCount: 0, submitted: [], rejected: [],
  } as unknown as PushResult))
  const uta = { commit, push, reject } as unknown as UnifiedTradingAccount
  return { uta, commit, push, reject }
}

describe('executeOneShotOrder', () => {
  it('runs all three phases on the happy path', async () => {
    const stage = vi.fn()
    const { uta, commit, push, reject } = makeFakeUta()

    const r = await executeOneShotOrder(uta, 'place AAPL 100 MKT', stage)

    expect(r.ok).toBe(true)
    if (r.ok) expect(r.result.hash).toBe('abc')
    expect(stage).toHaveBeenCalledTimes(1)
    expect(commit).toHaveBeenCalledWith('place AAPL 100 MKT')
    expect(push).toHaveBeenCalledTimes(1)
    expect(reject).not.toHaveBeenCalled()
  })

  it('binds push to the exact hash commit() prepared', async () => {
    const stage = vi.fn()
    const { uta, push } = makeFakeUta({
      commit: vi.fn(() => ({ hash: 'abcd1234' })),
    })

    await executeOneShotOrder(uta, 'place AAPL 100 MKT', stage)

    expect(push).toHaveBeenCalledWith(undefined, { expectedHash: 'abcd1234' })
  })

  it('returns stage error and skips commit + push', async () => {
    const stage = vi.fn(() => { throw new Error('guard tripped') })
    const { uta, commit, push } = makeFakeUta()

    const r = await executeOneShotOrder(uta, 'msg', stage)

    const err = new Error('guard tripped')
    expect(r).toEqual({ ok: false, phase: 'stage', error: 'guard tripped', cause: err })
    expect(commit).not.toHaveBeenCalled()
    expect(push).not.toHaveBeenCalled()
  })

  it('returns commit error AND triggers a rollback reject', async () => {
    const stage = vi.fn()
    const reject = vi.fn(async () => {})
    const commitErr = new Error('nothing staged')
    const { uta, push } = makeFakeUta({
      commit: vi.fn(() => { throw commitErr }),
      reject,
    })

    const r = await executeOneShotOrder(uta, 'msg', stage)

    expect(r).toEqual({ ok: false, phase: 'commit', error: 'nothing staged', cause: commitErr })
    expect(reject).toHaveBeenCalledTimes(1)
    expect(push).not.toHaveBeenCalled()
  })

  it('swallows reject errors during commit-failure rollback', async () => {
    const stage = vi.fn()
    const commitErr = new Error('commit broke')
    const { uta } = makeFakeUta({
      commit: vi.fn(() => { throw commitErr }),
      reject: vi.fn(async () => { throw new Error('reject also broke') }),
    })

    // Should still surface the original commit error, not the reject one.
    const r = await executeOneShotOrder(uta, 'msg', stage)
    expect(r).toEqual({ ok: false, phase: 'commit', error: 'commit broke', cause: commitErr })
  })

  it('returns push error', async () => {
    const stage = vi.fn()
    const pushErr = new Error('broker rejected')
    const { uta } = makeFakeUta({
      push: vi.fn(async () => { throw pushErr }),
    })

    const r = await executeOneShotOrder(uta, 'msg', stage)
    expect(r).toEqual({ ok: false, phase: 'push', error: 'broker rejected', cause: pushErr })
  })

  it('coerces non-Error throwables to a string error message', async () => {
    const stage = vi.fn(() => { throw 'plain string thrown' })
    const { uta } = makeFakeUta()

    const r = await executeOneShotOrder(uta, 'msg', stage)
    expect(r).toEqual({ ok: false, phase: 'stage', error: 'plain string thrown', cause: 'plain string thrown' })
  })
})
