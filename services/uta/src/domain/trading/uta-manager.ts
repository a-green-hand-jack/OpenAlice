/**
 * UTAManager — UTA lifecycle management, registry, and aggregation.
 *
 * Owns the full UTA lifecycle: create → register → reconnect → remove → close.
 * Also provides cross-UTA operations (aggregated equity, contract search).
 */

import { createHash } from 'node:crypto'
import Decimal from 'decimal.js'
import type { Contract, ContractDescription, ContractDetails } from '@traderalice/ibkr'
import type { AccountCapabilities, BrokerHealth, BrokerHealthInfo } from './brokers/types.js'
import { CcxtBroker } from './brokers/ccxt/CcxtBroker.js'
import { createCcxtProviderTools } from './brokers/ccxt/ccxt-tools.js'
import { createBroker } from './brokers/factory.js'
import {
  getBrokerPreset,
  compareStewardSizingSourceVersions,
  resolveBrokerMutationContainmentClass,
  resolveAuthzAccountType,
  STEWARD_ADMISSION_WIRE_VERSION,
  STEWARD_UTA_MUTATION_BOUNDARY_VERSION,
  STEWARD_UTA_MUTATION_MINIMUM_AUTHZ_LEVEL,
  stewardSizingSourceVersionsSchema,
  stewardSizingViewRequestSchema,
  stewardAuthoritativeSizingViewSchema,
  stewardUtaMutationRequestSchema,
  type GitExportState,
  type Operation,
  type AuthzLevel,
  type BrokerMutationContainmentClass,
  type StewardAdmissionRequest,
  type StewardAdmissionResponse,
  type StewardSizingSourceVersions,
  type StewardAuthoritativeSizingView,
  type StewardSizingViewRequest,
  type StewardUtaMutationRequest,
  type StewardUtaMutationRejectionCode,
  type StewardUtaMutationResponse,
} from '@traderalice/uta-protocol'
import { UnifiedTradingAccount } from './UnifiedTradingAccount.js'
import { loadGitState, createGitPersister } from './git-persistence.js'
import {
  readUTAsConfig,
  withLockedUTAsConfig,
  type TradingMode,
  type UTAConfig,
} from '@/core/config.js'
import type { EventLog } from '@/core/event-log.js'
import type { ToolCenter } from '@/core/tool-center.js'
import type { ReconnectResult } from '@/core/types.js'
import type { FxService } from './fx-service.js'
import type { UtaEventSink } from './events.js'
import { tryAutoPushPaper, type PaperAutoPushResult } from './paper-auto-push.js'
import {
  compileRiskEnvelopeGuards,
  evaluateStewardAdmission,
  resolveProductionRiskEnvelope,
  type RiskEnvelopeAdmissionSource,
} from './risk-envelope.js'
import './contract-ext.js'
import { StewardMutationIdempotencyConflictError } from './git/TradingGit.js'
import {
  MutationBusyError,
  MutationRecoveryRequiredError,
  MutationUnsupportedSchemaError,
} from './git/mutation-coordinator.js'

// Manager-level shapes live in `@traderalice/uta-protocol` (the SDK
// contract surface) — re-exported here for backwards compatibility with
// callers that import via `@/domain/trading`.
import type { UTASummary, AggregatedEquity, ContractSearchResult } from '@traderalice/uta-protocol'
export type { UTASummary, AggregatedEquity, ContractSearchResult }

// ==================== UTAManager ====================

export interface SnapshotHooks {
  onPostPush?: (utaId: string) => void | Promise<void>
  onPostReject?: (utaId: string) => void | Promise<void>
}

export interface StewardMutationFixtureProducer {
  /** Pure mapping used only to persist the fixture operation in TradingGit. */
  createOperation(input: {
    readonly accountId: string
    readonly request: StewardUtaMutationRequest
  }): Operation
  readSourceVersions(input: {
    readonly accountId: string
    readonly request: StewardUtaMutationRequest
  }): Promise<StewardSizingSourceVersions>
  /** UTA owns the return value; it is normalized into TradingGit and never
   * crosses the Steward mutation response. */
  invokeOperation(input: {
    readonly accountId: string
    readonly request: StewardUtaMutationRequest
    readonly operation: Operation
  }): Promise<unknown>
  /** Production adapters may only be used under the explicit D5 containment
   * policy below; legacy fixture producers remain test-only. */
  readonly productionAdapter?: boolean
}

