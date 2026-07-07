/**
 * WorkspaceToolCenter — registry of **workspace-scoped tool factories**.
 *
 * Parallel to {@link ToolCenter} but inverted in a key way: ToolCenter holds
 * concrete tool instances that don't care who is calling. WorkspaceToolCenter
 * holds *factories* — each one takes a workspace identity (wsId, label,
 * shared deps) and returns a concrete Tool whose execute() closes over that
 * identity. This is how OpenAlice exposes the "workspace's reverse channel
 * back to OpenAlice" surface (inbox_push and future workspace-scoped tools)
 * without ever asking the AI agent to traffic its own workspaceId.
 *
 * The MCP server's `/mcp/:wsId` route invokes every factory with the URL's
 * wsId at request time, then merges the resulting scoped tools with the
 * filtered global ToolCenter catalog. From the agent's POV,
 * `inbox_push({ docs, comments })` has no identity parameter — workspaceId is
 * invisible, baked into the tool by the server. Forgery surface is zero because
 * the URL is the only identity carrier.
 *
 * Why a separate registry instead of marking ToolCenter tools as
 * "workspace-scoped": the surface areas are genuinely different. ToolCenter
 * is "OpenAlice's services for anyone with an MCP client" — trading, market
 * data, news, brain. WorkspaceToolCenter is "this specific workspace's
 * communication back to OpenAlice." Mixing them under one registry with a
 * scope flag would tangle access control with tool execution, and external
 * MCP consumers would see workspace-shaped tools they can't sensibly use.
 */

import type { Tool } from 'ai'
import {
  AUTHZ_LEVEL_RANK,
  isAuthzLevelAllowedForAccountType,
  maxAuthzLevel,
  resolveAuthzAccountType,
  resolveEffectiveAuthzLevel,
  type AuthzAccountType,
  type AuthzLevel,
} from '@traderalice/uta-protocol'
import type { IInboxStore, InboxOrigin } from './inbox-store.js'
import type { IEntityStore } from './entity-store.js'
// TYPE-ONLY: the global-issue-board shapes. Importing them as types keeps
// core/ free of any runtime dependency on the workspaces/ module (no
// core→workspaces coupling), while letting the board reader below be typed.
import type { IssuesSnapshot, IssueDetail, WikilinkIssueRef } from '../workspaces/issues/board.js'

// ==================== Steward authz tool map ====================

export const READ_ONLY_TRADING_TOOL_NAMES = [
  'listUTAs',
  'searchContracts',
  'getContractDetails',
  'getAccount',
  'getPortfolio',
  'getOrders',
  'getQuote',
  'expandContract',
  'getMarketClock',
  'riskStatus',
  'tradingLog',
  'tradingShow',
  'tradingStatus',
  'orderHistory',
  'tradeHistory',
  'simulatePriceChange',
  'tradingSync',
] as const

export const PROPOSAL_TRADING_TOOL_NAMES = [
  'placeOrder',
  'modifyOrder',
  'closePosition',
  'cancelOrder',
  'tradingCommit',
  'tradingReject',
] as const

export const REMOVED_TRADING_TOOL_NAMES = ['tradingPush'] as const

export const TRADING_TOOL_MIN_AUTHZ_LEVEL: Readonly<Record<
  (typeof READ_ONLY_TRADING_TOOL_NAMES[number]) | (typeof PROPOSAL_TRADING_TOOL_NAMES[number]),
  AuthzLevel
>> = {
  listUTAs: 'read_only',
  searchContracts: 'read_only',
  getContractDetails: 'read_only',
  getAccount: 'read_only',
  getPortfolio: 'read_only',
  getOrders: 'read_only',
  getQuote: 'read_only',
  expandContract: 'read_only',
  getMarketClock: 'read_only',
  riskStatus: 'read_only',
  tradingLog: 'read_only',
  tradingShow: 'read_only',
  tradingStatus: 'read_only',
  orderHistory: 'read_only',
  tradeHistory: 'read_only',
  simulatePriceChange: 'read_only',
  tradingSync: 'read_only',
  placeOrder: 'paper',
  modifyOrder: 'paper',
  closePosition: 'paper',
  cancelOrder: 'paper',
  tradingCommit: 'paper',
  tradingReject: 'paper',
}

