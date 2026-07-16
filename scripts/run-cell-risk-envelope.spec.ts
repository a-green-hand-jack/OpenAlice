import { describe, expect, it } from 'vitest'

import { riskEnvelopeSchema } from '@traderalice/uta-protocol'

import {
  accountAuthzSnapshotFromConfig,
  isTradingToolVisibleAtAuthzLevel,
  resolveWorkspaceToolAuthzLevel,
} from '@/core/workspace-tool-center.js'

import { buildCampaignRiskEnvelope } from '../tools/campaigns/_lib.mjs'

/**
 * Regression spec for issue #253: `tools/campaigns/run-cell.mjs` created a
 * mock-simulator UTA account and lifted `maxAuthzLevel` to `'paper'`, but
 * never provisioned the mandatory Risk Envelope (migration 0012). A
 * missing/invalid envelope absorbs effective authz to `read_only`
 * (`packages/uta-protocol/src/types/authz.ts` `resolveEffectiveAuthzLevel`),
 * so every mutation tool (placeOrder/tradingCommit/…, all gated at `paper`
 * via `TRADING_TOOL_MIN_AUTHZ_LEVEL`) stayed hidden from campaign steward
 * workspaces regardless of the account/workspace authz lift.
 */
describe('run-cell.mjs risk envelope provisioning (issue #253)', () => {
  const codename = 'ASSET-A'

  it('produces a payload that parses under the real risk envelope schema', () => {
    const envelope = buildCampaignRiskEnvelope(codename, { maxDdPct: 10, maxPosPct: 60 })
    const result = riskEnvelopeSchema.safeParse(envelope)
    expect(result.success).toBe(true)
  })

  it('sets autonomyCeiling to paper and scopes a whitelist to the cell codename', () => {
    const envelope = buildCampaignRiskEnvelope(codename, { maxDdPct: 10, maxPosPct: 60 })
    expect(envelope.autonomyCeiling).toBe('paper')
    expect(envelope.scope.kind).toBe('whitelist')
    expect(envelope.scope.symbols).toContain(codename)
  })

  it('lets an account with this envelope + maxAuthzLevel paper reach effective paper authz, unhiding placeOrder', () => {
    const envelope = buildCampaignRiskEnvelope(codename, { maxDdPct: 10, maxPosPct: 60 })
    const snapshot = accountAuthzSnapshotFromConfig({
      id: 'campaign-mock',
      presetId: 'mock-simulator',
      presetConfig: {},
      maxAuthzLevel: 'paper',
      riskEnvelope: envelope,
    })

    const level = resolveWorkspaceToolAuthzLevel({
      workspaceAuthzLevel: 'paper',
      accounts: [snapshot],
    })

    expect(level).toBe('paper')
    expect(isTradingToolVisibleAtAuthzLevel('placeOrder', level)).toBe(true)
  })

  it('pins the exact failure mode: without an envelope, effective authz absorbs to read_only and placeOrder stays hidden', () => {
    const snapshot = accountAuthzSnapshotFromConfig({
      id: 'campaign-mock',
      presetId: 'mock-simulator',
      presetConfig: {},
      maxAuthzLevel: 'paper',
      riskEnvelope: null,
    })

    const level = resolveWorkspaceToolAuthzLevel({
      workspaceAuthzLevel: 'paper',
      accounts: [snapshot],
    })

    expect(level).toBe('read_only')
    expect(isTradingToolVisibleAtAuthzLevel('placeOrder', level)).toBe(false)
  })
})
