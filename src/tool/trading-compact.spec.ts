import { describe, it, expect } from 'vitest'
import Decimal from 'decimal.js'
import {
  val, money, price,
  compactContract, compactOrderFields, compactOperation,
  compactResult, compactStatus, compactCommit, compactAccountInfo,
  compactAutoPushResult,
} from './trading-compact.js'

describe('val — sentinel normalization', () => {
  it('drops every IBKR unset sentinel in every value form', () => {
    expect(val(1.7976931348623157e+308)).toBeUndefined()        // UNSET_DOUBLE number
    expect(val('1.7976931348623157e+308')).toBeUndefined()      // …as string
    expect(val(2147483647)).toBeUndefined()                     // UNSET_INTEGER
    expect(val('1.70141183460469231731687303715884105727e+38')).toBeUndefined() // UNSET_DECIMAL string
    expect(val(new Decimal('1.70141183460469231731687303715884105727e+38'))).toBeUndefined()
    expect(val('')).toBeUndefined()
    expect(val(null)).toBeUndefined()
    expect(val(undefined)).toBeUndefined()
  })

  it('keeps real values, including awkward ones', () => {
    expect(val('0.01')).toBe('0.01')
    expect(val(0)).toBe('0')
    expect(val(new Decimal('0.00000001'))).toBe('0.00000001')
    expect(val('DAY')).toBe('DAY')
  })
})

describe('money / price — display precision', () => {
  it('caps money at 2dp and price at 8dp without mangling', () => {
    expect(money('90273.826752780986')).toBe('90273.83')
    expect(money('150.48841053856901168')).toBe('150.49')
    expect(price('2165.8896354239932')).toBe('2165.88963542')
    expect(price('0.00000001')).toBe('0.00000001')
  })
})

describe('compactContract', () => {
  it('keeps instrument identity, drops sentinels/empties, normalizes right', () => {
    const c = compactContract({
      conId: 0, symbol: 'AAPL', secType: 'OPT', lastTradeDateOrContractMonth: '20260717',
      lastTradeDate: '', strike: 300, right: 'CALL', multiplier: '100', exchange: 'SMART',
      primaryExchange: '', currency: 'USD', localSymbol: 'AAPL 260717C00300000',
      tradingClass: '', includeExpired: false, secIdType: '', comboLegs: [],
      deltaNeutralContract: null, aliceId: 'ibkr|x',
    })
    expect(c).toEqual({
      aliceId: 'ibkr|x', symbol: 'AAPL', localSymbol: 'AAPL 260717C00300000',
      secType: 'OPT', currency: 'USD', exchange: 'SMART',
      expiry: '20260717', strike: '300', right: 'C', multiplier: '100',
    })
  })

  it('omits multiplier when it is 1 (canonical, carries no signal)', () => {
    expect(compactContract({ symbol: 'ETH', multiplier: '1' })).toEqual({ symbol: 'ETH' })
  })
})

describe('compactOrderFields', () => {
  it('reduces the ~120-field Order to its set fields', () => {
    const o = compactOrderFields({
      action: 'BUY', orderType: 'LMT', totalQuantity: '0.01', lmtPrice: '1200',
      auxPrice: '1.70141183460469231731687303715884105727e+38',
      trailingPercent: '1.70141183460469231731687303715884105727e+38',
      minQty: 2147483647, percentOffset: 1.7976931348623157e+308,
      tif: 'DAY', outsideRth: false, softDollarTier: { name: '' },
      filledQuantity: '1.70141183460469231731687303715884105727e+38',
    })
    expect(o).toEqual({ action: 'BUY', orderType: 'LMT', totalQuantity: '0.01', lmtPrice: '1200', tif: 'DAY' })
  })
})

