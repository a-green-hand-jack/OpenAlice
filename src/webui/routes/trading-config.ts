import { Hono } from 'hono'
import type { EngineContext } from '../../core/types.js'
import type { ProducerHandle } from '../../core/producer.js'
import {
  readUTAsConfig, mutateUTAsConfig,
  utaConfigSchema, wipeUTATradingData,
  assertHumanRiskEnvelopeTransition,
  RiskEnvelopeConfigTransitionError,
} from '../../core/config.js'
import {
  normalizeAuthzLevel,
  BUILTIN_BROKER_PRESETS,
  deriveUtaId,
  getBrokerPreset,
  mintInstanceId,
  UTA_INTERNAL_TOKEN_HEADER,
} from '@traderalice/uta-protocol'
import { triggerUTARestart } from '../../services/uta-supervisor/restart-trigger.js'
import { approverFromAliceRequest } from './approver-identity.js'
import { resolveUTAUrl } from '../../services/uta-supervisor/url.js'
import { describeTradingMode } from '../../services/trading-mode.js'

/** Fire-and-forget UTA restart after a config mutation. This is the SINGLE
 *  owner of restart-on-config-change (issue #127): the route layer triggers
 *  exactly one whole-UTA-process restart per logical mutation. The
 *  `UTAManagerSDK` lifecycle methods (`reconnectUTA` / `removeUTA`) no longer
 *  touch the Guardian flag — previously they did, so every create/update/delete
 *  fired two restarts (this trigger + the SDK's) spaced beyond Guardian's
 *  debounce window, producing two SIGTERM/respawn cycles per change.
 *
 *  Logs but doesn't block the HTTP response — the UI returns immediately and
 *  Guardian flips the UTA process in the background. Expect a brief
 *  (~1–2s) window where `/api/trading/*` requests hit a restarting UTA;
 *  startup-path == restart-path (no in-process broker hot reload), so the
 *  respawned UTA reads the freshly-written `accounts.json` and reconnects every
 *  account. Bursts coalesce into at most one in-flight + one trailing restart
 *  (see `triggerUTARestart`), never one-per-mutation. */
function notifyUTAReload(): void {
  triggerUTARestart()
    .then((r) => {
      if (!r.triggered) console.warn('[trading-config] UTA restart skipped:', r.error)
      else if (!r.ready) console.warn('[trading-config] UTA did not come back:', r.error)
    })
    .catch((err) => {
      console.warn('[trading-config] UTA restart failed:', err instanceof Error ? err.message : err)
    })
}

let tradingConfigMutationQueue: Promise<void> = Promise.resolve()

async function withTradingConfigMutation<T>(fn: () => Promise<T>): Promise<T> {
  const previous = tradingConfigMutationQueue.catch(() => undefined)
  let release!: () => void
  tradingConfigMutationQueue = new Promise<void>((resolve) => {
    release = resolve
  })
  await previous
  try {
    return await fn()
  } finally {
    release()
  }
}

// ==================== Credential helpers ====================

/** Mask a secret string: show last 4 chars, prefix with "****" */
function mask(value: string): string {
  if (value.length <= 4) return '****'
  return '****' + value.slice(-4)
}

/** Field names that contain sensitive values. Convention-based, not hardcoded per broker. */
const SENSITIVE = /key|secret|password|token/i

/** Mask all sensitive string fields in a config object (recurses into nested objects). */
function maskSecrets<T extends Record<string, unknown>>(obj: T): T {
  const result = { ...obj }
  for (const [k, v] of Object.entries(result)) {
    if (typeof v === 'string' && v.length > 0 && SENSITIVE.test(k)) {
      ;(result as Record<string, unknown>)[k] = mask(v)
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      ;(result as Record<string, unknown>)[k] = maskSecrets(v as Record<string, unknown>)
    }
  }
  return result
}

/** Restore masked values (****...) from existing config (recurses into nested objects). */
function unmaskSecrets(
  body: Record<string, unknown>,
  existing: Record<string, unknown>,
): void {
  for (const [k, v] of Object.entries(body)) {
    if (typeof v === 'string' && v.startsWith('****') && typeof existing[k] === 'string') {
      body[k] = existing[k]
    } else if (v && typeof v === 'object' && !Array.isArray(v) && existing[k] && typeof existing[k] === 'object') {
      unmaskSecrets(v as Record<string, unknown>, existing[k] as Record<string, unknown>)
    }
  }
}

// ==================== Routes ====================