export interface StewardMutationCriticalSection {
  run<T>(
    accountId: string,
    consume: (source: RiskEnvelopeAdmissionSource & { config?: UTAConfig | null }) => Promise<T>,
  ): Promise<T>
}

export interface UTAManagerDeps {
  eventLog?: EventLog
  toolCenter?: ToolCenter
  fxService?: FxService
  eventSink?: UtaEventSink
  /** Effective product-level mode resolved once by the UTA process. Lite
   * disables all mutation; readonly allows only verified isolation. */
  tradingMode?: TradingMode
  /** D2-only fixture lane. Production boot deliberately leaves this absent. */
  stewardMutationFixtureProducer?: StewardMutationFixtureProducer
  /** Test-only ownership injection; production uses withLockedUTAsConfig. */
  stewardMutationCriticalSection?: StewardMutationCriticalSection
  /** Test-only durable-state reader; production rereads commit.json. */
  stewardMutationDurableStateReader?: (accountId: string) => Promise<GitExportState | undefined>
}

export interface UtaRuntimePolicy {
  tradingMode: TradingMode
  containmentClass: BrokerMutationContainmentClass
}

class StewardMutationBoundaryRejection extends Error {
  constructor(
    readonly code: StewardUtaMutationRejectionCode,
    readonly changed?: readonly (keyof StewardSizingSourceVersions)[],
  ) {
    super(code)
    this.name = 'StewardMutationBoundaryRejection'
    if (code === 'source_state_changed' && !changed?.length) {
      throw new Error('source_state_changed requires at least one changed source version')
    }
  }
}

/** Pure config-to-runtime policy mapping used by UTAManager.initUTA. Keeping
 * this export side-effect-free lets tests prove real preset config wiring
 * without importing the UTA process entrypoint or opening broker transports. */
export function resolveUtaRuntimePolicy(cfg: UTAConfig, tradingMode: TradingMode): UtaRuntimePolicy {
  return {
    tradingMode,
    containmentClass: resolveBrokerMutationContainmentClass({
      presetId: cfg.presetId,
      presetConfig: cfg.presetConfig,
    }),
  }
}

/** D5's production adapter is intentionally narrower than generic readonly
 * containment: only the built-in in-memory simulator can receive this path. */
export function isVerifiedMockStewardAdapterPolicy(
  cfg: Pick<UTAConfig, 'presetId' | 'presetConfig'> | undefined,
  tradingMode: TradingMode,
): boolean {
  return tradingMode === 'readonly'
    && cfg?.presetId === 'mock-simulator'
    && resolveBrokerMutationContainmentClass({ presetId: cfg.presetId, presetConfig: cfg.presetConfig }) === 'verified-isolated'
}

export class UTAManager {
  private entries = new Map<string, UnifiedTradingAccount>()
  private configs = new Map<string, UTAConfig>()
  private reconnecting = new Set<string>()

  private eventLog?: EventLog
  private eventSink?: UtaEventSink
  private toolCenter?: ToolCenter
  private _snapshotHooks?: SnapshotHooks
  private fxService?: FxService
  private readonly tradingMode: TradingMode
  private readonly stewardMutationFixtureProducer?: StewardMutationFixtureProducer
  private readonly stewardMutationCriticalSection?: StewardMutationCriticalSection
  private readonly stewardMutationDurableStateReader: (accountId: string) => Promise<GitExportState | undefined>

