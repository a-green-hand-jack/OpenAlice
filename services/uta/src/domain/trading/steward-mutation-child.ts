import { open, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

import { Order } from '@traderalice/ibkr'
import Decimal from 'decimal.js'
import {
  stewardUtaMutationRequestSchema,
  type Operation,
  type StewardSizingSourceVersions,
  type StewardUtaMutationRequest,
} from '@traderalice/uta-protocol'

import { writeUTAsConfig, type UTAConfig } from '@/core/config.js'
import { makeContract } from './brokers/mock/index.js'
import { UTAManager, type StewardMutationFixtureProducer } from './uta-manager.js'

type Mode = 'init' | 'invoke'
type Behavior = 'normal' | 'gated_normal' | 'crash_dispatching' | 'advance_source_lose_response'

const [modeInput, accountId, requestPath, sourcePath, witnessPath, behaviorInput] = process.argv.slice(2)
const mode = modeInput as Mode
const behavior = (behaviorInput ?? 'normal') as Behavior

if (!accountId || !requestPath || !sourcePath || !witnessPath) {
  throw new Error('steward mutation child requires accountId, requestPath, sourcePath, and witnessPath')
}

const envelope = {
  version: 3,
  maxPositionPctOfEquity: 25,
  maxSingleOrderPctOfEquity: 20,
  maxDailyLossPct: 5,
  maxDrawdownPct: 10,
  scope: { kind: 'whitelist' as const, symbols: ['ASSET-A'] },
  autonomyCeiling: 'paper' as const,
  revoked: false,
  revokedReason: null,
}

const config: UTAConfig = {
  id: accountId,
  label: accountId,
  presetId: 'mock-simulator',
  enabled: true,
  guards: [],
  riskEnvelope: envelope,
  maxAuthzLevel: 'paper',
  presetConfig: { cash: 100_000 },
  keyless: false,
  readOnly: false,
  asVendor: true,
  editable: true,
}

async function main(): Promise<void> {
  if (mode === 'init') {
    await writeUTAsConfig([config])
    process.stdout.write('STEWARD_INIT_OK\n')
    return
  }
  if (mode !== 'invoke') throw new Error(`unknown steward mutation child mode: ${modeInput}`)

  const request = stewardUtaMutationRequestSchema.parse(
    JSON.parse(await readFile(requestPath, 'utf8')),
  )
  const producer: StewardMutationFixtureProducer = {
    createOperation: ({ request: mutationRequest }) => fixtureOperation(mutationRequest),
    readSourceVersions: async () => JSON.parse(
      await readFile(sourcePath, 'utf8'),
    ) as StewardSizingSourceVersions,
    invokeOperation: async ({ operation }) => {
      await appendWitness(witnessPath, {
        pid: process.pid,
        accountId,
        utaMutationReference: request.utaMutationReference,
        operationId: request.operation.operationId,
      })
      if (behavior === 'crash_dispatching') {
        process.kill(process.pid, 'SIGKILL')
        await new Promise<never>(() => {})
      }
      if (behavior === 'advance_source_lose_response') {
        const current = JSON.parse(await readFile(sourcePath, 'utf8')) as StewardSizingSourceVersions
        await atomicWriteJson(sourcePath, { ...current, accountState: 'account:2' })
      }
      return {
        action: operation.action,
        success: true,
        status: 'submitted' as const,
        orderId: `fixture-${process.pid}`,
      }
    },
  }
  const manager = new UTAManager({ stewardMutationFixtureProducer: producer })
  await manager.initUTA(config)
  if (behavior === 'gated_normal') {
    process.stdout.write('STEWARD_READY\n')
    await new Promise<void>((resolve, reject) => {
      process.stdin.once('data', () => resolve())
      process.stdin.once('end', () => reject(new Error('Steward gate closed before release')))
    })
  }
  const response = await manager.invokeStewardMutation(accountId, 'paper', request)
  await manager.closeAll()

  if (behavior === 'advance_source_lose_response' && response.status === 'accepted') {
    process.exitCode = 86
    return
  }
  process.stdout.write(`STEWARD_RESULT ${JSON.stringify(response)}\n`)
}

function fixtureOperation(request: StewardUtaMutationRequest): Operation {
  const contract = makeContract({
    aliceId: request.operation.instrument,
    symbol: request.operation.instrument.split('/').at(-1) ?? 'ASSET-A',
  })
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

async function appendWitness(path: string, value: unknown): Promise<void> {
  const handle = await open(path, 'a', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, path)
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