const REMOVED_TRADING_TOOL_SET = new Set<string>(REMOVED_TRADING_TOOL_NAMES)
const PROPOSAL_TRADING_TOOL_SET = new Set<string>(PROPOSAL_TRADING_TOOL_NAMES)

export const OPENALICE_EFFECTIVE_AUTHZ_BY_ACCOUNT_ARG = '__openaliceEffectiveAuthzByAccount'

function hasTradingAuthzRule(name: string): name is keyof typeof TRADING_TOOL_MIN_AUTHZ_LEVEL {
  return Object.prototype.hasOwnProperty.call(TRADING_TOOL_MIN_AUTHZ_LEVEL, name)
}

export function resolveWorkspaceToolAuthzLevel(input: {
  readonly workspaceAuthzLevel?: AuthzLevel | null
  readonly accountMaxAuthzLevels?: readonly (AuthzLevel | null | undefined)[]
}): AuthzLevel {
  return resolveEffectiveAuthzLevel({
    accountMaxAuthzLevel: maxAuthzLevel(input.accountMaxAuthzLevels ?? []),
    workspaceAuthzLevel: input.workspaceAuthzLevel,
  })
}

export function isTradingToolVisibleAtAuthzLevel(name: string, authzLevel: AuthzLevel): boolean {
  if (!hasTradingAuthzRule(name)) return false
  return AUTHZ_LEVEL_RANK[authzLevel] >= AUTHZ_LEVEL_RANK[TRADING_TOOL_MIN_AUTHZ_LEVEL[name]]
}

export function filterWorkspaceToolCatalog(
  tools: Record<string, Tool>,
  opts: {
    readonly authzLevel: AuthzLevel
    readonly groupForTool?: (name: string) => string | null
  },
): Record<string, Tool> {
  const out: Record<string, Tool> = {}
  for (const [name, tool] of Object.entries(tools)) {
    const group = opts.groupForTool?.(name) ?? null
    const knownTradingName = hasTradingAuthzRule(name) || REMOVED_TRADING_TOOL_SET.has(name)
    if (group !== 'trading' && !knownTradingName) {
      out[name] = tool
      continue
    }
    // Trading tools are deny-by-default: a new broker mutation cannot appear
    // in a workspace until it is explicitly placed in the approved authz map.
    if (isTradingToolVisibleAtAuthzLevel(name, opts.authzLevel)) {
      out[name] = tool
    }
  }
  return out
}

// ==================== Blind workspace market-data seal ====================

const BLIND_BAR_TOOL_NAMES = new Set(['bars', 'searchBars'])

const BLIND_TRADING_MARKET_TOOL_NAMES = new Set([
  'searchContracts',
  'getContractDetails',
  'getQuote',
  'expandContract',
  'getMarketClock',
])

const BLIND_BLOCKED_TOOL_NAMES = new Set([
  'calculateIndicator',
  'calculateQuant',
  'marketSearchForResearch',
])

const BLIND_BLOCKED_GROUPS = new Set([
  'analysis',
  'derivatives',
  'economy',
  'equity',
  'etf',
  'indices',
  'market-board',
  'market-search',
  'market-vendors',
  'news',
  'rss',
  'sector-rotation',
  'simulate',
  'snapshot',
])

export interface BlindBarSourceRefusal {
  readonly workspaceId?: string
  readonly workspaceLabel?: string
  readonly toolName: string
  readonly barId?: string
  readonly aliceId?: string
  readonly sourceId?: string
  readonly allowedSources: readonly string[]
  readonly message: string
}

