import { timingSafeEqual } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'
import { UTA_INTERNAL_TOKEN_HEADER } from '@traderalice/uta-protocol'

export const UTA_INTERNAL_TOKEN_ENV = 'OPENALICE_UTA_INTERNAL_TOKEN'
export const UTA_AUTH_UNCONFIGURED_ERROR = 'UTA trading surface auth not configured (OPENALICE_UTA_INTERNAL_TOKEN missing)'
export const UTA_AUTH_UNAUTHORIZED_ERROR = 'Unauthorized: missing/invalid internal token'

export function createUtaInternalAuth(): MiddlewareHandler {
  const expectedToken = process.env[UTA_INTERNAL_TOKEN_ENV]
  if (!expectedToken) {
    console.error(`[uta] ${UTA_AUTH_UNCONFIGURED_ERROR}; refusing /api/trading/* and /api/simulator/*`)
  }

  return async (c, next) => {
    if (!expectedToken) {
      return c.json({ error: UTA_AUTH_UNCONFIGURED_ERROR }, 503)
    }

    const presented = c.req.header(UTA_INTERNAL_TOKEN_HEADER)
    if (!presented || !tokensEqual(presented, expectedToken)) {
      return c.json({ error: UTA_AUTH_UNAUTHORIZED_ERROR }, 401)
    }

    await next()
  }
}

function tokensEqual(presented: string, expected: string): boolean {
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
