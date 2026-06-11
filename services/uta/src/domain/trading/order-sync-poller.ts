/**
 * Order-sync poller — the missing "成交感知" loop.
 *
 * Trading-as-Git records a pushed order as `submitted` and relies on
 * `UnifiedTradingAccount.sync()` to learn about fills/cancels later. Until
 * this poller, NOTHING called sync automatically: the manual HTTP route and
 * the AI tool were the only triggers, so limit orders stayed `submitted` in
 * git forever unless someone asked. This loop closes the state machine:
 *
 *   place → approve (push) → [poller: poll broker until terminal] → sync
 *   commit records filled/cancelled + execution qty/price.
 *
 * Cost discipline: each tick scans pending order ids from the in-memory git
 * log (cheap, no I/O). Broker round-trips happen ONLY for healthy accounts
 * that actually have pending orders — an idle book costs nothing.
 */

import type { UnifiedTradingAccount } from './UnifiedTradingAccount.js'

export interface OrderSyncPollerOptions {
  /** Poll cadence. Default 10s — fast enough for human-scale awareness,
   *  far below any exchange rate limit given the pending-only gating. */
  intervalMs?: number
  log?: (msg: string) => void
}

export interface OrderSyncPoller {
  /** Run one pass immediately (also used by tests). */
  tick(): Promise<void>
  stop(): void
}

export function startOrderSyncPoller(
  getInstances: () => Iterable<UnifiedTradingAccount>,
  options: OrderSyncPollerOptions = {},
): OrderSyncPoller {
  const intervalMs = options.intervalMs ?? 10_000
  const log = options.log ?? ((msg: string) => console.log(msg))
  let running = false

  const tick = async (): Promise<void> => {
    // Re-entrancy guard: a slow broker must not stack concurrent passes.
    if (running) return
    running = true
    try {
      for (const uta of getInstances()) {
        if (uta.keyless || uta.health !== 'healthy') continue
        if (uta.getPendingOrderIds().length === 0) continue
        try {
          const result = await uta.sync()
          if (result.updatedCount > 0) {
            const summary = result.updates
              .map((u) => `${u.symbol ?? u.orderId}→${u.currentStatus}`)
              .join(', ')
            log(`[order-sync] ${uta.id}: ${result.updatedCount} order(s) updated (${summary})`)
          }
        } catch (err) {
          // Loud but non-fatal: one broker's bad day must not stop fill
          // detection for the others. Health tracking already escalates
          // repeated failures on the account itself.
          log(`[order-sync] ${uta.id}: sync failed — ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    } finally {
      running = false
    }
  }

  const timer = setInterval(() => { void tick() }, intervalMs)
  timer.unref?.()

  return {
    tick,
    stop: () => clearInterval(timer),
  }
}