  constructor(deps?: UTAManagerDeps) {
    this.eventLog = deps?.eventLog
    this.eventSink = deps?.eventSink
    this.toolCenter = deps?.toolCenter
    this.fxService = deps?.fxService
    this.tradingMode = deps?.tradingMode ?? 'pro'
    this.stewardMutationFixtureProducer = deps?.stewardMutationFixtureProducer
    this.stewardMutationCriticalSection = deps?.stewardMutationCriticalSection
    this.stewardMutationDurableStateReader = deps?.stewardMutationDurableStateReader ?? loadGitState
  }

  setSnapshotHooks(hooks: SnapshotHooks): void {
    this._snapshotHooks = hooks
  }

  setFxService(fx: FxService): void {
    this.fxService = fx
  }

  // ==================== Lifecycle ====================

  /** Create a UTA from config, register it, and start async broker connection. */
  async initUTA(cfg: UTAConfig): Promise<UnifiedTradingAccount> {
    const broker = createBroker(cfg, { fxService: this.fxService })
    const savedState = await loadGitState(cfg.id)
    const resolvedEnvelope = resolveProductionRiskEnvelope(cfg.riskEnvelope)
    const envelopeGuards = resolvedEnvelope.ok
      ? compileRiskEnvelopeGuards(resolvedEnvelope.envelope, broker)
      : []
    if (!resolvedEnvelope.ok && resolvedEnvelope.code === 'risk_envelope_scope_unsupported') {
      console.warn(`[uta] ${cfg.id}: ${resolvedEnvelope.message}`)
    }
    const uta = new UnifiedTradingAccount(broker, {
      guards: [...cfg.guards, ...envelopeGuards],
      keyless: cfg.keyless,
      readOnly: cfg.readOnly,
      ...resolveUtaRuntimePolicy(cfg, this.tradingMode),
      asVendor: cfg.asVendor,
      savedState,
      eventSink: this.eventSink,
      onCommit: createGitPersister(cfg.id),
      onHealthChange: (utaId, health) => {
        this.eventLog?.append('account.health', { accountId: utaId, ...health })
      },
      onPostPush: this._snapshotHooks?.onPostPush,
      onPostReject: this._snapshotHooks?.onPostReject,
    })
    this.add(uta)
    this.configs.set(cfg.id, cfg)
    return uta
  }