describe('compactOperation / compactStatus / compactResult', () => {
  it('placeOrder operation has no sentinel anywhere in its JSON', () => {
    const op = compactOperation({
      action: 'placeOrder',
      contract: { symbol: 'ETH', strike: 1.7976931348623157e+308, conId: 0 },
      order: { action: 'BUY', totalQuantity: '0.01', minQty: 2147483647 },
    })
    const json = JSON.stringify(op)
    expect(json).not.toMatch(/1\.797693|1\.7014118|2147483647/)
    expect(op).toEqual({ action: 'placeOrder', contract: { symbol: 'ETH' }, order: { action: 'BUY', totalQuantity: '0.01' } })
  })

  it('compactResult drops raw + orderState but keeps the reject reason', () => {
    const r = compactResult({
      action: 'placeOrder', success: false, status: 'rejected', error: 'price band',
      raw: { huge: 'payload' },
      orderState: { status: 'Inactive', rejectReason: 'okx 51138', commissionAndFees: 1.7976931348623157e+308 },
    })
    expect(r).toEqual({ action: 'placeOrder', success: false, status: 'rejected', error: 'price band', rejectReason: 'okx 51138' })
  })

  it('compactResult surfaces bracket leg ids (agent confirmation that protective legs exist)', () => {
    const r = compactResult({
      action: 'placeOrder', success: true, status: 'submitted', orderId: 'parent-1',
      legs: [{ orderId: 'tp-1', kind: 'takeProfit' }, { orderId: 'sl-1', kind: 'stopLoss' }],
      raw: { huge: 'payload' },
    })
    expect(r['legs']).toEqual([
      { orderId: 'tp-1', kind: 'takeProfit' },
      { orderId: 'sl-1', kind: 'stopLoss' },
    ])
    expect('raw' in r).toBe(false)
  })

  it('compactResult never emits a receipt object — execution pass-through was removed', () => {
    // Boundary regression: compactResult's own doc comment says "Deliberately
    // NO venue receipt pass-through" — a hostile/legacy `execution` block
    // (with account numbers and other venue-identifying fields) must not
    // resurrect a `receipt` key or leak any of its contents.
    const r = compactResult({
      action: 'placeOrder', success: true, status: 'filled',
      execution: {
        execId: 'exec-1', time: '2026-07-10T00:00:00Z', orderId: 42,
        permId: 99, clientId: 7, orderRef: 'request-7', exchange: 'NASDAQ',
        side: 'BOT', cumQty: '1.5', lastLiquidity: 2,
        acctNumber: 'SECRET-ACCT', modelCode: 'SECRET-MODEL', submitter: 'SECRET-USER',
      },
    })

    expect('receipt' in r).toBe(false)
    expect(r).toEqual({ action: 'placeOrder', success: true, status: 'filled' })
    const json = JSON.stringify(r)
    expect(json).not.toContain('SECRET')
    expect(json).not.toMatch(/execId|permId|acctNumber/)
  })

  it('compactStatus compacts staged ops and renames pending→awaitingApproval', () => {
    const idle = compactStatus({
      staged: [{ action: 'cancelOrder', orderId: 'o1' }],
      pendingMessage: null, pendingHash: null, head: 'abc', commitCount: 5,
    })
    expect(idle).toEqual({ staged: [{ action: 'cancelOrder', orderId: 'o1' }], awaitingApproval: null, head: 'abc', commitCount: 5 })

    const committed = compactStatus({
      staged: [], pendingMessage: 'long ETH', pendingHash: 'h1', head: 'abc', commitCount: 5,
    })
    expect(committed.awaitingApproval).toEqual({ message: 'long ETH', hash: 'h1' })
  })

  it('TRADING-AGENT BOUNDARY: compactStatus never exposes mutation recovery internals to the agent', () => {
    // Mutation recovery is human-only (see compactMutationStatus's doc
    // comment). No matter what the persisted/durable mutation envelope
    // contains — activeAttempt, operations, resolutions, evidence, receipts,
    // approver fingerprints — the compacted `mutation` block must be exactly
    // the fixed four-scalar-plus-recovery-string shape. This regression
    // feeds a full hostile payload and asserts by JSON scan that none of the
    // forbidden markers (or secret-looking strings) survive.
    const compacted = compactStatus({
      staged: [], pendingMessage: null, pendingHash: null, head: 'abc', commitCount: 5,
      mutation: {
        schemaVersion: 1,
        readiness: 'recovery_required',
        restartRequired: true,
        downgradeBlocked: true,
        activeAttempt: {
          attemptId: 'attempt-1', kind: 'push', hash: 'deadbeef', message: 'buy AAPL',
          approver: { via: 'alice-bff', fingerprint: 'SECRET-FINGERPRINT-abc', at: '2026-07-10T00:00:00.000Z' },
          createdAt: '2026-07-10T00:00:00.000Z', updatedAt: '2026-07-10T00:00:01.000Z',
          operations: [{
            operationId: 'attempt-1:0', index: 0, action: 'placeOrder', symbol: 'AAPL',
            operation: {
              action: 'placeOrder', symbol: 'AAPL', aliceId: 'paper|AAPL',
              side: 'BUY', orderType: 'MKT', quantity: '1', stopLossPrice: '90',
            },
            state: 'uncertain', error: 'broker acceptance unknown',
            result: {
              success: false, status: 'uncertain', error: 'broker acceptance unknown',
              receipt: { executionId: 'exec-1', brokerOrderId: '42' },
            },
            evidence: { type: 'recovered-dispatching' },
            rawEvidence: { rawBrokerPayload: 'must not cross compact boundary', apiKey: 'sk-SECRET-KEY' },
          }],
          resolutions: [{
            action: 'acknowledge-uncertainty', reason: 'checked venue',
            approver: { via: 'alice-bff', fingerprint: 'SECRET-FINGERPRINT-abc', at: '2026-07-10T00:01:00.000Z' },
            at: '2026-07-10T00:01:00.000Z',
          }],
          suspendedApproval: { message: 'hidden legacy field' },
        },
      },
    })

    expect(compacted.mutation).toEqual({
      schemaVersion: 1,
      readiness: 'recovery_required',
      restartRequired: true,
      downgradeBlocked: true,
      recovery: 'Human-only: a person must resolve this on the account detail page or the authenticated recovery API. There is no agent tool for it.',
    })

    const json = JSON.stringify(compacted)
    for (const marker of [
      'activeAttempt', 'operationId', 'resolutions', 'evidence', 'fingerprint',
      'mutationAudit', 'receipt', 'execId', 'attemptId',
    ]) {
      expect(json).not.toContain(marker)
    }
    expect(json).not.toContain('SECRET-FINGERPRINT-abc')
    expect(json).not.toContain('sk-SECRET-KEY')
  })
})

