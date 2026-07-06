import { createHash } from 'node:crypto'
import type { Context } from 'hono'
import { listSessions, type SessionRecord } from '@/services/auth/index.js'
import { SESSION_COOKIE_NAME } from '../middleware/auth.js'

export interface AliceApproverIdentity {
  via: 'alice-bff' | 'loopback'
  fingerprint?: string
  at: string
}

export function adminSessionFingerprint(sid: string): string {
  return createHash('sha256')
    .update(`openalice-admin-session:${sid}`)
    .digest('hex')
    .slice(0, 16)
}

export async function approverFromAliceRequest(c: Context): Promise<AliceApproverIdentity> {
  const fingerprint = await adminSessionFingerprintFromRequest(c)
  const at = new Date().toISOString()
  return fingerprint ? { via: 'alice-bff', fingerprint, at } : { via: 'loopback', at }
}

export async function adminSessionFingerprintFromRequest(c: Context): Promise<string | null> {
  const attached = fingerprintFromSession((c as unknown as { get: (key: string) => unknown }).get('session'))
  if (attached) return attached

  const sid = readSessionCookie(c.req.header('cookie') ?? '')
  if (!sid) return null

  const session = await findValidSession(sid)
  return fingerprintFromSession(session)
}

function fingerprintFromSession(session: unknown): string | null {
  if (!session || typeof session !== 'object') return null
  const sid = (session as Partial<SessionRecord>).sid
  return sid ? adminSessionFingerprint(sid) : null
}

async function findValidSession(sid: string): Promise<SessionRecord | null> {
  try {
    const session = (await listSessions()).find((s) => s.sid === sid)
    if (!session) return null
    const expiresAt = new Date(session.expiresAt).getTime()
    if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return null
    return session
  } catch {
    return null
  }
}

function readSessionCookie(cookieHeader: string): string | null {
  if (!cookieHeader) return null
  for (const raw of cookieHeader.split(';')) {
    const entry = raw.trim()
    const eq = entry.indexOf('=')
    if (eq < 0) continue
    const name = entry.slice(0, eq)
    if (name !== SESSION_COOKIE_NAME) continue
    const value = entry.slice(eq + 1).trim()
    if (value.length === 0) return null
    try {
      return decodeURIComponent(value)
    } catch {
      return null
    }
  }
  return null
}
