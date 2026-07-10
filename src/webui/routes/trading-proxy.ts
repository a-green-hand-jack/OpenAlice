/**
 * BFF proxy for `/api/trading/*` — Alice → UTA.
 *
 * UI talks to Alice on a single origin (decision #2 of UTA-split v1); this
 * route forwards every trading request unchanged to the UTA service. v1
 * attaches Guardian's per-launch internal token so UTA can reject direct
 * loopback calls from workspace processes.
 *
 * Stream-friendly: forwards request body, returns UTA's Response as-is so
 * `Content-Type` / chunked transfer / SSE headers pass through. A short
 * connect timeout (1s) fails fast when UTA is down, so the agent loop
 * doesn't hang on a dead backend.
 */

import { Hono, type Context } from 'hono'
import { UTA_INTERNAL_TOKEN_HEADER } from '@traderalice/uta-protocol'
import { adminSessionFingerprintFromRequest } from './approver-identity.js'
import { describeTradingMode, type TradingModePolicy } from '../../services/trading-mode.js'

// Total request timeout. UTA is on the loopback interface so connect is
// instant — this guards against handlers that legitimately take seconds
// (broker queries, contract searches) hanging Alice forever. 30s is
// well above the typical broker-API SLA without being a footgun.
const PROXY_TIMEOUT_MS = 30_000
const STATUS_TIMEOUT_MS = 1_000

/** Methods Hono's `app.all` actually dispatches. Empty body methods get a
 *  null body forwarded. */
const PASSTHROUGH_HEADERS: readonly string[] = [
  // Forward common identifying headers; strip hop-by-hop / Host so the UTA
  // sees its own host.
  'accept', 'accept-language', 'content-type', 'content-length',
  'user-agent', 'cache-control', 'pragma', 'x-request-id',
]

const APPROVER_HEADER = 'x-openalice-approver'