describe('compactCommit', () => {
  it('TRADING-AGENT BOUNDARY: never projects mutationAudit — attempt ids, initiators, and resolution history are human/recovery material', () => {
    // Boundary regression: compactCommit's doc comment says "Deliberately NO
    // mutationAudit projection". A full hostile mutationAudit block —
    // initiator fingerprints, resolution approver fingerprints, raw tokens,
    // raw broker payloads — must be dropped entirely, not sanitized-and-kept.
    const compacted = compactCommit({
      hash: 'deadbeef', parentHash: null, message: 'resolved mutation',
      timestamp: '2026-07-10T00:00:00.000Z', operations: [], results: [],
      stateAfter: {
        netLiquidation: '100', totalCashValue: '100', unrealizedPnL: '0', realizedPnL: '0',
        positions: [], pendingOrders: [],
      },
      mutationAudit: {
        schemaVersion: 1, attemptId: 'attempt-1', kind: 'push', message: 'buy AAPL',
        operationCount: 1,
        initiator: { via: 'alice-bff', fingerprint: 'SECRET-FINGERPRINT-abc', at: '2026-07-10T00:00:00.000Z', rawToken: 'sk-SECRET-KEY' },
        context: { reason: 'operator request', raw: 'drop' },
        resolutions: [{
          action: 'acknowledge-uncertainty', reason: 'checked venue',
          approver: { via: 'alice-bff', fingerprint: 'SECRET-FINGERPRINT-abc', at: '2026-07-10T00:01:00.000Z', rawToken: 'sk-SECRET-KEY' },
          at: '2026-07-10T00:01:00.000Z', rawEvidence: 'drop',
        }],
        rawBrokerPayload: 'drop',
      },
    })

    expect('mutationAudit' in compacted).toBe(false)
    const json = JSON.stringify(compacted)
    for (const marker of [
      'mutationAudit', 'attemptId', 'fingerprint', 'resolutions', 'initiator', 'rawToken', 'rawBrokerPayload',
    ]) {
      expect(json).not.toContain(marker)
    }
    expect(json).not.toContain('SECRET-FINGERPRINT-abc')
    expect(json).not.toContain('sk-SECRET-KEY')
  })
})