export interface BlindWorkspaceToolSealOptions {
  readonly blind?: boolean | null
  readonly blindAllowBarSources?: readonly string[] | null
  readonly workspaceId?: string
  readonly workspaceLabel?: string
  readonly auditRefusal?: (event: BlindBarSourceRefusal) => void | Promise<void>
}

function normalizeBlindAllowSources(sources: readonly string[] | null | undefined): readonly string[] {
  return [...new Set((sources ?? []).map((s) => s.trim()).filter((s) => s.length > 0))]
}

function splitBarId(barId: string): { sourceId: string; nativeSymbol: string } | null {
  const idx = barId.indexOf('|')
  if (idx <= 0 || idx === barId.length - 1) return null
  return { sourceId: barId.slice(0, idx), nativeSymbol: barId.slice(idx + 1) }
}

function blindBarRefusalMessage(input: {
  readonly toolName: string
  readonly barId?: string
  readonly sourceId?: string
  readonly allowedSources: readonly string[]
}): string {
  const allowed = input.allowedSources.length > 0
    ? `Allowed bar sources: ${input.allowedSources.join(', ')}.`
    : 'No bar sources are allowlisted for this blind workspace.'
  if (!input.sourceId) {
    if (!input.barId) {
      return (
        `Blind workspace refused ${input.toolName}: this workspace cannot search real vendors, brokers, or tickers. ` +
        `Pass an explicit allowlisted source/barId. ${allowed}`
      )
    }
    return (
      `Blind workspace refused ${input.toolName} for barId "${input.barId}": expected "source|symbol". ` +
      allowed
    )
  }
  if (!input.barId) {
    return (
      `Blind workspace refused ${input.toolName}: source "${input.sourceId}" is not allowlisted. ` +
      `${allowed} This workspace can only query anonymized market-data sources provided by its blind campaign.`
    )
  }
  return (
    `Blind workspace refused ${input.toolName} for barId "${input.barId}": source "${input.sourceId}" is not allowlisted. ` +
    `${allowed} This workspace can only read anonymized barIds provided by its blind campaign.`
  )
}

function readBarIdArg(toolName: string, args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const record = args as Record<string, unknown>
  if (typeof record['barId'] === 'string') return record['barId']
  if (toolName === 'searchBars' && typeof record['query'] === 'string') return record['query']
  return undefined
}

function readStringArg(args: unknown, key: string): string | undefined {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined
  const value = (args as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : undefined
}

function withNormalizedStringArgs(
  args: unknown,
  updates: Record<string, string | undefined>,
): unknown {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return args
  const next: Record<string, unknown> = { ...(args as Record<string, unknown>) }
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) delete next[key]
    else next[key] = value
  }
  return next
}

function blindSearchBarsCandidate(barId: string, sourceId: string, nativeSymbol: string): unknown {
  return {
    barId,
    source: 'uta',
    sourceId,
    symbol: nativeSymbol,
    assetClass: 'unknown',
    label: `${nativeSymbol} (${sourceId}) - blind-allowed`,
  }
}

function wrapBlindBarTool(
  name: string,
  tool: Tool,
  opts: Required<Pick<BlindWorkspaceToolSealOptions, 'blind'>> & Omit<BlindWorkspaceToolSealOptions, 'blind'>,
): Tool {
  const executable = tool as Tool & { execute?: (args: unknown, options: unknown) => unknown }
  if (!executable.execute) return tool
  const execute = executable.execute
  const allowedSources = normalizeBlindAllowSources(opts.blindAllowBarSources)

  return {
    ...tool,
    execute: async (args: unknown, options: unknown) => {
      const barId = readBarIdArg(name, args)?.trim()
      const parsed = barId ? splitBarId(barId) : null
      const allowed = parsed ? allowedSources.includes(parsed.sourceId) : false
      if (!allowed) {
        const message = blindBarRefusalMessage({
          toolName: name,
          ...(barId ? { barId } : {}),
          ...(parsed?.sourceId ? { sourceId: parsed.sourceId } : {}),
          allowedSources,
        })
        try {
          await opts.auditRefusal?.({
            ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
            ...(opts.workspaceLabel ? { workspaceLabel: opts.workspaceLabel } : {}),
            toolName: name,
            ...(barId ? { barId } : {}),
            ...(parsed?.sourceId ? { sourceId: parsed.sourceId } : {}),
            allowedSources,
            message,
          })
        } catch (err) {
          console.warn('blind workspace bar-refusal audit failed', err)
        }
        return { error: message, code: 'BLIND_BAR_SOURCE_DENIED' }
      }

      if (name === 'searchBars') {
        return {
          candidates: [blindSearchBarsCandidate(barId!, parsed!.sourceId, parsed!.nativeSymbol)],
          count: 1,
        }
      }

      return await execute(withNormalizedStringArgs(args, { barId }), options)
    },
  } as Tool
}