export function createTradingProxyRoutes(opts: {
  utaBaseUrl?: string
  disabledReason?: 'lite_mode'
  getPolicy?: () => TradingModePolicy
  internalToken?: string
}): Hono {
  const app = new Hono()
  const base = opts.utaBaseUrl?.replace(/\/$/, '')
  const internalToken = opts.internalToken
  const disabledReason = opts.disabledReason
  const getPolicy = opts.getPolicy ?? (() => ({
    mode: disabledReason === 'lite_mode' ? 'lite' : 'pro',
    source: disabledReason === 'lite_mode' ? 'env' : 'auto',
    envLocked: disabledReason === 'lite_mode',
    hasUTAConfig: false,
  }))

  app.get('/status', async (c) => {
    const policy = getPolicy()
    if (policy.mode === 'lite') {
      return c.json({
        available: false,
        state: 'unavailable',
        reason: 'lite_mode',
        mode: policy.mode,
        modeSource: policy.source,
        envLocked: policy.envLocked,
        hasUTAConfig: policy.hasUTAConfig,
        hint: describeTradingMode('lite'),
      })
    }
    if (!base) {
      return c.json({
        available: false,
        state: 'unavailable',
        reason: 'not_configured',
        mode: policy.mode,
        modeSource: policy.source,
        envLocked: policy.envLocked,
        hasUTAConfig: policy.hasUTAConfig,
        hint: 'Trading service is not configured.',
      })
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS)
    try {
      const res = await fetch(`${base}/__uta/health`, { signal: controller.signal })
      if (!res.ok) {
        return c.json({
          available: false,
          state: 'unavailable',
          reason: `health_${res.status}`,
          mode: policy.mode,
          modeSource: policy.source,
          envLocked: policy.envLocked,
          hasUTAConfig: policy.hasUTAConfig,
          hint: 'Trading service is not healthy.',
        })
      }
      const health = await res.json() as { startedAt?: string; utas?: number }
      return c.json({
        available: true,
        state: 'available',
        mode: policy.mode,
        modeSource: policy.source,
        envLocked: policy.envLocked,
        hasUTAConfig: policy.hasUTAConfig,
        hint: describeTradingMode(policy.mode),
        startedAt: health.startedAt,
        utas: health.utas ?? 0,
      })
    } catch (err) {
      return c.json({
        available: false,
        state: 'unavailable',
        reason: err instanceof Error ? err.message : String(err),
        mode: policy.mode,
        modeSource: policy.source,
        envLocked: policy.envLocked,
        hasUTAConfig: policy.hasUTAConfig,
        hint: 'Trading service is not reachable.',
      })
    } finally {
      clearTimeout(timer)
    }
  })

  app.all('*', async (c) => {
    const policy = getPolicy()
    if (policy.mode === 'lite') {
      return c.json({
        error: 'UTA disabled',
        detail: 'Trading mode is lite',
        hint: describeTradingMode('lite'),
      }, 503)
    }
    if (policy.mode === 'readonly' && await isVenueMutation(c)) {
      return c.json({
        error: 'Trading mode is readonly',
        detail: 'Venue-mutating broker writes are disabled in readonly mode',
        hint: describeTradingMode('readonly'),
      }, 403)
    }
    if (!base) {
      return c.json({
        error: 'UTA unavailable',
        detail: 'UTA URL is not configured',
        hint: 'Trading service is not reachable. Alice is running in lite mode.',
      }, 503)
    }
    const incoming = c.req.raw
    // Reconstruct target URL: Hono's `c.req.path` is the *full* path
    // including the mount prefix (`/api/trading/uta`, not `/uta`), so
    // we forward it as-is.
    const target = `${base}${c.req.path}${url(incoming).search}`

    const forwardHeaders = new Headers()
    for (const name of PASSTHROUGH_HEADERS) {
      const v = incoming.headers.get(name)
      if (v !== null) forwardHeaders.set(name, v)
    }
    const approver = await approverDescriptorFromRequest(c)
    if (approver) forwardHeaders.set(APPROVER_HEADER, JSON.stringify(approver))
    if (internalToken) forwardHeaders.set(UTA_INTERNAL_TOKEN_HEADER, internalToken)

    const controller = new AbortController()
    const connectTimer = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS)

    let upstream: Response
    try {
      upstream = await fetch(target, {
        method: incoming.method,
        headers: forwardHeaders,
        body: hasBody(incoming.method) ? incoming.body : null,
        // duplex required when streaming request body — Node fetch needs it
        // when body is a ReadableStream.
        ...(hasBody(incoming.method) ? { duplex: 'half' } : {}),
        signal: controller.signal,
        redirect: 'manual',
      } as RequestInit)
    } catch (err) {
      clearTimeout(connectTimer)
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({
        error: 'UTA unavailable',
        detail: msg,
        hint: 'Trading service is not reachable. Alice is running in lite mode.',
      }, 502)
    } finally {
      clearTimeout(connectTimer)
    }

    // Re-wrap with a fresh Headers object so downstream middleware (CORS,
    // etc.) can still mutate them. `fetch()` returns a Response whose
    // headers carry an immutable guard per the WHATWG spec — handing it
    // back as-is makes any later `headers.set(...)` throw.
    const headers = new Headers()
    upstream.headers.forEach((value, name) => { headers.set(name, value) })
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    })
  })

  return app
}

async function isVenueMutation(c: Context): Promise<boolean> {
  const m = c.req.method.toUpperCase()
  if (m === 'GET' || m === 'HEAD') return false
  const normalized = c.req.path.toLowerCase()
  if (normalized.includes('/emergency-stop')) {
    // Explicit no-cancel emergency stop only persists local HALT/audit state;
    // it is risk tightening, not a broker mutation. Missing/malformed bodies
    // fail closed because the UTA schema defaults cancelOrders to true.
    const body = await c.req.raw.clone().json().catch(() => null) as { cancelOrders?: unknown } | null
    return body?.cancelOrders !== false
  }
  return (
    normalized.includes('/wallet/push') ||
    normalized.includes('/wallet/place-order') ||
    normalized.includes('/wallet/close-position') ||
    normalized.includes('/wallet/cancel-order') ||
    normalized.includes('/flatten') ||
    normalized.includes('/simulate-price') ||
    normalized.startsWith('/api/simulator') ||
    normalized.startsWith('/simulator')
  )
}

function url(req: Request): URL {
  try { return new URL(req.url) } catch { return new URL('http://localhost/') }
}

async function approverDescriptorFromRequest(c: Context): Promise<{ via: 'alice-bff'; fingerprint: string } | null> {
  const fingerprint = await adminSessionFingerprintFromRequest(c)
  return fingerprint ? { via: 'alice-bff', fingerprint } : null
}

function hasBody(method: string): boolean {
  const m = method.toUpperCase()
  return m !== 'GET' && m !== 'HEAD'
}
