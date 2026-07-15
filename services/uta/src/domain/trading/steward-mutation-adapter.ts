import Decimal from 'decimal.js'
import { Order } from '@traderalice/ibkr'
import type { Operation, StewardUtaMutationRequest } from '@traderalice/uta-protocol'

import type { UnifiedTradingAccount } from './UnifiedTradingAccount.js'
import type { StewardMutationFixtureProducer } from './uta-manager.js'

/**
 * The only production Steward mutation adapter. Its caller separately proves
 * mock-simulator + verified-isolated + readonly before this adapter is used.
 * Keeping the operation mapping here removes the old D2 test-fixture mapping
 * from the UTA process entrypoint and never restores staged agent writes.
 */
export function createVerifiedMockStewardMutationAdapter(
  utaForAccount: (accountId: string) => UnifiedTradingAccount | undefined,
): StewardMutationFixtureProducer {
  return {
    productionAdapter: true,
    createOperation: ({ accountId, request }) => operationFor(utaForAccount(accountId), request),
    readSourceVersions: async () => {
      // UTAManager owns authoritative source-version capture. This method is
      // retained only for the existing boundary interface and must not invent
      // agent/runner state.
      throw new Error('authoritative source versions must be read by UTAManager')
    },
    invokeOperation: async ({ accountId, operation }) => {
      const uta = utaForAccount(accountId)
      if (!uta) throw new Error(`UTA ${accountId} is unavailable`)
      return uta.dispatchStewardOperation(operation)
    },
  }
}

function operationFor(
  uta: UnifiedTradingAccount | undefined,
  request: StewardUtaMutationRequest,
): Operation {
  if (!uta) throw new Error(`UTA ${request.accountId} is unavailable`)
  const contract = uta.contractFromAliceId(request.operation.instrument)
  if (!('protection' in request)) {
    return {
      action: 'closePosition',
      contract,
      quantity: new Decimal(request.operation.totalQuantity),
    }
  }
  const order = new Order()
  order.action = request.operation.side
  order.orderType = 'MKT'
  order.totalQuantity = new Decimal(request.operation.totalQuantity)
  return {
    action: 'placeOrder',
    contract,
    order,
    tpsl: {
      stopLoss: {
        price: request.protection.triggerPrice,
        ...(request.protection.orderType === 'STP_LMT'
          ? { limitPrice: request.protection.limitPrice }
          : {}),
      },
    },
  }
}
