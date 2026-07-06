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
