import { createHash } from 'node:crypto'
import { UNSET_DECIMAL } from '@traderalice/ibkr'
import {
  validateEventPayload,
  type AgentEventMap,
  type TradeEventGuardSummary,
  type TradeEventGuardVerdict,
  type TradeEventOperationSummary,
  type TradeEventRiskSnapshot,
} from '@/core/agent-event.js'
import type { RiskStateInfo } from '@traderalice/uta-protocol'
import type { GuardVerdict, Operation, OperationResult } from './git/types.js'

export type UtaLifecycleEventType =
  | 'trade.committed'
  | 'trade.pushed'
  | 'trade.executed'
  | 'trade.rejected'
  | 'risk.state-changed'
  | 'risk.emergency-stop'
  | 'risk.flatten'

export interface UtaEventSink {
  emit<K extends UtaLifecycleEventType>(type: K, payload: AgentEventMap[K]): void
  flush(): Promise<void>
  close(): Promise<void>
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

export interface UtaHttpEventSinkOptions {
  ingestUrl?: string
  token?: string
  timeoutMs?: number
  fetchImpl?: FetchLike
  log?: Pick<Console, 'error'>
}

export function createNoopUtaEventSink(): UtaEventSink {
  return {
    emit() {},
    async flush() {},
    async close() {},
  }
}

export function createUtaHttpEventSink(options: UtaHttpEventSinkOptions): UtaEventSink {
  const ingestUrl = options.ingestUrl
  const token = options.token
  const timeoutMs = options.timeoutMs ?? 750
  const fetchImpl = options.fetchImpl ?? fetch
  const log = options.log ?? console
  let chain = Promise.resolve()
  let closed = false

  function emit<K extends UtaLifecycleEventType>(type: K, payload: AgentEventMap[K]): void {
    if (closed) return
    try {
      validateEventPayload(type, payload)
    } catch (err) {
      log.error(`[uta-events] dropped invalid ${type} event: ${err instanceof Error ? err.message : String(err)}`)
      return
    }

    if (!ingestUrl || !token) {
      log.error(`[uta-events] dropped ${type} event: OPENALICE_EVENT_INGEST_URL or OPENALICE_EVENT_INGEST_TOKEN is not configured`)
      return
    }

    const task = async () => {
      try {
        const res = await fetchImpl(ingestUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ type, payload }),
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (!res.ok) {
          const body = await res.text().catch(() => '')
          log.error(`[uta-events] dropped ${type} event: Alice ingest returned ${res.status}${body ? ` ${body}` : ''}`)
        }
      } catch (err) {
        log.error(`[uta-events] dropped ${type} event: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    chain = chain.then(task, task)
  }

  return {
    emit,
    async flush() {
      await chain
    },
    async close() {
      closed = true
      await chain
    },
  }
}

export function createUtaEventSinkFromEnv(env: NodeJS.ProcessEnv = process.env): UtaEventSink {
  const ingestUrl = env['OPENALICE_EVENT_INGEST_URL']
    ?? (env['OPENALICE_WEB_PORT']
      ? `http://127.0.0.1:${env['OPENALICE_WEB_PORT']}/api/events/ingest`
      : undefined)
  const token = env['OPENALICE_EVENT_INGEST_TOKEN'] ?? env['OPENALICE_INTERNAL_EVENT_TOKEN']
  return createUtaHttpEventSink({ ingestUrl, token })
}

export function buildTradeThesis(message: string): { excerpt: string; hash: string } {
  return {
    excerpt: message.length > 240 ? `${message.slice(0, 237)}...` : message,
    hash: createHash('sha256').update(message).digest('hex').slice(0, 16),
  }
}

export function summarizeOperations(
  operations: readonly Operation[],
  results: readonly OperationResult[] = [],
): TradeEventOperationSummary[] {
  return operations.map((op, index) => {
    const result = results[index]
    return {
      ...summarizeOperation(op),
      ...(result?.orderId ? { orderId: result.orderId } : {}),
      ...(result?.status ? { status: result.status } : {}),
      ...(result?.error ? { error: result.error } : {}),
    }
  })
}

export function summarizeOperation(op: Operation): TradeEventOperationSummary {
  switch (op.action) {
    case 'placeOrder':
    case 'observeExternalOrder':
      return {
        action: op.action,
        symbol: symbolForOperation(op),
        ...(op.order.action ? { side: op.order.action } : {}),
        ...(op.order.orderType ? { orderType: op.order.orderType } : {}),
        ...optionalString('quantity', decimalField(op.order.totalQuantity)),
        ...optionalString('cashQuantity', decimalField(op.order.cashQty)),
        ...optionalString('price', decimalField(op.order.lmtPrice) ?? decimalField(op.order.auxPrice)),
      }
    case 'closePosition':
      return {
        action: op.action,
        symbol: symbolForOperation(op),
        ...optionalString('quantity', op.quantity?.toFixed()),
      }
    case 'modifyOrder':
      return {
        action: op.action,
        symbol: op.orderId,
        orderId: op.orderId,
        ...optionalString('quantity', decimalField(op.changes.totalQuantity)),
        ...optionalString('price', decimalField(op.changes.lmtPrice) ?? decimalField(op.changes.auxPrice)),
      }
    case 'cancelOrder':
      return {
        action: op.action,
        symbol: op.orderId,
        orderId: op.orderId,
      }
    case 'emergencyCancelOrder':
      return {
        action: op.action,
        symbol: symbolForOperation(op),
        orderId: op.orderId,
      }
    case 'emergencyClosePosition':
      return {
        action: op.action,
        symbol: symbolForOperation(op),
        quantity: op.quantity.toFixed(),
      }
    case 'syncOrders':
      return { action: op.action, symbol: 'orders' }
    case 'reconcileBalance':
      return {
        action: op.action,
        symbol: op.aliceId,
        quantity: op.quantityDelta,
        price: op.markPrice,
      }
  }
}

export function collectGuardVerdicts(
  operations: readonly Operation[],
  results: readonly OperationResult[],
): TradeEventGuardVerdict[] {
  const out: TradeEventGuardVerdict[] = []
  results.forEach((result, index) => {
    const op = operations[index] ?? operations[0]
    const symbol = op ? symbolForOperation(op) : 'unknown'
    for (const verdict of result.guardVerdicts ?? []) {
      out.push(projectGuardVerdict(verdict, index, result.action, symbol))
    }
  })
  return out
}

export function buildGuardSummary(
  configured: readonly string[],
  guards: readonly TradeEventGuardVerdict[],
): TradeEventGuardSummary {
  return {
    configured: [...configured],
    evaluated: guards.length,
    passed: guards.filter((g) => g.verdict === 'pass').length,
    rejected: guards.filter((g) => g.verdict === 'reject').length,
    skipped: guards.filter((g) => g.verdict === 'skipped').length,
  }
}

export function riskSnapshot(info: RiskStateInfo): TradeEventRiskSnapshot {
  return {
    state: info.state,
    ...(info.reason ? { reason: info.reason } : {}),
    ...(info.updatedAt ? { updatedAt: info.updatedAt } : {}),
    ...(info.metrics ? { metrics: info.metrics } : {}),
  }
}

function projectGuardVerdict(
  verdict: GuardVerdict,
  operationIndex: number,
  operationAction: string,
  symbol: string,
): TradeEventGuardVerdict {
  return {
    operationIndex,
    operationAction,
    symbol,
    guard: verdict.guard,
    verdict: verdict.verdict,
    ...(verdict.reason ? { reason: verdict.reason } : {}),
    ...(verdict.metrics ? { metrics: verdict.metrics } : {}),
  }
}

function symbolForOperation(op: Operation): string {
  switch (op.action) {
    case 'placeOrder':
    case 'closePosition':
    case 'observeExternalOrder':
    case 'emergencyCancelOrder':
    case 'emergencyClosePosition':
      return op.contract.symbol || op.contract.localSymbol || op.contract.aliceId || 'unknown'
    case 'modifyOrder':
    case 'cancelOrder':
      return op.orderId
    case 'reconcileBalance':
      return op.aliceId
    case 'syncOrders':
      return 'orders'
  }
}

function decimalField(value: unknown): string | undefined {
  if (!value) return undefined
  const maybe = value as {
    equals?: (other: unknown) => boolean
    toFixed?: () => string
    toString?: () => string
  }
  try {
    if (maybe.equals?.(UNSET_DECIMAL)) return undefined
  } catch { /* ignore sentinel comparison failures */ }
  if (typeof maybe.toFixed === 'function') return maybe.toFixed()
  if (typeof maybe.toString === 'function') return maybe.toString()
  return undefined
}

function optionalString<K extends string>(key: K, value: string | undefined): { [P in K]?: string } {
  return value ? { [key]: value } as { [P in K]?: string } : {}
}