/** Trading config CRUD routes: accounts */
export function createTradingConfigRoutes(
  ctx: EngineContext,
  opts?: { authzProducer?: ProducerHandle<readonly ['authz.level-changed']> },
) {
  const app = new Hono()

  // ==================== Broker presets (for the wizard) ====================

  app.get('/broker-presets', (c) => {
    return c.json({ presets: BUILTIN_BROKER_PRESETS })
  })

  // ==================== Read all ====================

  app.get('/', async (c) => {
    try {
      const utas = await readUTAsConfig()
      const maskedUTAs = utas.map((a) => maskSecrets({ ...a }))
      return c.json({ utas: maskedUTAs })
    } catch (err) {
      return c.json({ error: String(err) }, 500)
    }
  })

  // ==================== UTA CRUD ====================

  /**
   * POST /uta — create a new UTA. Client supplies presetId + presetConfig
   * (+ optional label/guards). The id is derived from the preset's
   * fingerprintFields (deterministic broker identity) and assigned by
   * the server. Mock presets get a freshly-minted `_instanceId` if the
   * client didn't include one. 409 if an existing UTA already derives
   * to the same id (so re-adding the same broker doesn't silently fork).
   */
  app.post('/uta', async (c) => {
    try {
      return await withTradingConfigMutation(async () => {
        const body = await c.req.json() as Record<string, unknown>
        if (!body.presetId || typeof body.presetId !== 'string') {
          return c.json({ error: 'presetId is required' }, 400)
        }

        let preset
        try {
          preset = getBrokerPreset(body.presetId)
        } catch (err) {
          return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
        }

        // Mint _instanceId for Mock presets so each sim has a unique fingerprint.
        const presetConfig = { ...(body.presetConfig as Record<string, unknown> | undefined ?? {}) }
        if (preset.engine === 'mock' && !presetConfig._instanceId) {
          presetConfig._instanceId = mintInstanceId()
        }

        const id = deriveUtaId(preset, presetConfig)
        const outcome: {
          existing?: { id: string; label: string; presetId: string }
          validated?: ReturnType<typeof utaConfigSchema.parse>
        } = {}
        await mutateUTAsConfig((accounts) => {
          const existing = accounts.find((a) => a.id === id)
          if (existing) {
            outcome.existing = {
              id: existing.id,
              label: existing.label ?? existing.id,
              presetId: existing.presetId,
            }
            return accounts
          }

          const candidate = {
            id,
            label: typeof body.label === 'string' && body.label ? body.label : id,
            presetId: preset.id,
            enabled: body.enabled !== false,
            guards: Array.isArray(body.guards) ? body.guards : [],
            riskEnvelope: body.riskEnvelope ?? null,
            presetConfig,
            readOnly: body.readOnly === true,
            asVendor: body.asVendor !== false,
            ...(typeof body.maxAuthzLevel === 'string' ? { maxAuthzLevel: body.maxAuthzLevel } : {}),
            ...(body.ephemeral === true ? { ephemeral: true as const } : {}),
          }
          const validated = utaConfigSchema.parse(candidate)
          outcome.validated = validated
          accounts.push(validated)
          return accounts
        })
        if (outcome.existing) {
          return c.json({
            error: 'A UTA already exists for this broker identity',
            existing: outcome.existing,
          }, 409)
        }
        const validated = outcome.validated
        if (!validated) throw new Error('UTA config create transaction produced no account')
        notifyUTAReload()

        // Echo masked — plaintext credentials never leave the server, and the
        // client's local state stays shape-identical to what GET / returns.
        return c.json(maskSecrets({ ...validated }), 201)
      })
    } catch (err) {
      if (err instanceof RiskEnvelopeConfigTransitionError) {
        return c.json({ error: err.code, message: err.message }, 409)
      }
      if (err instanceof Error && err.name === 'ZodError') {
        return c.json({ error: 'Validation failed', details: JSON.parse(err.message) }, 400)
      }
      return c.json({ error: String(err) }, 500)
    }
  })

  /**
   * PUT /uta/:id — edit an existing UTA. Will NOT create a new one; new
   * UTAs go through POST /uta which derives the id from credentials.
   * Edits keep the original id even when credentials change (rotation
   * is a normal user action; id is set at origin and immutable).
   */
  app.put('/uta/:id', async (c) => {
    try {
      return await withTradingConfigMutation(async () => {
        const id = c.req.param('id')
        const body = await c.req.json()
        if (body.id !== id) {
          return c.json({ error: 'Body id must match URL id' }, 400)
        }

        const outcome: {
          notFound?: true
          auditUnavailable?: true
          validated?: ReturnType<typeof utaConfigSchema.parse>
          from?: ReturnType<typeof normalizeAuthzLevel>
          to?: ReturnType<typeof normalizeAuthzLevel>
        } = {}
        const authzProducer = opts?.authzProducer
        await mutateUTAsConfig((accounts) => {
          const existing = accounts.find((a) => a.id === id)
          if (!existing) {
            outcome.notFound = true
            return accounts
          }

          // Restore masked credentials from existing config
          unmaskSecrets(body, existing as unknown as Record<string, unknown>)

          const validated = utaConfigSchema.parse(body)
          assertHumanRiskEnvelopeTransition(existing.riskEnvelope, validated.riskEnvelope)
          const from = normalizeAuthzLevel(existing.maxAuthzLevel)
          const to = normalizeAuthzLevel(validated.maxAuthzLevel)
          if (from !== to && !authzProducer) {
            outcome.auditUnavailable = true
            return accounts
          }
          const idx = accounts.findIndex((a) => a.id === id)
          accounts[idx] = validated
          outcome.validated = validated
          outcome.from = from
          outcome.to = to
          return accounts
        })
        if (outcome.notFound) {
          return c.json({
            error: `UTA "${id}" not found. Use POST /uta to create a new account.`,
          }, 422)
        }
        if (outcome.auditUnavailable) {
          return c.json({ error: 'authz_audit_unavailable' }, 500)
        }
        const validated = outcome.validated
        if (!validated || !outcome.from || !outcome.to) {
          throw new Error('UTA config update transaction produced no account')
        }
        if (outcome.from !== outcome.to && authzProducer) {
          await authzProducer.emit('authz.level-changed', {
            scope: 'account',
            id,
            from: outcome.from,
            to: outcome.to,
            approver: await approverFromAliceRequest(c),
          })
        }
        // A single whole-process restart applies every enabled-state and
        // credential-rotation change: the respawned UTA reads the fresh
        // `accounts.json` and connects exactly the enabled accounts. No
        // per-account SDK bounce is needed (and issuing one here re-introduced
        // the #127 double restart).
        notifyUTAReload()

        // Echo masked — same reasoning as POST.
        return c.json(maskSecrets({ ...validated }))
      })
    } catch (err) {
      if (err instanceof RiskEnvelopeConfigTransitionError) {
        return c.json({ error: err.code, message: err.message }, 409)
      }
      if (err instanceof Error && err.name === 'ZodError') {
        return c.json({ error: 'Validation failed', details: JSON.parse(err.message) }, 400)
      }
      return c.json({ error: String(err) }, 500)
    }
  })

  app.delete('/uta/:id', async (c) => {
    try {
      return await withTradingConfigMutation(async () => {
        const id = c.req.param('id')
        let target: ReturnType<typeof utaConfigSchema.parse> | undefined
        await mutateUTAsConfig((accounts) => {
          target = accounts.find((a) => a.id === id)
          return target ? accounts.filter((a) => a.id !== id) : accounts
        })
        if (!target) {
          return c.json({ error: `Account "${id}" not found` }, 404)
        }
        notifyUTAReload()
        // Ephemeral UTAs also have their persistent trading state wiped — the
        // whole point of `ephemeral: true` is that nothing about the test
        // account survives its destruction. Real broker UTAs keep their
        // commit history (delete-from-config means "stop trading from here",
        // not "erase what already happened").
        if (target.ephemeral) {
          await wipeUTATradingData(id)
        }
        return c.json({ success: true, ephemeral: target.ephemeral === true })
      })
    } catch (err) {
      return c.json({ error: String(err) }, 500)
    }
  })

  // ==================== Test Connection ====================
  // BFF passthrough — the actual broker instantiation lives in UTA
  // (it owns broker code). Alice forwards the wizard's payload over.

  app.post('/test-connection', async (c) => {
    const policy = ctx.tradingModePolicy()
    if (policy.mode === 'lite') {
      return c.json({ success: false, error: describeTradingMode('lite') }, 503)
    }
    const utaUrl = resolveUTAUrl()
    try {
      const body = await c.req.json()
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      const internalToken = process.env['OPENALICE_UTA_INTERNAL_TOKEN']
      if (internalToken) headers[UTA_INTERNAL_TOKEN_HEADER] = internalToken
      const res = await fetch(`${utaUrl.replace(/\/$/, '')}/api/trading/test-connection`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })
      const data = await res.json()
      return c.json(data, res.status as 200 | 400 | 500)
    } catch (err) {
      return c.json({ success: false, error: err instanceof Error ? err.message : String(err) }, 503)
    }
  })

  return app
}