  /** Reconnect a UTA: close old → re-read config → create new → verify connection. */
  async reconnectUTA(utaId: string): Promise<ReconnectResult> {
    if (this.reconnecting.has(utaId)) {
      return { success: false, error: 'Reconnect already in progress' }
    }
    this.reconnecting.add(utaId)
    try {
      // Re-read config to pick up credential/guard changes
      const freshUTAs = await readUTAsConfig()

      // Close old UTA
      await this.removeUTA(utaId)

      const cfg = freshUTAs.find((a) => a.id === utaId)
      if (!cfg) {
        return { success: true, message: `UTA "${utaId}" not found in config (removed or disabled)` }
      }

      const uta = await this.initUTA(cfg)

      // Wait for broker.init() + broker.getAccount() to verify the connection
      await uta.waitForConnect()

      // Re-register CCXT-specific tools if this UTA routes to the CCXT engine.
      if (getBrokerPreset(cfg.presetId).engine === 'ccxt') {
        this.toolCenter?.register(
          createCcxtProviderTools(this),
          'trading-ccxt',
        )
      }

      const label = uta.label ?? utaId
      console.log(`reconnect: ${label} online`)
      return { success: true, message: `${label} reconnected` }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`reconnect: ${utaId} failed:`, msg)
      return { success: false, error: msg }
    } finally {
      this.reconnecting.delete(utaId)
    }
  }

  /** Close and deregister a UTA. No-op if UTA doesn't exist. */
  async removeUTA(utaId: string): Promise<void> {
    const uta = this.entries.get(utaId)
    if (!uta) return
    this.entries.delete(utaId)
    this.configs.delete(utaId)
    try { await uta.close() } catch { /* best effort */ }
  }

  /** Register CCXT provider tools if any CCXT accounts are present. */
  registerCcxtToolsIfNeeded(): void {
    const hasCcxt = this.resolve().some((uta) => uta.broker instanceof CcxtBroker)
    if (hasCcxt) {
      this.toolCenter?.register(createCcxtProviderTools(this), 'trading-ccxt')
      console.log('ccxt: provider tools registered')
    }
  }

  // ==================== Registration ====================

  add(uta: UnifiedTradingAccount, config?: UTAConfig): void {
    if (this.entries.has(uta.id)) {
      throw new Error(`UTA "${uta.id}" already registered`)
    }
    this.entries.set(uta.id, uta)
    if (config) this.configs.set(uta.id, config)
  }

  remove(id: string): void {
    this.entries.delete(id)
    this.configs.delete(id)
  }

  async maybeAutoPushPaperCommit(
    utaId: string,
    opts: { effectiveAuthzLevel?: AuthzLevel | null } = {},
  ): Promise<PaperAutoPushResult> {
    const uta = this.entries.get(utaId)
    const cfg = this.configs.get(utaId)
    if (!uta || !cfg) return { status: 'skipped', reason: 'not_configured' }

    return tryAutoPushPaper({
      uta,
      accountType: resolveAuthzAccountType({
        presetId: cfg.presetId,
        presetConfig: cfg.presetConfig,
      }),
      accountMaxAuthzLevel: cfg.maxAuthzLevel,
      effectiveAuthzLevel: opts.effectiveAuthzLevel,
      riskEnvelope: cfg.riskEnvelope,
      readAdmissionSource: () => this.readAdmissionSource(utaId),
      withLockedAdmissionSource: (consume) => this.withLockedAdmissionSource(utaId, consume),
    })
  }

  /** Versioned production admission wire. This reads accounts.json on every
   * call so a caller can capture a version and then recheck it immediately
   * before a later dispatch without trusting the manager's startup cache. */
  async checkStewardAdmission(
    utaId: string,
    request: StewardAdmissionRequest,
  ): Promise<StewardAdmissionResponse> {
    return evaluateStewardAdmission({
      accountId: utaId,
      source: await this.readAdmissionSource(utaId),
      request,
    })
  }

  /**
   * UTA is the only producer of sizing inputs. The config lock makes the
   * envelope/authz snapshot linearizable with its version; broker reads are
   * fingerprinted so the mutation boundary can reject any later drift.
   */
  async readStewardSizingView(
    utaId: string,
    requestInput: StewardSizingViewRequest,
  ): Promise<StewardAuthoritativeSizingView> {
    const request = stewardSizingViewRequestSchema.parse(requestInput)
    const uta = this.entries.get(utaId)
    if (!uta) throw new Error(`UTA ${utaId} is not configured`)
    // Match executeStewardMutation's order: account lease, then accounts
    // config lock. Reversing it would let a view and a mutation deadlock.
    return uta.readStewardSizingView(() => this.runStewardMutationCriticalSection(utaId, async (source) => {
      if (!source.config) throw new Error(`UTA ${utaId} is not configured`)
      return this.buildStewardSizingView(uta, source.config, request.instrument)
    }))
  }

  /**
   * Concrete D2 mutation boundary. TradingGit acquires the account mutation
   * lease first; its boundary callback then acquires the accounts-config lock
   * and keeps it through admission, durable external-key dedupe, any required
   * source-version comparison, and fixture invocation. An exact completed
   * duplicate returns before source comparison because the invocation is not
   * new; admission still runs for every request.
   */
  async invokeStewardMutation(
    utaId: string,
    workspaceAuthzLevel: AuthzLevel,
    requestInput: StewardUtaMutationRequest,
  ): Promise<StewardUtaMutationResponse> {
    const request = stewardUtaMutationRequestSchema.parse(requestInput)
    const identity = stewardMutationResponseIdentity(utaId, request)
    if (request.accountId !== utaId) {
      return { ...identity, status: 'rejected', code: 'account_identity_mismatch' }
    }
    const uta = this.entries.get(utaId)
    if (!uta || !this.stewardMutationFixtureProducer) {
      return { ...identity, status: 'rejected', code: 'mutation_capability_unavailable' }
    }
    const producer = this.stewardMutationFixtureProducer
    const payloadFingerprint = stewardMutationPayloadFingerprint(request)

    try {
      const result = await uta.executeStewardMutation({
        request,
        payloadFingerprint,
        message: `Steward deterministic operation ${request.operation.operationId}`,
        boundary: (transaction) => this.runStewardMutationCriticalSection(utaId, async (source) => {
          if (producer.productionAdapter && !isVerifiedMockStewardAdapterPolicy(source.config ?? undefined, this.tradingMode)) {
            throw new StewardMutationBoundaryRejection('mutation_capability_unavailable')
          }
          const admission = evaluateStewardAdmission({
            accountId: utaId,
            source,
            request: {
              version: STEWARD_ADMISSION_WIRE_VERSION,
              workspaceAuthzLevel,
              minimumAuthzLevel: STEWARD_UTA_MUTATION_MINIMUM_AUTHZ_LEVEL,
              expectedEnvelopeVersion: request.expectedSourceVersions.riskEnvelope,
            },
          })
          if (admission.status === 'rejected') {
            throw new StewardMutationBoundaryRejection(admission.code)
          }

          let durableState: GitExportState | undefined
          try {
            durableState = await this.stewardMutationDurableStateReader(utaId)
          } catch {
            throw new StewardMutationBoundaryRejection('mutation_recovery_required')
          }
          return transaction(durableState, async () => {
            let actualVersions: StewardSizingSourceVersions
            try {
              if (producer.productionAdapter) {
                const view = await this.buildStewardSizingView(
                  uta,
                  source.config ?? rejectMissingStewardConfig(utaId),
                  request.operation.instrument,
                )
                if (!supportsStewardMutationRequest(request, view)) {
                  throw new Error('broker capabilities do not support deterministic Steward operation')
                }
                actualVersions = stewardSizingSourceVersionsSchema.parse(view.sourceStateVersions)
              } else {
                actualVersions = stewardSizingSourceVersionsSchema.parse(
                  await producer.readSourceVersions({ accountId: utaId, request }),
                )
              }
            } catch {
              throw new StewardMutationBoundaryRejection('source_state_invalid')
            }
            const comparison = compareStewardSizingSourceVersions(
              request.expectedSourceVersions,
              actualVersions,
            )
            if (!comparison.ok) {
              throw new StewardMutationBoundaryRejection(comparison.code, comparison.changed)
            }
          })
        }),
        prepareOperation: () => producer.createOperation({ accountId: utaId, request }),
        execute: (operation) => producer.invokeOperation({ accountId: utaId, request, operation }),
      })
      return {
        ...identity,
        status: 'accepted',
        deduplicated: result.deduplicated,
      }
    } catch (error) {
      if (error instanceof StewardMutationBoundaryRejection) {
        if (error.code === 'source_state_changed') {
          return {
            ...identity,
            status: 'rejected',
            code: error.code,
            changed: [...(error.changed ?? [])],
          }
        }
        return {
          ...identity,
          status: 'rejected',
          code: error.code,
          ...(error.changed?.length ? { changed: [...error.changed] } : {}),
        }
      }
      if (error instanceof StewardMutationIdempotencyConflictError) {
        return { ...identity, status: 'rejected', code: 'idempotency_conflict' }
      }
      if (error instanceof MutationBusyError) {
        return { ...identity, status: 'rejected', code: 'mutation_busy' }
      }
      if (
        error instanceof MutationRecoveryRequiredError
        || error instanceof MutationUnsupportedSchemaError
      ) {
        return { ...identity, status: 'rejected', code: 'mutation_recovery_required' }
      }
      return { ...identity, status: 'rejected', code: 'mutation_recovery_required' }
    }
  }

  private async readAdmissionSource(utaId: string): Promise<RiskEnvelopeAdmissionSource> {
    try {
      const fresh = (await readUTAsConfig()).find((account) => account.id === utaId)
      return {
        riskEnvelope: fresh?.riskEnvelope ?? null,
        accountMaxAuthzLevel: fresh?.maxAuthzLevel ?? null,
      }
    } catch {
      // Corrupt/partial config is deliberately indistinguishable from a
      // missing envelope at the autonomous admission boundary.
      return { riskEnvelope: null, accountMaxAuthzLevel: null }
    }
  }

  private async buildStewardSizingView(
    uta: UnifiedTradingAccount,
    cfg: UTAConfig,
    instrument: string,
  ): Promise<StewardAuthoritativeSizingView> {
    const contract = uta.contractFromAliceId(instrument)
    const [account, positions, quote] = await Promise.all([
      uta.getAccount(),
      uta.getPositions(),
      uta.getQuote(contract),
    ])
    const position = positions.find((item) => item.contract.aliceId === instrument)
    const quantity = position
      ? (position.side === 'short' ? position.quantity.negated() : position.quantity).toString()
      : '0'
    const mark = position?.marketPrice ?? quote.last
    const markPrice = isPositiveDecimal(mark) ? mark : null
    const envelope = resolveProductionRiskEnvelope(cfg.riskEnvelope)
    const riskState = uta.getRiskState()
    const capabilities = uta.getCapabilities()
    const available = envelope.ok
      ? {
          kind: 'available' as const,
          envelopeVersion: envelope.envelope.version,
          scopeAllowed: envelope.envelope.scope.symbols.includes(instrument)
            || envelope.envelope.scope.symbols.includes(contract.localSymbol)
            || envelope.envelope.scope.symbols.includes(contract.symbol),
          increaseAllowed: !envelope.envelope.revoked && riskState.state === 'NORMAL',
          caps: {
            maxPositionPctOfEquity: String(envelope.envelope.maxPositionPctOfEquity),
            maxSingleOrderPctOfEquity: String(envelope.envelope.maxSingleOrderPctOfEquity),
            // UTA has threshold and breach state, but no authoritative
            // consumed-budget ledger. Never mistake a policy ceiling for a
            // remaining budget: until that input exists this is fail-closed.
            remainingLossPctOfEquity: '0',
          },
        }
      : { kind: 'missing' as const }
    const accountStateVersion = fingerprint({ account, positions, quote: markPrice, instrument })
    const riskStateVersion = fingerprint(riskState)
    const capabilitiesStateVersion = fingerprint(capabilities)
    return stewardAuthoritativeSizingViewSchema.parse({
      version: 1,
      account: {
        accountId: uta.id,
        accountStateVersion,
        equity: account.netLiquidation,
        instrument: {
          instrument,
          positionQuantity: quantity,
          markPrice,
          contractMultiplier: contract.multiplier || position?.multiplier || '1',
          quantityIncrement: '1',
        },
      },
      risk: {
        accountId: uta.id,
        riskStateVersion,
        envelope: available,
      },
      brokerCapabilities: {
        capabilitiesStateVersion,
        market: capabilities.supportedOrderTypes.includes('MKT'),
        stop: capabilities.supportedOrderTypes.includes('STP'),
        stopLimit: capabilities.supportedOrderTypes.includes('STP LMT')
          ? { supported: true, limitOffsetBps: 25 }
          : { supported: false },
      },
      sourceStateVersions: {
        accountState: accountStateVersion,
        riskState: riskStateVersion,
        riskEnvelope: available.kind === 'available' ? available.envelopeVersion : null,
        brokerCapabilities: capabilitiesStateVersion,
      },
    })
  }

  private async withLockedAdmissionSource<T>(
    utaId: string,
    consume: (source: RiskEnvelopeAdmissionSource) => Promise<T>,
  ): Promise<T> {
    return withLockedUTAsConfig(async (accounts) => {
      const fresh = accounts.find((account) => account.id === utaId)
      return consume({
        riskEnvelope: fresh?.riskEnvelope ?? null,
        accountMaxAuthzLevel: fresh?.maxAuthzLevel ?? null,
        config: fresh ?? null,
      })
    })
  }

  private runStewardMutationCriticalSection<T>(
    utaId: string,
    consume: (source: RiskEnvelopeAdmissionSource & { config?: UTAConfig | null }) => Promise<T>,
  ): Promise<T> {
    return this.stewardMutationCriticalSection
      ? this.stewardMutationCriticalSection.run(utaId, consume)
      : this.withLockedAdmissionSource(utaId, consume)
  }

  // ==================== Lookups ====================

  get(id: string): UnifiedTradingAccount | undefined {
    return this.entries.get(id)
  }

  listUTAs(): UTASummary[] {
    return Array.from(this.entries.values()).map((uta) => {
      const cfg = this.configs.get(uta.id)
      return {
        id: uta.id,
        label: uta.label,
        asVendor: uta.asVendor,
        capabilities: uta.getCapabilities(),
        health: uta.getHealthInfo(),
        ...(cfg?.maxAuthzLevel ? { maxAuthzLevel: cfg.maxAuthzLevel } : {}),
        authzAccountType: cfg
          ? resolveAuthzAccountType({ presetId: cfg.presetId, presetConfig: cfg.presetConfig })
          : 'unknown',
      }
    })
  }

  has(id: string): boolean {
    return this.entries.has(id)
  }

  get size(): number {
    return this.entries.size
  }

  // ==================== Source routing ====================

  resolve(source?: string): UnifiedTradingAccount[] {
    if (!source) {
      return Array.from(this.entries.values())
    }
    const byId = this.entries.get(source)
    if (byId) return [byId]
    return []
  }

  resolveOne(source: string): UnifiedTradingAccount {
    const results = this.resolve(source)
    if (results.length === 0) {
      throw new Error(`No UTA found matching source "${source}". Use listUTAs to see available UTAs.`)
    }
    if (results.length > 1) {
      throw new Error(
        `Multiple UTAs match source "${source}": ${results.map((r) => r.id).join(', ')}. Use UTA id for exact match.`,
      )
    }
    return results[0]
  }

  // ==================== Cross-account aggregation ====================

  async getAggregatedEquity(): Promise<AggregatedEquity> {
    const results = await Promise.all(
      // Keyless (public-data-only) UTAs have no account — skip them so they
      // don't add a phantom $0 account to the aggregate.
      Array.from(this.entries.values()).filter((uta) => !uta.keyless).map(async (uta) => {
        if (uta.health !== 'healthy') {
          uta.nudgeRecovery()
          return { id: uta.id, label: uta.label, health: uta.health, info: null }
        }
        try {
          const info = await uta.getAccount()
          return { id: uta.id, label: uta.label, health: uta.health, info }
        } catch {
          return { id: uta.id, label: uta.label, health: uta.health, info: null }
        }
      }),
    )

    let totalEquity = new Decimal(0)
    let totalCash = new Decimal(0)
    let totalUnrealizedPnL = new Decimal(0)
    let totalRealizedPnL = new Decimal(0)
    const fxWarnings: string[] = []
    const accounts: AggregatedEquity['accounts'] = []

    for (const { id, label, health, info } of results) {
      const baseCurrency = info?.baseCurrency ?? 'USD'
      if (info) {
        if (this.fxService && baseCurrency !== 'USD') {
          // Convert non-USD account values to USD
          const [eqR, cashR, pnlR, rpnlR] = await Promise.all([
            this.fxService.convertToUsd(info.netLiquidation, baseCurrency),
            this.fxService.convertToUsd(info.totalCashValue, baseCurrency),
            this.fxService.convertToUsd(info.unrealizedPnL, baseCurrency),
            this.fxService.convertToUsd(info.realizedPnL ?? '0', baseCurrency),
          ])
          totalEquity = totalEquity.plus(eqR.usd)
          totalCash = totalCash.plus(cashR.usd)
          totalUnrealizedPnL = totalUnrealizedPnL.plus(pnlR.usd)
          totalRealizedPnL = totalRealizedPnL.plus(rpnlR.usd)
          // Collect warnings (deduplicate — same currency produces same warning)
          const w = eqR.fxWarning
          if (w && !fxWarnings.includes(w)) fxWarnings.push(w)
          accounts.push({ id, label, baseCurrency, equity: eqR.usd, cash: cashR.usd, unrealizedPnL: pnlR.usd, health })
        } else {
          // Already USD or no FxService — pass through
          totalEquity = totalEquity.plus(info.netLiquidation)
          totalCash = totalCash.plus(info.totalCashValue)
          totalUnrealizedPnL = totalUnrealizedPnL.plus(info.unrealizedPnL)
          totalRealizedPnL = totalRealizedPnL.plus(info.realizedPnL ?? '0')
          accounts.push({ id, label, baseCurrency, equity: info.netLiquidation, cash: info.totalCashValue, unrealizedPnL: info.unrealizedPnL, health })
        }
      } else {
        accounts.push({ id, label, baseCurrency, equity: '0', cash: '0', unrealizedPnL: '0', health })
      }
    }

    return {
      totalEquity: totalEquity.toString(), totalCash: totalCash.toString(),
      totalUnrealizedPnL: totalUnrealizedPnL.toString(), totalRealizedPnL: totalRealizedPnL.toString(),
      fxWarnings: fxWarnings.length > 0 ? fxWarnings : undefined,
      accounts,
    }
  }

  // ==================== Cross-account contract search ====================

  async searchContracts(
    pattern: string,
    accountId?: string,
  ): Promise<ContractSearchResult[]> {
    const targets = accountId
      ? [this.entries.get(accountId)].filter(Boolean) as UnifiedTradingAccount[]
      : Array.from(this.entries.values()).filter((uta) => uta.asVendor !== false)

    const results = await Promise.all(
      targets.map(async (uta) => {
        if (uta.health !== 'healthy') {
          uta.nudgeRecovery()
          return { accountId: uta.id, results: [] as ContractDescription[] }
        }
        try {
          const descriptions = await uta.searchContracts(pattern)
          return { accountId: uta.id, results: descriptions }
        } catch {
          return { accountId: uta.id, results: [] as ContractDescription[] }
        }
      }),
    )

    return results.filter((r) => r.results.length > 0)
  }

  async getContractDetails(
    query: Contract,
    accountId: string,
  ): Promise<ContractDetails | null> {
    const uta = this.entries.get(accountId)
    if (!uta) return null
    return uta.getContractDetails(query)
  }

  // ==================== Cleanup ====================

  async closeAll(): Promise<void> {
    await Promise.allSettled(
      Array.from(this.entries.values()).map((uta) => uta.close()),
    )
    this.entries.clear()
  }
}

