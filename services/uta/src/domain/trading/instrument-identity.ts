import type { Contract } from '@traderalice/ibkr'
import type { IBroker, OpenOrder } from './brokers/types.js'
import type { Operation } from './git/types.js'

export interface CanonicalInstrumentIdentity {
  readonly canonicalId: string
  readonly nativeKey: string
  readonly contract: Contract
}

export interface CanonicalOperationIdentity {
  readonly operation: Operation
  readonly canonicalInstrumentId?: string
}

export class InstrumentIdentityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InstrumentIdentityError'
  }
}

/** Resolve an account-scoped instrument reference through the broker's own
 * native-key codec. Envelope entries may be normalized; dispatch requests may
 * not silently change identity between the caller and the venue. */
export function resolveCanonicalInstrumentIdentity(
  broker: IBroker,
  reference: string,
  options: { allowNormalization: boolean; requireTradeableContract?: boolean },
): CanonicalInstrumentIdentity {
  const requested = reference.trim()
  if (!requested) throw new InstrumentIdentityError('Instrument identity is empty.')

  const separator = requested.indexOf('|')
  const requestedAccountId = separator === -1 ? broker.id : requested.slice(0, separator)
  const requestedNativeKey = separator === -1 ? requested : requested.slice(separator + 1)
  if (requestedAccountId !== broker.id) {
    throw new InstrumentIdentityError(
      `Instrument identity "${requested}" belongs to account "${requestedAccountId}", not "${broker.id}".`,
    )
  }
  if (!requestedNativeKey) {
    throw new InstrumentIdentityError(`Instrument identity "${requested}" has an empty broker-native key.`)
  }

  let contract: Contract
  try {
    contract = broker.resolveNativeKey(requestedNativeKey)
  } catch (error) {
    throw new InstrumentIdentityError(
      `Instrument identity "${requested}" cannot be resolved by account "${broker.id}": ${errorMessage(error)}`,
    )
  }

  let canonicalNativeKey: string
  try {
    canonicalNativeKey = broker.getNativeKey(contract).trim()
  } catch (error) {
    throw new InstrumentIdentityError(
      `Instrument identity "${requested}" has no broker dispatch identity: ${errorMessage(error)}`,
    )
  }
  if (!canonicalNativeKey || (options.requireTradeableContract !== false && !isTradeResolvable(contract))) {
    throw new InstrumentIdentityError(
      `Instrument identity "${requested}" did not resolve to a tradeable broker contract.`,
    )
  }
  if (!options.allowNormalization && canonicalNativeKey !== requestedNativeKey) {
    throw new InstrumentIdentityError(
      `Requested instrument "${requestedNativeKey}" resolves to broker dispatch identity "${canonicalNativeKey}"; refusing identity drift.`,
    )
  }

  const canonicalId = `${broker.id}|${canonicalNativeKey}`
  contract.aliceId = canonicalId
  return { canonicalId, nativeKey: canonicalNativeKey, contract }
}

/** Resolve the exact instrument a guarded broker mutation would trade. */
export function resolveCanonicalOperationIdentity(
  broker: IBroker,
  operation: Operation,
  orders?: readonly OpenOrder[],
): CanonicalOperationIdentity {
  if (operation.action === 'cancelOrder') return { operation }

  if (operation.action === 'modifyOrder') {
    const openOrder = orders?.find((candidate) => {
      const id = candidate.orderId ?? candidate.order.orderId
      return id != null && String(id) === operation.orderId
    })
    if (!openOrder) {
      throw new InstrumentIdentityError(
        `Cannot resolve authoritative open-order contract for modifyOrder ${operation.orderId}.`,
      )
    }
    const nativeKey = broker.getNativeKey(openOrder.contract).trim()
    if (!nativeKey) {
      throw new InstrumentIdentityError(
        `Open order ${operation.orderId} has no broker dispatch identity.`,
      )
    }
    const identity = resolveCanonicalInstrumentIdentity(broker, nativeKey, { allowNormalization: true })
    return { operation, canonicalInstrumentId: identity.canonicalId }
  }

  if (operation.action !== 'placeOrder' && operation.action !== 'closePosition') {
    throw new InstrumentIdentityError(
      `Cannot resolve instrument identity for guarded operation ${operation.action}.`,
    )
  }

  const requested = operation.contract.aliceId
  if (!requested) {
    throw new InstrumentIdentityError(
      `${operation.action} is missing the account-bound aliceId used for broker dispatch.`,
    )
  }
  const identity = resolveCanonicalInstrumentIdentity(broker, requested, { allowNormalization: false })
  assertCallerIdentityMatches(operation.contract, identity.contract, requested)

  return {
    operation: { ...operation, contract: identity.contract },
    canonicalInstrumentId: identity.canonicalId,
  }
}

function assertCallerIdentityMatches(
  requested: Contract,
  resolved: Contract,
  aliceId: string,
): void {
  for (const field of ['symbol', 'localSymbol'] as const) {
    const supplied = requested[field]
    if (supplied && supplied !== resolved[field]) {
      throw new InstrumentIdentityError(
        `Caller ${field} "${supplied}" is inconsistent with resolved broker identity "${resolved[field] || '<unknown>'}" for "${aliceId}".`,
      )
    }
  }
  if (requested.conId && requested.conId !== resolved.conId) {
    throw new InstrumentIdentityError(
      `Caller conId "${requested.conId}" is inconsistent with resolved broker identity "${resolved.conId || '<unknown>'}" for "${aliceId}".`,
    )
  }
}

function isTradeResolvable(contract: Contract): boolean {
  return contract.conId > 0 || contract.secType !== ''
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