function readBlindTradingMarketSources(toolName: string, args: unknown): {
  readonly sourceIds: readonly string[]
  readonly args: unknown
  readonly aliceId?: string
  readonly source?: string
} {
  const rawSource = readStringArg(args, 'source')
  const rawAliceId = readStringArg(args, 'aliceId')
  const source = rawSource?.trim()
  const aliceId = rawAliceId?.trim()
  const updates: Record<string, string | undefined> = {}
  if (rawSource !== undefined) updates['source'] = source && source.length > 0 ? source : undefined
  if (rawAliceId !== undefined) updates['aliceId'] = aliceId && aliceId.length > 0 ? aliceId : undefined

  const sourceIds: string[] = []
  const addSource = (value: string | undefined) => {
    if (value && !sourceIds.includes(value)) sourceIds.push(value)
  }
  const addAliceIdSource = (value: string | undefined) => {
    if (!value) return
    addSource(splitBarId(value)?.sourceId)
  }

  switch (toolName) {
    case 'searchContracts':
    case 'getMarketClock':
      addSource(source)
      break
    case 'getQuote':
    case 'expandContract':
      addAliceIdSource(aliceId)
      addSource(source)
      break
    case 'getContractDetails':
      addSource(source)
      addAliceIdSource(aliceId)
      break
  }

  return {
    sourceIds,
    args: withNormalizedStringArgs(args, updates),
    ...(aliceId ? { aliceId } : {}),
    ...(source ? { source } : {}),
  }
}

function wrapBlindTradingMarketTool(
  name: string,
  tool: Tool,
  opts: Required<Pick<BlindWorkspaceToolSealOptions, 'blind'>> & Omit<BlindWorkspaceToolSealOptions, 'blind'>,
): Tool {
  const executable = tool as Tool & { execute?: (args: unknown, options: unknown) => unknown }
  if (!executable.execute) return tool
  const execute = executable.execute
  const allowedSources = normalizeBlindAllowSources(opts.blindAllowBarSources)

  return {
    ...tool,
    execute: async (args: unknown, options: unknown) => {
      const refs = readBlindTradingMarketSources(name, args)
      const denied = refs.sourceIds.find((sourceId) => !allowedSources.includes(sourceId))
      const sourceId = denied ?? refs.sourceIds[0]
      if (refs.sourceIds.length === 0 || denied) {
        const message = blindBarRefusalMessage({
          toolName: name,
          ...(refs.aliceId ? { barId: refs.aliceId } : {}),
          ...(sourceId ? { sourceId } : {}),
          allowedSources,
        })
        try {
          await opts.auditRefusal?.({
            ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
            ...(opts.workspaceLabel ? { workspaceLabel: opts.workspaceLabel } : {}),
            toolName: name,
            ...(refs.aliceId ? { aliceId: refs.aliceId, barId: refs.aliceId } : {}),
            ...(sourceId ? { sourceId } : {}),
            allowedSources,
            message,
          })
        } catch (err) {
          console.warn('blind workspace source-refusal audit failed', err)
        }
        return { error: message, code: 'BLIND_BAR_SOURCE_DENIED' }
      }

      return await execute(refs.args, options)
    },
  } as Tool
}