function stewardMutationResponseIdentity(
  accountId: string,
  request: StewardUtaMutationRequest,
) {
  return {
    version: STEWARD_UTA_MUTATION_BOUNDARY_VERSION,
    accountId,
    utaMutationReference: request.utaMutationReference,
    operationId: request.operation.operationId,
  } as const
}

function stewardMutationPayloadFingerprint(request: StewardUtaMutationRequest): string {
  const payload = {
    operation: request.operation,
    ...('protection' in request ? { protection: request.protection } : {}),
  }
  return createHash('sha256')
    .update(JSON.stringify(canonicalizeJson(payload)))
    .digest('hex')
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson)
  if (value === null || typeof value !== 'object') return value
  const source = value as Record<string, unknown>
  return Object.fromEntries(
    Object.keys(source).sort().map((key) => [key, canonicalizeJson(source[key])]),
  )
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalizeJson(value))).digest('hex')
}

function isPositiveDecimal(value: string | undefined): value is string {
  if (!value) return false
  try {
    return new Decimal(value).isFinite() && new Decimal(value).gt(0)
  } catch {
    return false
  }
}

function rejectMissingStewardConfig(utaId: string): never {
  throw new Error(`UTA ${utaId} is not configured`)
}

export function supportsStewardMutationRequest(
  request: StewardUtaMutationRequest,
  view: StewardAuthoritativeSizingView,
): boolean {
  if (!('protection' in request)) return view.brokerCapabilities.market
  return request.protection.orderType === 'STP'
    ? view.brokerCapabilities.stop
    : view.brokerCapabilities.stopLimit.supported
}
