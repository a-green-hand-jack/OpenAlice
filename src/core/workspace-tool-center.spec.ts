import type { Tool } from 'ai'
import { describe, expect, it } from 'vitest'

import {
  PROPOSAL_TRADING_TOOL_NAMES,
  READ_ONLY_TRADING_TOOL_NAMES,
  REMOVED_TRADING_TOOL_NAMES,
  OPENALICE_EFFECTIVE_AUTHZ_BY_ACCOUNT_ARG,
  buildWorkspaceToolCatalog,
  checkTradingProposalAuthz,
  makeWorkspaceResolver,
  resolveWorkspaceToolAuthzLevel,
  sealBlindWorkspaceToolCatalog,
  wrapTradingProposalToolsWithAuthz,
} from './workspace-tool-center.js'
import type { AuthzLevel } from '@traderalice/uta-protocol'

type Meta = { id: string; dir: string; tag: string }

const NON_TRADING_TOOL_NAMES = [
  'inbox_push',
  'inbox_read',
  'issue_create',
  'entity_search',
  'workspace_path',
  'marketSearchForResearch',
] as const

function fakeCatalog(): Record<string, Tool> {
  const names = [
    ...READ_ONLY_TRADING_TOOL_NAMES,
    ...PROPOSAL_TRADING_TOOL_NAMES,
    ...REMOVED_TRADING_TOOL_NAMES,
    ...NON_TRADING_TOOL_NAMES,
    'newUnmappedTradingTool',
  ]
  return Object.fromEntries(names.map((name) => [name, { description: name } as Tool]))
}

function groupForTool(name: string): string | null {
  if (
    (READ_ONLY_TRADING_TOOL_NAMES as readonly string[]).includes(name) ||
    (PROPOSAL_TRADING_TOOL_NAMES as readonly string[]).includes(name) ||
    (REMOVED_TRADING_TOOL_NAMES as readonly string[]).includes(name) ||
    name === 'newUnmappedTradingTool'
  ) {
    return 'trading'
  }
  return 'research'
}

function namesFor(authzLevel: AuthzLevel): string[] {
  return Object.keys(buildWorkspaceToolCatalog(
    fakeCatalog(),
    {
      inbox_push: { description: 'scoped inbox push' } as Tool,
      workspace_path: { description: 'scoped path resolver' } as Tool,
    },
    { authzLevel, groupForTool },
  )).sort()
}

function svc(map: Record<string, Meta>) {
  return { registry: { get: (id: string): Meta | undefined => map[id] } }
}

describe('workspace tool surface authz filtering', () => {
  it('defaults missing account/workspace configuration to read_only', () => {
    expect(resolveWorkspaceToolAuthzLevel({})).toBe('read_only')
  })

  it('uses the account ceiling to cap a higher workspace authz level', () => {
    expect(resolveWorkspaceToolAuthzLevel({
      accountMaxAuthzLevels: ['paper'],
      workspaceAuthzLevel: 'limited_autonomy',
    })).toBe('paper')
  })

  it('gives two workspaces with different effective levels different catalogs', () => {
    const readOnly = namesFor(resolveWorkspaceToolAuthzLevel({
      accountMaxAuthzLevels: ['paper'],
      workspaceAuthzLevel: 'read_only',
    }))
    const paper = namesFor(resolveWorkspaceToolAuthzLevel({
      accountMaxAuthzLevels: ['paper'],
      workspaceAuthzLevel: 'paper',
    }))

    expect(readOnly).not.toEqual(paper)
    expect(readOnly).not.toContain('placeOrder')
    expect(readOnly).not.toContain('tradingCommit')
    expect(paper).toContain('placeOrder')
    expect(paper).toContain('tradingCommit')
    expect(readOnly).not.toContain('tradingPush')
    expect(paper).not.toContain('tradingPush')
  })

  it('matches the approved read_only tool map exactly', () => {
    expect(namesFor('read_only')).toEqual([
      ...READ_ONLY_TRADING_TOOL_NAMES,
      ...NON_TRADING_TOOL_NAMES,
    ].sort())
  })

  it.each(['paper', 'small_live', 'limited_autonomy'] as const)(
    'matches the approved %s tool map exactly',
    (authzLevel) => {
      expect(namesFor(authzLevel)).toEqual([
        ...READ_ONLY_TRADING_TOOL_NAMES,
        ...PROPOSAL_TRADING_TOOL_NAMES,
        ...NON_TRADING_TOOL_NAMES,
      ].sort())
    },
  )
})

