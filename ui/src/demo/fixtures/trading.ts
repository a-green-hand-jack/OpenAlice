import type {
  TradingAccount,
  UTASummary,
  AccountInfo,
  Position,
  UTAConfig,
  EquityCurvePoint,
  UTASnapshotSummary,
} from '../../api/types'

export const DEMO_UTA_ID = 'demo-uta'           // alias kept for back-compat
export const DEMO_UTA_PAPER = 'demo-paper'
export const DEMO_UTA_IBKR = 'demo-ibkr'
export const DEMO_UTA_CRYPTO = 'demo-crypto'

// ==================== UTA listing ====================

export const demoTradingAccounts: TradingAccount[] = [
  { id: DEMO_UTA_PAPER, provider: 'alpaca', label: 'Alpaca Paper' },
  { id: DEMO_UTA_IBKR, provider: 'ibkr', label: 'IBKR Demo' },
  { id: DEMO_UTA_CRYPTO, provider: 'ccxt', label: 'Binance Spot' },
]

const healthOk = {
  status: 'healthy' as const,
  reach: 'readable' as const,
  tier: 'trading' as const,
  consecutiveFailures: 0,
  lastSuccessAt: new Date().toISOString(),
  recovering: false,
  disabled: false,
}

export const demoUTASummaries: UTASummary[] = [
  {
    id: DEMO_UTA_PAPER,
    label: 'Alpaca Paper',
    capabilities: { supportedSecTypes: ['STK'], supportedOrderTypes: ['MKT', 'LMT'] },
    health: healthOk,
  },
  {
    id: DEMO_UTA_IBKR,
    label: 'IBKR Demo',
    capabilities: { supportedSecTypes: ['STK', 'OPT'], supportedOrderTypes: ['MKT', 'LMT', 'STP'] },
    health: healthOk,
  },
  {
    id: DEMO_UTA_CRYPTO,
    label: 'Binance Spot',
    capabilities: { supportedSecTypes: ['CRYPTO'], supportedOrderTypes: ['MKT', 'LMT'] },
    health: healthOk,
  },
]

// Back-compat singleton (PR-1 wired this name into other handlers).
export const demoTradingAccount: TradingAccount = demoTradingAccounts[0]
export const demoUTASummary: UTASummary = demoUTASummaries[0]

// ==================== Per-UTA account info ====================

export const demoAccountByUTA: Record<string, AccountInfo> = {
  [DEMO_UTA_PAPER]: {
    baseCurrency: 'USD',
    netLiquidation: '52840.13',
    totalCashValue: '8120.55',
    unrealizedPnL: '1924.58',
    realizedPnL: '380.00',
    buyingPower: '16241.10',
  },
  [DEMO_UTA_IBKR]: {
    baseCurrency: 'USD',
    netLiquidation: '247310.40',
    totalCashValue: '142880.00',
    unrealizedPnL: '-1430.50',
    realizedPnL: '12120.30',
    buyingPower: '285760.00',
    initMarginReq: '12450.00',
    maintMarginReq: '8200.00',
  },
  [DEMO_UTA_CRYPTO]: {
    baseCurrency: 'USDT',
    netLiquidation: '15032.18',
    totalCashValue: '3104.20',
    unrealizedPnL: '482.66',
    realizedPnL: '-128.40',
  },
}

// Back-compat singleton.
export const demoAccountInfo: AccountInfo = demoAccountByUTA[DEMO_UTA_PAPER]

// ==================== Positions ====================

function pos(o: {
  symbol: string
  secType?: string
  currency?: string
  side?: 'long' | 'short'
  qty: string
  avgCost: string
  marketPrice: string
}): Position {
  const qty = Number(o.qty)
  const avgCost = Number(o.avgCost)
  const px = Number(o.marketPrice)
  const mv = qty * px
  const unreal = qty * (px - avgCost)
  return {
    contract: {
      symbol: o.symbol,
      secType: o.secType ?? 'STK',
      currency: o.currency ?? 'USD',
      exchange: 'SMART',
    },
    currency: o.currency ?? 'USD',
    side: o.side ?? 'long',
    quantity: o.qty,
    avgCost: o.avgCost,
    marketPrice: o.marketPrice,
    marketValue: mv.toFixed(2),
    unrealizedPnL: unreal.toFixed(2),
    realizedPnL: '0.00',
  }
}