export function sealBlindWorkspaceToolCatalog(
  tools: Record<string, Tool>,
  opts: BlindWorkspaceToolSealOptions & {
    readonly groupForTool?: (name: string) => string | null
  },
): Record<string, Tool> {
  if (opts.blind !== true) return tools

  const out: Record<string, Tool> = {}
  for (const [name, tool] of Object.entries(tools)) {
    if (BLIND_BAR_TOOL_NAMES.has(name)) {
      out[name] = wrapBlindBarTool(name, tool, { ...opts, blind: true })
      continue
    }
    if (BLIND_TRADING_MARKET_TOOL_NAMES.has(name)) {
      out[name] = wrapBlindTradingMarketTool(name, tool, { ...opts, blind: true })
      continue
    }
    const group = opts.groupForTool?.(name) ?? null
    if (BLIND_BLOCKED_TOOL_NAMES.has(name) || (group !== null && BLIND_BLOCKED_GROUPS.has(group))) {
      continue
    }
    out[name] = tool
  }
  return out
}

export function buildWorkspaceToolCatalog(
  globalTools: Record<string, Tool>,
  scopedTools: Record<string, Tool>,
  opts: {
    readonly authzLevel: AuthzLevel
    readonly groupForTool?: (name: string) => string | null
    readonly blind?: BlindWorkspaceToolSealOptions
  },
): Record<string, Tool> {
  const tools = {
    ...filterWorkspaceToolCatalog(globalTools, opts),
    ...scopedTools,
  }
  return sealBlindWorkspaceToolCatalog(tools, {
    ...(opts.blind ?? {}),
    ...(opts.groupForTool ? { groupForTool: opts.groupForTool } : {}),
  })
}

export interface AccountAuthzSnapshot {
  readonly id: string
  readonly maxAuthzLevel?: AuthzLevel | null
  readonly authzAccountType: AuthzAccountType
}

export function accountAuthzSnapshotFromConfig(input: {
  readonly id: string
  readonly presetId?: string
  readonly presetConfig?: Record<string, unknown> | null
  readonly maxAuthzLevel?: AuthzLevel | null
}): AccountAuthzSnapshot {
  return {
    id: input.id,
    ...(input.maxAuthzLevel ? { maxAuthzLevel: input.maxAuthzLevel } : {}),
    authzAccountType: resolveAuthzAccountType({
      presetId: input.presetId,
      presetConfig: input.presetConfig ?? {},
    }),
  }
}

export function checkTradingProposalAuthz(
  name: string,
  args: unknown,
  opts: {
    readonly workspaceAuthzLevel: AuthzLevel
    readonly accounts: readonly AccountAuthzSnapshot[]
  },
): { ok: true } | { ok: false; message: string } {
  const resolved = resolveTradingProposalAuthz(name, args, opts)
  return resolved.ok ? { ok: true } : { ok: false, message: resolved.message }
}

function resolveTradingProposalAuthz(
  name: string,
  args: unknown,
  opts: {
    readonly workspaceAuthzLevel: AuthzLevel
    readonly accounts: readonly AccountAuthzSnapshot[]
  },
): { ok: true; effectiveByAccount: Record<string, AuthzLevel> } | { ok: false; message: string } {
  if (!PROPOSAL_TRADING_TOOL_SET.has(name)) return { ok: true, effectiveByAccount: {} }
  const targets = resolveProposalTargetAccounts(name, args, opts.accounts)
  const effectiveByAccount: Record<string, AuthzLevel> = {}
  for (const account of targets) {
    const effective = resolveEffectiveAuthzLevel({
      workspaceAuthzLevel: opts.workspaceAuthzLevel,
      accountMaxAuthzLevel: account.maxAuthzLevel,
    })
    effectiveByAccount[account.id] = effective
    if (AUTHZ_LEVEL_RANK[effective] < AUTHZ_LEVEL_RANK.paper) {
      return {
        ok: false,
        message:
          `Trading proposal refused for account "${account.id}": effective authzLevel is ${effective}; ` +
          'stage/commit tools require at least paper after applying the workspace level and the account maxAuthzLevel.',
      }
    }
    if (!isAuthzLevelAllowedForAccountType(effective, account.authzAccountType)) {
      return {
        ok: false,
        message:
          `Trading proposal refused for account "${account.id}": paper-level access only applies to paper/mock accounts, ` +
          `but this account is ${account.authzAccountType}. Use a paper/mock account or ask a human to grant a live authorization level.`,
      }
    }
  }
  return { ok: true, effectiveByAccount }
}