describe('blind workspace market-data seal', () => {
  const marketGroupForTool = (name: string): string | null => ({
    calculateIndicator: 'analysis',
    calculateQuant: 'quant',
    marketSearchForResearch: 'market-search',
    marketGetBoard: 'market-board',
    equityGetProfile: 'equity',
    economyFredSearch: 'economy',
    indexSearch: 'indices',
    sectorRotation: 'sector-rotation',
    cryptoOptionsChains: 'derivatives',
    etfSearch: 'etf',
    grepRss: 'rss',
    bars: 'quant',
    searchBars: 'quant',
    calculate: 'thinking',
  } as Record<string, string | undefined>)[name] ?? null

  const executable = (name: string, fn: (args: unknown) => unknown = async () => ({ ok: true })) => ({
    description: name,
    execute: fn,
  }) as unknown as Tool

  it('leaves a non-blind catalog unchanged', () => {
    const global = {
      bars: executable('bars'),
      calculateQuant: executable('calculateQuant'),
      marketSearchForResearch: executable('marketSearchForResearch'),
      calculate: executable('calculate'),
    }
    const normal = buildWorkspaceToolCatalog(global, {}, {
      authzLevel: 'read_only',
      groupForTool: marketGroupForTool,
    })
    const nonBlind = buildWorkspaceToolCatalog(global, {}, {
      authzLevel: 'read_only',
      groupForTool: marketGroupForTool,
      blind: { blind: false, blindAllowBarSources: ['mock-paper'] },
    })

    expect(Object.keys(nonBlind).sort()).toEqual(Object.keys(normal).sort())
    expect(nonBlind.bars).toBe(normal.bars)
    expect(nonBlind.calculateQuant).toBe(normal.calculateQuant)
  })

  it('drops real-market tools while keeping trading, thinking, scoped, and explicit barId tools', () => {
    const sealed = buildWorkspaceToolCatalog(
      {
        calculateIndicator: executable('calculateIndicator'),
        calculateQuant: executable('calculateQuant'),
        marketSearchForResearch: executable('marketSearchForResearch'),
        marketGetBoard: executable('marketGetBoard'),
        equityGetProfile: executable('equityGetProfile'),
        economyFredSearch: executable('economyFredSearch'),
        indexSearch: executable('indexSearch'),
        sectorRotation: executable('sectorRotation'),
        cryptoOptionsChains: executable('cryptoOptionsChains'),
        etfSearch: executable('etfSearch'),
        grepRss: executable('grepRss'),
        bars: executable('bars'),
        searchBars: executable('searchBars'),
        calculate: executable('calculate'),
        getAccount: executable('getAccount'),
        searchContracts: executable('searchContracts'),
        getQuote: executable('getQuote'),
      },
      { inbox_push: executable('inbox_push'), workspace_path: executable('workspace_path') },
      {
        authzLevel: 'read_only',
        groupForTool: (name) => ['getAccount', 'searchContracts', 'getQuote'].includes(name) ? 'trading' : marketGroupForTool(name),
        blind: { blind: true, blindAllowBarSources: ['mock-paper'] },
      },
    )

    expect(Object.keys(sealed).sort()).toEqual([
      'bars',
      'calculate',
      'getAccount',
      'getQuote',
      'inbox_push',
      'searchContracts',
      'searchBars',
      'workspace_path',
    ].sort())
  })

  it('passes allowed bars through unchanged', async () => {
    const calls: unknown[] = []
    const sealed = sealBlindWorkspaceToolCatalog({
      bars: executable('bars', async (args) => {
        calls.push(args)
        return { ok: true }
      }),
    }, {
      blind: true,
      blindAllowBarSources: ['mock-paper'],
    })

    const result = await (sealed.bars.execute as (args: unknown, opts: unknown) => Promise<unknown>)(
      { barId: 'mock-paper|ASSET-A', interval: '1d' },
      {},
    )
    expect(result).toEqual({ ok: true })
    expect(calls).toEqual([{ barId: 'mock-paper|ASSET-A', interval: '1d' }])
  })

  it('refuses and audits disallowed bar sources', async () => {
    const audits: unknown[] = []
    const sealed = sealBlindWorkspaceToolCatalog({
      bars: executable('bars'),
    }, {
      blind: true,
      blindAllowBarSources: ['mock-paper'],
      workspaceId: 'ws-blind',
      workspaceLabel: 'blind lab',
      auditRefusal: async (event) => { audits.push(event) },
    })

    const result = await (sealed.bars.execute as (args: unknown, opts: unknown) => Promise<unknown>)(
      { barId: 'yfinance|AAPL', interval: '1d', asset: 'equity' },
      {},
    )
    expect(result).toMatchObject({ code: 'BLIND_BAR_SOURCE_DENIED' })
    expect((result as { error: string }).error).toMatch(/source "yfinance" is not allowlisted/)
    expect(audits).toEqual([expect.objectContaining({
      workspaceId: 'ws-blind',
      toolName: 'bars',
      barId: 'yfinance|AAPL',
      sourceId: 'yfinance',
      allowedSources: ['mock-paper'],
    })])
  })

  it('blind searchBars never calls the real search path and only returns an allowlisted explicit barId', async () => {
    let called = false
    const sealed = sealBlindWorkspaceToolCatalog({
      searchBars: executable('searchBars', async () => {
        called = true
        return { candidates: [], count: 0 }
      }),
    }, {
      blind: true,
      blindAllowBarSources: ['mock-paper'],
    })

    const result = await (sealed.searchBars.execute as (args: unknown, opts: unknown) => Promise<unknown>)(
      { query: 'mock-paper|ASSET-A' },
      {},
    )
    expect(called).toBe(false)
    expect(result).toMatchObject({
      count: 1,
      candidates: [expect.objectContaining({ barId: 'mock-paper|ASSET-A', sourceId: 'mock-paper' })],
    })
  })

  it('passes allowed bars through with the trimmed barId', async () => {
    const calls: unknown[] = []
    const sealed = sealBlindWorkspaceToolCatalog({
      bars: executable('bars', async (args) => {
        calls.push(args)
        return { ok: true }
      }),
    }, {
      blind: true,
      blindAllowBarSources: ['mock-paper'],
    })

    const result = await (sealed.bars.execute as (args: unknown, opts: unknown) => Promise<unknown>)(
      { barId: ' mock-paper|ASSET-A ', interval: '1d' },
      {},
    )

    expect(result).toEqual({ ok: true })
    expect(calls).toEqual([{ barId: 'mock-paper|ASSET-A', interval: '1d' }])
  })

  it('refuses blind trading market-data tools when their source is not allowlisted', async () => {
    const calls: string[] = []
    const sealed = sealBlindWorkspaceToolCatalog({
      searchContracts: executable('searchContracts', async () => { calls.push('searchContracts') }),
      getQuote: executable('getQuote', async () => { calls.push('getQuote') }),
      getContractDetails: executable('getContractDetails', async () => { calls.push('getContractDetails') }),
      expandContract: executable('expandContract', async () => { calls.push('expandContract') }),
      getMarketClock: executable('getMarketClock', async () => { calls.push('getMarketClock') }),
    }, {
      blind: true,
      blindAllowBarSources: ['mock-paper'],
    })

    const invoke = (name: string, args: unknown) =>
      (sealed[name].execute as (a: unknown, o: unknown) => Promise<unknown>)(args, {})

    await expect(invoke('searchContracts', { pattern: 'AAPL' })).resolves.toMatchObject({ code: 'BLIND_BAR_SOURCE_DENIED' })
    await expect(invoke('searchContracts', { source: 'alpaca-paper', pattern: 'AAPL' })).resolves.toMatchObject({ code: 'BLIND_BAR_SOURCE_DENIED' })
    await expect(invoke('getQuote', { aliceId: 'alpaca-paper|AAPL' })).resolves.toMatchObject({ code: 'BLIND_BAR_SOURCE_DENIED' })
    await expect(invoke('getContractDetails', { source: 'mock-paper', aliceId: 'alpaca-paper|AAPL' })).resolves.toMatchObject({ code: 'BLIND_BAR_SOURCE_DENIED' })
    await expect(invoke('expandContract', { aliceId: 'alpaca-paper|issuer:abc' })).resolves.toMatchObject({ code: 'BLIND_BAR_SOURCE_DENIED' })
    await expect(invoke('getMarketClock', {})).resolves.toMatchObject({ code: 'BLIND_BAR_SOURCE_DENIED' })

    expect(calls).toEqual([])
  })

  it('allows blind trading market-data tools only for allowlisted sources and trims args', async () => {
    const seen: Record<string, unknown> = {}
    const sealed = sealBlindWorkspaceToolCatalog({
      searchContracts: executable('searchContracts', async (args) => { seen.searchContracts = args; return { ok: true } }),
      getQuote: executable('getQuote', async (args) => { seen.getQuote = args; return { ok: true } }),
      getContractDetails: executable('getContractDetails', async (args) => { seen.getContractDetails = args; return { ok: true } }),
      expandContract: executable('expandContract', async (args) => { seen.expandContract = args; return { ok: true } }),
      getMarketClock: executable('getMarketClock', async (args) => { seen.getMarketClock = args; return { ok: true } }),
    }, {
      blind: true,
      blindAllowBarSources: ['mock-paper'],
    })

    const invoke = (name: string, args: unknown) =>
      (sealed[name].execute as (a: unknown, o: unknown) => Promise<unknown>)(args, {})

    await expect(invoke('searchContracts', { source: ' mock-paper ', pattern: 'ASSET-A' })).resolves.toEqual({ ok: true })
    await expect(invoke('getQuote', { aliceId: ' mock-paper|ASSET-A ', source: ' mock-paper ' })).resolves.toEqual({ ok: true })
    await expect(invoke('getContractDetails', { source: ' mock-paper ', aliceId: ' mock-paper|ASSET-A ' })).resolves.toEqual({ ok: true })
    await expect(invoke('expandContract', { aliceId: ' mock-paper|issuer:abc ' })).resolves.toEqual({ ok: true })
    await expect(invoke('getMarketClock', { source: ' mock-paper ' })).resolves.toEqual({ ok: true })

    expect(seen.searchContracts).toMatchObject({ source: 'mock-paper' })
    expect(seen.getQuote).toMatchObject({ aliceId: 'mock-paper|ASSET-A', source: 'mock-paper' })
    expect(seen.getContractDetails).toMatchObject({ source: 'mock-paper', aliceId: 'mock-paper|ASSET-A' })
    expect(seen.expandContract).toMatchObject({ aliceId: 'mock-paper|issuer:abc' })
    expect(seen.getMarketClock).toMatchObject({ source: 'mock-paper' })
  })
})

