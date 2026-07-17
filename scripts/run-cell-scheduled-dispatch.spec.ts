import { describe, expect, it } from 'vitest'

import { parseIssueContent } from '@/workspaces/issues/declaration.js'

import { buildCampaignMandate, buildCampaignRiskEnvelope, buildScheduledStewardIssue } from '../tools/campaigns/_lib.mjs'

const mandate = buildCampaignMandate({
  mandateId: 'root-264-run-1',
  entrustedUnitId: 'trading-team-v1',
  accountId: 'mock-1',
  capital: { currency: 'USD', limit: '100000' },
  scope: ['ASSET-A'],
  validFrom: '2026-07-16T20:00:00.000Z',
  validUntil: '2026-07-17T20:00:00.000Z',
  heartbeat: { intervalMs: 900_000, graceMs: 120_000 },
  riskEnvelope: buildCampaignRiskEnvelope('ASSET-A'),
})

describe('run-cell scheduled dispatch declaration (issue #263 S3)', () => {
  it('writes the scanner-owned one-shot steward-wake shape with arbitrary context encoded safely', () => {
    const raw = buildScheduledStewardIssue({
      issueId: 'campaign-a-w1',
      at: '2026-07-16T20:30:01.000Z',
      accountId: 'mock-1',
      deadlineMs: 120_000,
      agent: 'codex',
      marketContext: { instrument: 'ASSET-A', bars: [{ day: 0, close: 100 }], note: 'price: anonymous' },
      riskContext: { note: 'weekly observation' },
      mandate,
    })

    const parsed = parseIssueContent('campaign-a-w1', raw)
    expect(parsed).toEqual(expect.objectContaining({ ok: true }))
    if (!parsed.ok) return
    expect(parsed.issue).toMatchObject({
      id: 'campaign-a-w1',
      when: { kind: 'at', at: '2026-07-16T20:30:01.000Z' },
      kind: 'steward-wake',
      accountId: 'mock-1',
      authzLevel: 'paper',
      expectedDecision: 'no_trade',
      wakeReason: 'scheduled_observe',
      deadlineMs: 120_000,
      agent: 'codex',
      marketContext: { instrument: 'ASSET-A', bars: [{ day: 0, close: 100 }], note: 'price: anonymous' },
      riskContext: { note: 'weekly observation' },
      mandate,
    })
  })

  it('rejects a traversal-like issue id before run-cell can write its declaration', () => {
    expect(() => buildScheduledStewardIssue({
      issueId: '../escape-w1',
      at: '2026-07-16T20:30:01.000Z',
      accountId: 'mock-1',
      deadlineMs: 120_000,
      agent: 'codex',
      marketContext: {},
      riskContext: {},
      mandate,
    })).toThrow(/safe run-id component/)
  })
})
