import { describe, expect, it } from 'vitest'

import { riskEnvelopeSchema } from '@traderalice/uta-protocol'

import {
  accountAuthzSnapshotFromConfig,
  isTradingToolVisibleAtAuthzLevel,
  resolveWorkspaceToolAuthzLevel,
} from '@/core/workspace-tool-center.js'

import { buildCampaignAccountCreatePayload, buildCampaignRiskEnvelope } from '../tools/campaigns/_lib.mjs'

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

  /**
   * Review follow-up (PR for issue #253): the specs above only exercise the
   * pure `buildCampaignRiskEnvelope` builder — nothing asserted that
   * run-cell.mjs actually SENDS the envelope on the account-create POST
   * body. If someone drops the `riskEnvelope` field from that body (or the
   * `buildCampaignRiskEnvelope` call feeding it), these specs would stay
   * green while bug #253 silently returns. `buildCampaignAccountCreatePayload`
   * is the exact object run-cell.mjs POSTs to `/api/trading/config/uta`, so
   * asserting on it here pins the create-payload shape, not just the
   * envelope in isolation.
   */
  it('includes a schema-valid riskEnvelope on the account-create payload run-cell.mjs actually sends', () => {
    const runId = 'chop-20260101-000000'
    const payload = buildCampaignAccountCreatePayload(codename, runId, { maxDdPct: 10, maxPosPct: 60 })

    expect(payload.riskEnvelope).toBeDefined()
    const result = riskEnvelopeSchema.safeParse(payload.riskEnvelope)
    expect(result.success).toBe(true)

    expect(payload.riskEnvelope.autonomyCeiling).toBe('paper')
    expect(payload.riskEnvelope.scope.kind).toBe('whitelist')
    expect(payload.riskEnvelope.scope.symbols).toContain(codename)

    // Same object `buildCampaignRiskEnvelope` alone would have produced —
    // pins that the create payload doesn't drift from the standalone builder.
    expect(payload.riskEnvelope).toEqual(buildCampaignRiskEnvelope(codename, { maxDdPct: 10, maxPosPct: 60 }))
  })
})