describe('trading proposal per-account authz binding', () => {
  const accounts = [
    { id: 'mock-read', maxAuthzLevel: 'read_only' as const, authzAccountType: 'mock' as const },
    { id: 'mock-paper', maxAuthzLevel: 'paper' as const, authzAccountType: 'mock' as const },
    { id: 'alpaca-live', maxAuthzLevel: 'small_live' as const, authzAccountType: 'live' as const },
  ]

  it('refuses a paper workspace staging against a live account with a distinct account-type error', () => {
    const gate = checkTradingProposalAuthz('placeOrder', { aliceId: 'alpaca-live|AAPL' }, {
      workspaceAuthzLevel: 'paper',
      accounts,
    })
    expect(gate.ok).toBe(false)
    expect(gate.ok ? '' : gate.message).toMatch(/paper-level access only applies to paper\/mock accounts/)
  })

  it('refuses a paper workspace staging against a read_only-ceiling mock account', () => {
    const gate = checkTradingProposalAuthz('placeOrder', { aliceId: 'mock-read|AAPL' }, {
      workspaceAuthzLevel: 'paper',
      accounts,
    })
    expect(gate.ok).toBe(false)
    expect(gate.ok ? '' : gate.message).toMatch(/effective authzLevel is read_only/)
  })

  it('allows a paper workspace staging against a paper-ceiling mock account', async () => {
    const wrapped = wrapTradingProposalToolsWithAuthz({
      placeOrder: {
        description: 'place',
        execute: async () => ({ ok: true }),
      } as unknown as Tool,
    }, {
      workspaceAuthzLevel: 'paper',
      accounts,
    })
    const result = await (wrapped.placeOrder.execute as (args: unknown, opts: unknown) => Promise<unknown>)(
      { aliceId: 'mock-paper|AAPL' },
      {},
    )
    expect(result).toEqual({ ok: true })
  })

  it('injects the resolved per-account authz level into proposal tool execution', async () => {
    let seenArgs: unknown
    const wrapped = wrapTradingProposalToolsWithAuthz({
      tradingCommit: {
        description: 'commit',
        execute: async (args: unknown) => {
          seenArgs = args
          return { ok: true }
        },
      } as unknown as Tool,
    }, {
      workspaceAuthzLevel: 'limited_autonomy',
      accounts,
    })

    await (wrapped.tradingCommit.execute as (args: unknown, opts: unknown) => Promise<unknown>)(
      { source: 'mock-paper', message: 'commit paper proposal' },
      {},
    )

    expect(seenArgs).toMatchObject({
      [OPENALICE_EFFECTIVE_AUTHZ_BY_ACCOUNT_ARG]: {
        'mock-paper': 'paper',
      },
    })
  })
})

describe('makeWorkspaceResolver', () => {
  it('resolves a known id to {id, dir, tag}', () => {
    const resolve = makeWorkspaceResolver(() =>
      svc({ ws2: { id: 'ws2', dir: '/wsroot/ws2', tag: 'Quant Lab' } }),
    )
    expect(resolve('ws2')).toEqual({ id: 'ws2', dir: '/wsroot/ws2', tag: 'Quant Lab' })
  })

  it('returns null for an unknown id', () => {
    const resolve = makeWorkspaceResolver(() => svc({}))
    expect(resolve('ghost')).toBeNull()
  })

  it('returns null when the service is not up yet', () => {
    const resolve = makeWorkspaceResolver(() => null)
    expect(resolve('ws2')).toBeNull()
  })

  it('is lazy — a peer registered AFTER the resolver is built still resolves', () => {
    const map: Record<string, Meta> = {}
    const resolve = makeWorkspaceResolver(() => svc(map))
    expect(resolve('ws9')).toBeNull()
    map['ws9'] = { id: 'ws9', dir: '/wsroot/ws9', tag: 'Late' }
    expect(resolve('ws9')).toEqual({ id: 'ws9', dir: '/wsroot/ws9', tag: 'Late' })
  })
})