export function wrapTradingProposalToolsWithAuthz(
  tools: Record<string, Tool>,
  opts: {
    readonly workspaceAuthzLevel: AuthzLevel
    readonly accounts: readonly AccountAuthzSnapshot[]
  },
): Record<string, Tool> {
  const out: Record<string, Tool> = { ...tools }
  for (const name of PROPOSAL_TRADING_TOOL_NAMES) {
    const tool = out[name] as (Tool & { execute?: (args: unknown, options: unknown) => unknown }) | undefined
    if (!tool?.execute) continue
    const execute = tool.execute
    out[name] = {
      ...tool,
      execute: async (args: unknown, options: unknown) => {
        const gate = resolveTradingProposalAuthz(name, args, opts)
        if (!gate.ok) return { error: gate.message, code: 'AUTHZ_DENIED' }
        return await execute(withEffectiveAuthzByAccount(args, gate.effectiveByAccount), options)
      },
    } as Tool
  }
  return out
}

function withEffectiveAuthzByAccount(
  args: unknown,
  effectiveByAccount: Record<string, AuthzLevel>,
): unknown {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args
  return {
    ...(args as Record<string, unknown>),
    [OPENALICE_EFFECTIVE_AUTHZ_BY_ACCOUNT_ARG]: effectiveByAccount,
  }
}

function resolveProposalTargetAccounts(
  name: string,
  args: unknown,
  accounts: readonly AccountAuthzSnapshot[],
): AccountAuthzSnapshot[] {
  const fields = args && typeof args === 'object' ? args as Record<string, unknown> : {}
  const source = typeof fields['source'] === 'string' && fields['source'].trim()
    ? fields['source'].trim()
    : undefined
  const aliceId = typeof fields['aliceId'] === 'string' ? fields['aliceId'] : undefined
  const sourceOrAliceId = source ?? (aliceId ? accountIdFromAliceId(aliceId) : undefined)

  if (name === 'tradingCommit' && !sourceOrAliceId) return [...accounts]
  if (!sourceOrAliceId) return []

  return accounts.filter((a) => a.id === sourceOrAliceId || a.id.startsWith(`${sourceOrAliceId}-`))
}

function accountIdFromAliceId(aliceId: string): string | undefined {
  const idx = aliceId.indexOf('|')
  if (idx <= 0) return undefined
  return aliceId.slice(0, idx)
}

// ==================== Context handed to factories ====================