export const demoPositionsByUTA: Record<string, Position[]> = {
  [DEMO_UTA_PAPER]: [
    pos({ symbol: 'AAPL', qty: '120', avgCost: '178.40', marketPrice: '191.25' }),
    pos({ symbol: 'NVDA', qty: '35', avgCost: '612.10', marketPrice: '630.80' }),
    pos({ symbol: 'GOOG', qty: '40', avgCost: '162.00', marketPrice: '158.30' }),
    pos({ symbol: 'AMD', qty: '80', avgCost: '142.50', marketPrice: '144.10' }),
  ],
  [DEMO_UTA_IBKR]: [
    pos({ symbol: 'SPY', qty: '500', avgCost: '512.80', marketPrice: '516.20' }),
    pos({ symbol: 'QQQ', qty: '200', avgCost: '438.00', marketPrice: '441.55' }),
    pos({ symbol: 'AAPL', secType: 'OPT', qty: '20', avgCost: '8.40', marketPrice: '7.10' }),
    pos({ symbol: 'TLT', qty: '300', avgCost: '92.50', marketPrice: '90.80' }),
  ],
  [DEMO_UTA_CRYPTO]: [
    pos({ symbol: 'BTC/USDT', secType: 'CRYPTO', currency: 'USDT', qty: '0.18', avgCost: '64200.00', marketPrice: '66480.00' }),
    pos({ symbol: 'ETH/USDT', secType: 'CRYPTO', currency: 'USDT', qty: '1.5', avgCost: '3340.00', marketPrice: '3402.00' }),
  ],
}

// ==================== Equity curves ====================

// Reproducible-pseudo-random walk so the chart looks plausibly alive without
// being random-on-each-load (visitors would see different numbers each refresh).
function seededRandom(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0xffffffff
  }
}

function generateCurve(startEquity: number, days: number, vol: number, drift: number, seed: number): EquityCurvePoint[] {
  const rand = seededRandom(seed)
  const dayMs = 86_400_000
  const now = Date.now()
  const points: EquityCurvePoint[] = []
  let equity = startEquity
  for (let i = days - 1; i >= 0; i--) {
    const r = (rand() - 0.5) * 2
    equity = equity * (1 + drift + r * vol)
    points.push({
      timestamp: new Date(now - i * dayMs).toISOString(),
      equity: equity.toFixed(2),
      accounts: {},
    })
  }
  return points
}

const PAPER_CURVE = generateCurve(50_000, 30, 0.012, 0.0008, 0x11a2b3)
const IBKR_CURVE = generateCurve(240_000, 30, 0.008, 0.0004, 0x29ef41)
const CRYPTO_CURVE = generateCurve(14_500, 30, 0.025, 0.0012, 0x53bd99)

export const demoEquityCurve: EquityCurvePoint[] = (() => {
  // Combined view: sum each day across UTAs.
  const out: EquityCurvePoint[] = []
  for (let i = 0; i < PAPER_CURVE.length; i++) {
    const total =
      Number(PAPER_CURVE[i].equity) + Number(IBKR_CURVE[i].equity) + Number(CRYPTO_CURVE[i].equity)
    out.push({
      timestamp: PAPER_CURVE[i].timestamp,
      equity: total.toFixed(2),
      accounts: {
        [DEMO_UTA_PAPER]: PAPER_CURVE[i].equity,
        [DEMO_UTA_IBKR]: IBKR_CURVE[i].equity,
        [DEMO_UTA_CRYPTO]: CRYPTO_CURVE[i].equity,
      },
    })
  }
  return out
})()

export const demoEquityCurveByUTA: Record<string, EquityCurvePoint[]> = {
  [DEMO_UTA_PAPER]: PAPER_CURVE,
  [DEMO_UTA_IBKR]: IBKR_CURVE,
  [DEMO_UTA_CRYPTO]: CRYPTO_CURVE,
}

// ==================== Snapshots ====================

export const demoSnapshotsByUTA: Record<string, UTASnapshotSummary[]> = Object.fromEntries(
  demoTradingAccounts.map((a) => [
    a.id,
    demoEquityCurveByUTA[a.id]!.slice(-5).map((p) => ({
      accountId: a.id,
      timestamp: p.timestamp,
      trigger: 'daily',
      account: {
        baseCurrency: demoAccountByUTA[a.id]!.baseCurrency,
        netLiquidation: p.equity,
        totalCashValue: demoAccountByUTA[a.id]!.totalCashValue,
        unrealizedPnL: demoAccountByUTA[a.id]!.unrealizedPnL,
        realizedPnL: demoAccountByUTA[a.id]!.realizedPnL,
      },
      positions: (demoPositionsByUTA[a.id] ?? []).map((p) => ({
        aliceId: p.contract.symbol ?? 'unknown',
        currency: p.currency,
        side: p.side,
        quantity: p.quantity,
        avgCost: p.avgCost,
        marketPrice: p.marketPrice,
        marketValue: p.marketValue,
        unrealizedPnL: p.unrealizedPnL,
        realizedPnL: p.realizedPnL,
      })),
      openOrders: [],
      health: 'healthy',
    })),
  ]),
)

// ==================== UTA configs ====================

export const demoUTAConfigs: UTAConfig[] = [
  { id: DEMO_UTA_PAPER, label: 'Alpaca Paper', presetId: 'alpaca-paper', enabled: true, guards: [], presetConfig: {} },
  { id: DEMO_UTA_IBKR, label: 'IBKR Demo', presetId: 'ibkr', enabled: true, guards: [], presetConfig: {} },
  { id: DEMO_UTA_CRYPTO, label: 'Binance Spot', presetId: 'ccxt', enabled: true, guards: [], presetConfig: {} },
]
export const demoUTAConfig: UTAConfig = demoUTAConfigs[0]
