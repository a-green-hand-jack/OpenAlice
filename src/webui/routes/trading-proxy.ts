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

// Total request timeout. UTA is on the loopback interface so connect is
// instant — this guards against handlers that legitimately take seconds
// (broker queries, contract searches) hanging Alice forever. 30s is
// well above the typical broker-API SLA without being a footgun.
const PROXY_TIMEOUT_MS = 30_000

/** Methods Hono's `app.all` actually dispatches. Empty body methods get a
 *  null body forwarded. */
const PASSTHROUGH_HEADERS: readonly string[] = [
  // Forward common identifying headers; strip hop-by-hop / Host so the UTA
  // sees its own host.
  'accept', 'accept-language', 'content-type', 'content-length',
  'user-agent', 'cache-control', 'pragma', 'x-request-id',
]

const APPROVER_HEADER = 'x-openalice-approver'

export function createTradingProxyRoutes(opts: { utaBaseUrl: string; internalToken?: string }): Hono {
  const app = new Hono()
  const base = opts.utaBaseUrl.replace(/\/$/, '')
  const internalToken = opts.internalToken

  app.all('*', async (c) => {
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
        hint: 'Trading service is not reachable. Check Guardian / UTA process.',
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