export interface WorkspaceToolContext {
  /** The workspace's stable id. Filled by the MCP router from URL path. */
  workspaceId: string
  /** Snapshot of the workspace's display tag at build time. Factories can
   *  pass this through to call sites (e.g. inboxStore.append's
   *  workspaceLabel) so the inbox UI has a human-readable name even if
   *  the workspace tag changes later. */
  workspaceLabel: string
  /** Shared inbox store — passed in so factories don't have to import
   *  global state and tests can swap in a memory store. */
  inboxStore: IInboxStore
  /** Shared entity store — the durable cross-workspace tracked-index that
   *  entity_upsert / entity_search read and write. Same injection rationale
   *  as inboxStore. */
  entityStore: IEntityStore
  /** Resolve ANY workspace's location by id (not just this one) — the backing
   *  for cross-workspace collaboration: an inbox entry from a peer carries its
   *  workspaceId, and `workspace_path` turns that into the peer's absolute dir
   *  so the agent can read/edit its files with native tools. Optional because
   *  it needs the live WorkspaceService (created after this center); the two
   *  build sites (cli.ts, mcp.ts) inject a lazy closure, tests may omit it. */
  resolveWorkspace?: (id: string) => { id: string; dir: string; tag: string } | null
  /** Agent-INVISIBLE run provenance, resolved server-side from the
   *  `x-openalice-run` header by the MCP / CLI route (never supplied by the
   *  agent). Factories pass it through to call sites (e.g. inbox_push →
   *  inboxStore.append) so a pushed entry self-links to its originating run /
   *  issue. Absent (interactive session, or no header) → undefined. */
  origin?: InboxOrigin
  /** GLOBAL issue-board reader — the cross-workspace board the
   *  `alice-workspace` CLI surfaces (issue_list / issue_show read EVERY
   *  workspace's issues, not just the caller's). Backed by the live
   *  WorkspaceService at the two build sites (cli.ts, mcp.ts). OPTIONAL: a
   *  context without a service (older callers, unit tests) omits it, and the
   *  issue tools then fall back to reading THIS workspace's own files — so
   *  nothing breaks when it's absent. Reads only; writes stay caller-local. */
  board?: {
    snapshot(): Promise<IssuesSnapshot>
    detail(wsId: string, id: string): Promise<IssueDetail | null>
    resolveByName(name: string): Promise<WikilinkIssueRef[]>
  }
}

// ==================== Factory shape ====================

export interface WorkspaceToolFactory {
  /** Tool name as the agent will see it (no namespace prefix needed — the
   *  factory lives behind `/mcp/:wsId` which has its own catalog). */
  name: string
  /** Build a concrete Tool with workspaceId baked in. Called per MCP
   *  request, so closure capture is the right pattern (no shared mutable
   *  state between workspace requests). */
  build(ctx: WorkspaceToolContext): Tool
}

// ==================== Center ====================

export class WorkspaceToolCenter {
  private factories: WorkspaceToolFactory[] = []

  register(factory: WorkspaceToolFactory): void {
    // Name collisions overwrite — same pattern as ToolCenter.
    this.factories = this.factories.filter((f) => f.name !== factory.name)
    this.factories.push(factory)
  }

  /** Build one concrete tool catalog for a specific workspace context.
   *  Called from the MCP `/mcp/:wsId` route per request. */
  build(ctx: WorkspaceToolContext): Record<string, Tool> {
    const out: Record<string, Tool> = {}
    for (const f of this.factories) {
      out[f.name] = f.build(ctx)
    }
    return out
  }

  /** Names of registered factories. Useful for introspection / tests. */
  list(): string[] {
    return this.factories.map((f) => f.name)
  }
}

// ==================== Resolver helper ====================

/** Minimal structural view of WorkspaceService that {@link makeWorkspaceResolver}
 *  needs — kept structural so core/ doesn't depend on the workspaces/ module. */
interface WorkspaceRegistryLike {
  registry: { get(id: string): { id: string; dir: string; tag: string } | undefined }
}

/**
 * Build the `resolveWorkspace` closure both tool-context build sites
 * (cli.ts, mcp.ts) inject. Single source so the two never drift. Lazy over
 * `getService` because the WorkspaceService is created after the tool center,
 * and re-reads the live registry per call so a peer created later still
 * resolves. Returns null when the service isn't up yet or the id is unknown —
 * the tool then surfaces a clean error instead of throwing.
 */
export function makeWorkspaceResolver(
  getService: () => WorkspaceRegistryLike | null,
): NonNullable<WorkspaceToolContext['resolveWorkspace']> {
  return (id) => {
    const meta = getService()?.registry.get(id)
    return meta ? { id: meta.id, dir: meta.dir, tag: meta.tag } : null
  }
}
