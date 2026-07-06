import { describe, expect, it } from 'vitest'

import {
  AUTHZ_LEVEL_RANK,
  isAuthzLevelAllowedForAccountType,
  maxAuthzLevel,
  resolveAuthzAccountType,
  resolveEffectiveAuthzLevel,
} from './authz.js'

describe('authz level ordering', () => {
  it('orders the Steward levels from read_only up to limited_autonomy', () => {
    expect(AUTHZ_LEVEL_RANK).toEqual({
      read_only: 0,
      paper: 1,
      small_live: 2,
      limited_autonomy: 3,
    })
  })

  it('resolves missing account and workspace levels to read_only', () => {
    expect(resolveEffectiveAuthzLevel({})).toBe('read_only')
  })

  it('uses min(account ceiling, workspace level)', () => {
    expect(resolveEffectiveAuthzLevel({
      accountMaxAuthzLevel: 'small_live',
      workspaceAuthzLevel: 'paper',
    })).toBe('paper')
  })

  it('caps a workspace level above the account ceiling', () => {
    expect(resolveEffectiveAuthzLevel({
      accountMaxAuthzLevel: 'small_live',
      workspaceAuthzLevel: 'limited_autonomy',
    })).toBe('small_live')
  })

  it('keeps the account-type gate expressible for paper/mock-only paper authz', () => {
    expect(isAuthzLevelAllowedForAccountType('paper', 'paper')).toBe(true)
    expect(isAuthzLevelAllowedForAccountType('paper', 'mock')).toBe(true)
    expect(isAuthzLevelAllowedForAccountType('paper', 'live')).toBe(false)
    expect(isAuthzLevelAllowedForAccountType('small_live', 'live')).toBe(true)
  })

  it('derives authz account type from broker preset identity', () => {
    expect(resolveAuthzAccountType({ presetId: 'mock-simulator', presetConfig: {} })).toBe('mock')
    expect(resolveAuthzAccountType({ presetId: 'alpaca', presetConfig: { mode: 'paper' } })).toBe('paper')
    expect(resolveAuthzAccountType({ presetId: 'okx', presetConfig: { mode: 'live' } })).toBe('live')
    expect(resolveAuthzAccountType({ presetId: 'missing', presetConfig: {} })).toBe('unknown')
  })

  it('can conservatively collapse multiple account ceilings for a workspace catalog', () => {
    expect(maxAuthzLevel([])).toBe('read_only')
    expect(maxAuthzLevel(['read_only', 'paper', 'small_live'])).toBe('small_live')
  })
})
