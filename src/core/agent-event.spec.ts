import { describe, it, expect } from 'vitest'
import { AgentEventSchemas, validateEventPayload } from './agent-event.js'
import type { AgentEventMap } from './agent-event.js'

// ==================== Schema Completeness ====================

describe('AgentEventSchemas', () => {
  const expectedTypes: (keyof AgentEventMap)[] = [
    'cron.fire',
    'message.received', 'message.sent',
    'trade.committed', 'trade.pushed', 'trade.executed', 'trade.rejected',
    'risk.state-changed', 'risk.emergency-stop', 'risk.flatten',
    'authz.level-changed',
    'agent.work.requested', 'agent.work.done', 'agent.work.skip', 'agent.work.error',
  ]

  it('should have a schema for every key in AgentEventMap', () => {
    for (const type of expectedTypes) {
      expect(AgentEventSchemas[type], `missing schema for "${type}"`).toBeDefined()
    }
  })

  it('should not have extra schemas beyond AgentEventMap', () => {
    const schemaKeys = Object.keys(AgentEventSchemas)
    expect(schemaKeys.sort()).toEqual([...expectedTypes].sort())
  })
})

// ==================== validateEventPayload ====================

describe('validateEventPayload', () => {
  // -- cron.fire --
  it('should accept valid cron.fire payload', () => {
    expect(() => validateEventPayload('cron.fire', {
      jobId: 'abc', jobName: 'test', payload: 'hello',
    })).not.toThrow()
  })

  it('should reject cron.fire with missing jobId', () => {
    expect(() => validateEventPayload('cron.fire', {
      jobName: 'test', payload: 'hello',
    })).toThrow(/Invalid payload.*cron\.fire/)
  })

  it('should reject cron.fire with wrong type (number instead of string)', () => {
    expect(() => validateEventPayload('cron.fire', {
      jobId: 123, jobName: 'test', payload: 'hello',
    })).toThrow(/Invalid payload.*cron\.fire/)
  })

  // -- message.received --
  it('should accept valid message.received payload', () => {
    expect(() => validateEventPayload('message.received', {
      channel: 'web', to: 'default', prompt: 'hello',
    })).not.toThrow()
  })

  // -- message.sent --
  it('should accept valid message.sent payload', () => {
    expect(() => validateEventPayload('message.sent', {
      channel: 'web', to: 'default', prompt: 'hello', reply: 'hi', durationMs: 300,
    })).not.toThrow()
  })

  it('should reject message.sent with missing reply', () => {
    expect(() => validateEventPayload('message.sent', {
      channel: 'web', to: 'default', prompt: 'hello', durationMs: 300,
    })).toThrow(/Invalid payload.*message\.sent/)
  })

  // -- trade / risk lifecycle --
  it('should accept valid trade.committed payload', () => {
    expect(() => validateEventPayload('trade.committed', {
      id: 'abc12345',
      accountId: 'mock-paper',
      operationCount: 1,
      operations: [{ action: 'placeOrder', symbol: 'AAPL', side: 'BUY', orderType: 'MKT', quantity: '1' }],
      thesis: { excerpt: 'buy AAPL', hash: '8f2f5c4b0c3e9d7a' },
    })).not.toThrow()
  })

  it('should accept valid trade.pushed payload with an empty guard list', () => {
    expect(() => validateEventPayload('trade.pushed', {
      id: 'abc12345',
      accountId: 'mock-paper',
      operationCount: 1,
      operations: [{ action: 'placeOrder', symbol: 'AAPL', status: 'filled' }],
      approver: { via: 'alice-bff', fingerprint: 'session:abc', at: '2026-07-05T00:00:00.000Z' },
      guards: [],
      guardSummary: { configured: [], evaluated: 0, passed: 0, rejected: 0, skipped: 0 },
      risk: { state: 'NORMAL' },
    })).not.toThrow()
  })

  it('should accept valid trade.executed payload', () => {
    expect(() => validateEventPayload('trade.executed', {
      id: 'abc12345:mock-ord-1',
      accountId: 'mock-paper',
      commitHash: 'abc12345',
      operation: { action: 'placeOrder', symbol: 'AAPL', status: 'filled' },
      orderId: 'mock-ord-1',
      status: 'filled',
      source: 'push',
    })).not.toThrow()
  })

  it('should accept valid trade.rejected payload with rejecting verdicts', () => {
    const guard = {
      operationIndex: 0,
      operationAction: 'placeOrder',
      symbol: 'AAPL',
      guard: 'max-position-size',
      verdict: 'reject',
      reason: 'too large',
    }
    expect(() => validateEventPayload('trade.rejected', {
      id: 'abc12345',
      accountId: 'mock-paper',
      operationCount: 1,
      operations: [{ action: 'placeOrder', symbol: 'AAPL', status: 'rejected', error: 'too large' }],
      reason: 'too large',
      guards: [guard],
      rejectingGuards: [guard],
      risk: { state: 'NORMAL' },
    })).not.toThrow()
  })

  it('should accept valid risk lifecycle payloads', () => {
    expect(() => validateEventPayload('risk.state-changed', {
      accountId: 'mock-paper',
      from: 'NORMAL',
      to: 'HALT',
      by: 'human',
      reason: 'manual stop',
      at: '2026-07-05T00:00:00.000Z',
      triggerIdentity: { via: 'loopback', at: '2026-07-05T00:00:00.000Z' },
    })).not.toThrow()

    expect(() => validateEventPayload('risk.emergency-stop', {
      accountId: 'mock-paper',
      hash: 'abc12345',
      reason: 'manual stop',
      cancelOrders: true,
      triggerIdentity: { via: 'loopback', at: '2026-07-05T00:00:00.000Z' },
      outcomes: [{ orderId: 'mock-ord-1', symbol: 'AAPL', success: true, status: 'Cancelled' }],
    })).not.toThrow()

    expect(() => validateEventPayload('risk.flatten', {
      accountId: 'mock-paper',
      hash: 'abc12345',
      triggerIdentity: { via: 'loopback', at: '2026-07-05T00:00:00.000Z' },
      outcomes: [{ symbol: 'AAPL', side: 'long', quantity: '1', success: true, orderId: 'mock-ord-2', status: 'Filled' }],
    })).not.toThrow()
  })

  it('should accept valid authz.level-changed payload', () => {
    expect(() => validateEventPayload('authz.level-changed', {
      scope: 'workspace',
      id: 'ws-1',
      from: 'read_only',
      to: 'paper',
      approver: { via: 'alice-bff', fingerprint: 'abcdef1234567890', at: '2026-07-06T00:00:00.000Z' },
    })).not.toThrow()
  })

  // -- agent.work.requested --
  it('should accept valid agent.work.requested payload', () => {
    expect(() => validateEventPayload('agent.work.requested', {
      source: 'task',
      prompt: 'investigate',
    })).not.toThrow()
  })

  it('should accept agent.work.requested with metadata', () => {
    expect(() => validateEventPayload('agent.work.requested', {
      source: 'cron',
      prompt: 'check market',
      metadata: { jobId: 'abc', jobName: 'daily' },
    })).not.toThrow()
  })

  it('should reject agent.work.requested with unknown source', () => {
    expect(() => validateEventPayload('agent.work.requested', {
      source: 'bogus',
      prompt: 'x',
    })).toThrow(/Invalid payload.*agent\.work\.requested/)
  })

  it('should reject agent.work.requested without prompt', () => {
    expect(() => validateEventPayload('agent.work.requested', {
      source: 'task',
    })).toThrow(/Invalid payload.*agent\.work\.requested/)
  })

  // -- agent.work.done --
  it('should accept valid agent.work.done payload', () => {
    expect(() => validateEventPayload('agent.work.done', {
      source: 'heartbeat',
      reply: 'BTC alert',
      durationMs: 200,
      delivered: true,
    })).not.toThrow()
  })

  it('should reject agent.work.done with missing delivered field', () => {
    expect(() => validateEventPayload('agent.work.done', {
      source: 'heartbeat',
      reply: 'x',
      durationMs: 100,
    })).toThrow(/Invalid payload.*agent\.work\.done/)
  })

  // -- agent.work.skip --
  it('should accept valid agent.work.skip payload', () => {
    expect(() => validateEventPayload('agent.work.skip', {
      source: 'heartbeat',
      reason: 'outside-active-hours',
    })).not.toThrow()
  })

  it('should accept agent.work.skip with arbitrary metadata', () => {
    expect(() => validateEventPayload('agent.work.skip', {
      source: 'heartbeat',
      reason: 'duplicate',
      metadata: { parsedReason: 'BTC alert (first 80 chars)' },
    })).not.toThrow()
  })

  // -- agent.work.error --
  it('should accept valid agent.work.error payload', () => {
    expect(() => validateEventPayload('agent.work.error', {
      source: 'cron',
      error: 'AI down',
      durationMs: 5,
    })).not.toThrow()
  })

  // -- unregistered types --
  it('should pass for unregistered event types', () => {
    expect(() => validateEventPayload('some.random.type', {
      anything: 'goes', here: 42,
    })).not.toThrow()
  })

  it('should pass for unregistered type with null payload', () => {
    expect(() => validateEventPayload('unknown.type', null)).not.toThrow()
  })

  // -- legacy types (now removed from internal map but accepted on webhook wire) --
  it('legacy task.requested type is no longer in AgentEventMap', () => {
    // The webhook layer handles wire-level legacy alias translation.
    // Validation against the canonical type happens after translation.
    expect(AgentEventSchemas).not.toHaveProperty('task.requested')
    expect(AgentEventSchemas).not.toHaveProperty('heartbeat.done')
    expect(AgentEventSchemas).not.toHaveProperty('cron.done')
  })
})
