/**
 * Webhook ingest auth helpers.
 *
 * Tokens live in `data/config/webhook.json`. Each request to
 * `POST /api/events/ingest` must present a valid token via either
 *   - `Authorization: Bearer <token>`, or
 *   - `X-OpenAlice-Token: <token>` (for webhook sources that don't
 *     support the Authorization header — some legacy platforms).
 *
 * Comparison is constant-time to avoid timing attacks on token guessing.
 * If no tokens are configured, the endpoint returns 503 rather than
 * silently accepting — default-deny.
 */

import { timingSafeEqual } from 'node:crypto'
import type { WebhookConfig, WebhookToken } from '../../core/config.js'

export type AuthResult =
  | { kind: 'ok'; tokenId: string }
  | { kind: 'unconfigured' }
  | { kind: 'missing' }
  | { kind: 'invalid' }

/** Read an auth token from request headers. Prefers Authorization: Bearer,
 *  falls back to X-OpenAlice-Token. Returns null if neither header is set. */
export function extractPresentedToken(headers: {
  authorization?: string | null
  'x-openalice-token'?: string | null
}): string | null {
  const auth = headers.authorization ?? ''
  const m = /^Bearer\s+(\S+)\s*$/i.exec(auth)
  if (m) return m[1]
  const alt = headers['x-openalice-token']
  if (alt && alt.length > 0) return alt
  return null
}

/** Check the presented token against the configured allowlist.
 *  Constant-time per candidate; short-circuits on first match. */
export function checkAuth(
  cfg: WebhookConfig,
  presented: string | null,
  additionalTokens: ReadonlyArray<Pick<WebhookToken, 'id' | 'token'>> = [],
): AuthResult {
  const tokens = [...cfg.tokens, ...additionalTokens]
  if (tokens.length === 0) return { kind: 'unconfigured' }
  if (presented == null || presented.length === 0) return { kind: 'missing' }

  const presentedBuf = Buffer.from(presented)
  for (const t of tokens) {
    if (matchesConstantTime(presentedBuf, t)) {
      return { kind: 'ok', tokenId: t.id }
    }
  }
  return { kind: 'invalid' }
}

function matchesConstantTime(presentedBuf: Buffer, candidate: Pick<WebhookToken, 'token'>): boolean {
  const candidateBuf = Buffer.from(candidate.token)
  // timingSafeEqual requires equal lengths — a length mismatch leaks only
  // the candidate length, which is not sensitive (fixed entropy budget).
  if (presentedBuf.length !== candidateBuf.length) return false
  return timingSafeEqual(presentedBuf, candidateBuf)
}