describe('compactAccountInfo', () => {
  it('rounds money to 2dp and omits unreported fields (never fabricates zeros)', () => {
    const a = compactAccountInfo({
      baseCurrency: 'USD', netLiquidation: '90273.826752780986',
      totalCashValue: '81351.50743564543', unrealizedPnL: '150.48841053856901168',
      realizedPnL: '-0.3654613868044494', initMarginReq: '1.11583333333',
    })
    expect(a).toEqual({
      baseCurrency: 'USD', netLiquidation: '90273.83', totalCashValue: '81351.51',
      unrealizedPnL: '150.49', realizedPnL: '-0.37', initMarginReq: '1.12',
    })
    expect('buyingPower' in a).toBe(false)
  })
})

describe('compactAutoPushResult', () => {
  it('TRADING-AGENT BOUNDARY: never projects a mutation block, even when the raw result carries one', () => {
    // compactAutoPushResult only ever picks a fixed allowlist of scalar keys
    // off the raw PaperAutoPushResult; a hostile/legacy payload smuggling a
    // `mutation` or `mutationAudit` object alongside the known fields must
    // not survive compaction.
    const compacted = compactAutoPushResult({
      status: 'pushed', hash: 'bbbb2222',
      push: {
        hash: 'bbbb2222', message: 'buy AAPL', operationCount: 1,
        submitted: [{ action: 'placeOrder', success: true, status: 'filled', filledQty: '1', filledPrice: '150' }],
        rejected: [],
      },
      effectiveAuthzLevel: 'paper',
      mutation: {
        schemaVersion: 1, readiness: 'recovery_required', downgradeBlocked: true,
        activeAttempt: {
          attemptId: 'attempt-1', kind: 'push', hash: 'deadbeef', message: 'buy AAPL',
          approver: { via: 'alice-bff', fingerprint: 'SECRET-FINGERPRINT-abc', at: '2026-07-10T00:00:00.000Z' },
          createdAt: '2026-07-10T00:00:00.000Z', updatedAt: '2026-07-10T00:00:01.000Z',
          operations: [],
        },
      },
      mutationAudit: {
        schemaVersion: 1, attemptId: 'attempt-1', kind: 'push', message: 'buy AAPL', operationCount: 1,
        initiator: { via: 'alice-bff', fingerprint: 'SECRET-FINGERPRINT-abc', at: '2026-07-10T00:00:00.000Z' },
        resolutions: [],
      },
    })

    expect('mutation' in compacted).toBe(false)
    expect('mutationAudit' in compacted).toBe(false)
    const json = JSON.stringify(compacted)
    for (const marker of [
      'activeAttempt', 'operationId', 'resolutions', 'evidence', 'fingerprint',
      'mutationAudit', 'execId', 'attemptId',
    ]) {
      expect(json).not.toContain(marker)
    }
    expect(json).not.toContain('SECRET-FINGERPRINT-abc')
  })
})
