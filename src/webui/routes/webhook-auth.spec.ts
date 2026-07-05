import { describe, it, expect } from 'vitest'
import { checkAuth, extractPresentedToken } from './webhook-auth.js'
import type { WebhookConfig } from '../../core/config.js'

function cfg(tokens: Array<{ id: string; token: string }>): WebhookConfig {
  return {
    tokens: tokens.map((t) => ({ ...t, createdAt: 0 })),
  }
}

describe('extractPresentedToken', () => {
  it('prefers Authorization: Bearer <token>', () => {
    expect(
      extractPresentedToken({ authorization: 'Bearer abc123' }),
    ).toBe('abc123')
  })

  it('is case-insensitive on the Bearer prefix', () => {
    expect(extractPresentedToken({ authorization: 'bearer abc' })).toBe('abc')
    expect(extractPresentedToken({ authorization: 'BEARER abc' })).toBe('abc')
  })

  it('falls back to X-OpenAlice-Token if Authorization is absent', () => {
    expect(
      extractPresentedToken({ 'x-openalice-token': 'alt-token' }),
    ).toBe('alt-token')
  })

  it('returns null when neither header is set', () => {
    expect(extractPresentedToken({})).toBeNull()
    expect(extractPresentedToken({ authorization: null })).toBeNull()
    expect(
      extractPresentedToken({ authorization: null, 'x-openalice-token': null }),
    ).toBeNull()
  })

  it('returns null when Authorization is present but not Bearer', () => {
    // No X-OpenAlice-Token fallback → null.
    expect(
      extractPresentedToken({ authorization: 'Basic dXNlcjpwYXNz' }),
    ).toBeNull()
  })

  it('rejects Authorization with no token body', () => {
    expect(extractPresentedToken({ authorization: 'Bearer ' })).toBeNull()
    expect(extractPresentedToken({ authorization: 'Bearer' })).toBeNull()
  })
})

describe('checkAuth', () => {
  it('returns unconfigured when no tokens are set', () => {
    expect(checkAuth(cfg([]), 'any-token')).toEqual({ kind: 'unconfigured' })
  })

  it('returns missing when no token is presented', () => {
    expect(checkAuth(cfg([{ id: 'dev', token: 's3cret' }]), null))
      .toEqual({ kind: 'missing' })
    expect(checkAuth(cfg([{ id: 'dev', token: 's3cret' }]), ''))
      .toEqual({ kind: 'missing' })
  })

  it('returns invalid for a wrong token', () => {
    expect(
      checkAuth(cfg([{ id: 'dev', token: 's3cret' }]), 'guess'),
    ).toEqual({ kind: 'invalid' })
  })

  it('returns ok with tokenId on exact match', () => {
    expect(
      checkAuth(cfg([{ id: 'dev', token: 's3cret' }]), 's3cret'),
    ).toEqual({ kind: 'ok', tokenId: 'dev' })
  })

  it('matches additional runtime tokens', () => {
    expect(
      checkAuth(cfg([]), 'internal', [{ id: 'internal-uta-events', token: 'internal' }]),
    ).toEqual({ kind: 'ok', tokenId: 'internal-uta-events' })
  })

  it('matches against any entry in a multi-token list', () => {
    const c = cfg([
      { id: 'old', token: 'old-token' },
      { id: 'new', token: 'new-token' },
    ])
    expect(checkAuth(c, 'old-token').kind).toBe('ok')
    expect(checkAuth(c, 'new-token').kind).toBe('ok')
  })

  it('rejects a token with correct prefix but wrong length', () => {
    expect(
      checkAuth(cfg([{ id: 'dev', token: 's3cret' }]), 's3cretX'),
    ).toEqual({ kind: 'invalid' })
    expect(
      checkAuth(cfg([{ id: 'dev', token: 's3cret' }]), 's3cre'),
    ).toEqual({ kind: 'invalid' })
  })

  it('is case-sensitive on the token value', () => {
    expect(
      checkAuth(cfg([{ id: 'dev', token: 'S3CRET' }]), 's3cret'),
    ).toEqual({ kind: 'invalid' })
  })
})
