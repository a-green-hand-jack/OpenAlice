import { open, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import Decimal from 'decimal.js'
import {
  UTA_INTERNAL_TOKEN_HEADER,
  UTA_STEWARD_WORKSPACE_AUTHZ_HEADER,
  type Operation,
  type StewardSizingSourceVersions,
  type StewardUtaMutationRequest,
} from '@traderalice/uta-protocol'

import { writeUTAsConfig, type UTAConfig } from '@/core/config.js'
import { makeContract } from '../domain/trading/brokers/mock/index.js'
import { UTAManager, type StewardMutationFixtureProducer } from '../domain/trading/uta-manager.js'
import type { UTAEngineContext } from '../types.js'
import { createUtaInternalAuth, UTA_INTERNAL_TOKEN_ENV } from './internal-auth.js'
import { createTradingRoutes } from './routes-trading.js'

const [accountId, sourcePath, witnessPath, executionRecordsDir] = process.argv.slice(2)
const internalToken = process.env[UTA_INTERNAL_TOKEN_ENV]

if (!accountId || !sourcePath || !witnessPath || !executionRecordsDir || !internalToken) {
  throw new Error(
    'scheduler UTA child requires accountId, sourcePath, witnessPath, executionRecordsDir, and internal token',
  )
}

const riskEnvelope = {
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
  riskEnvelope,
  maxAuthzLevel: 'paper',
  presetConfig: { cash: 100_000 },
  keyless: false,
  readOnly: false,
  asVendor: true,
  editable: true,
}

async function main(): Promise<void> {
  await writeUTAsConfig([config])

  const producer: StewardMutationFixtureProducer = {
    createOperation: ({ request }) => fixtureOperation(request),
    readSourceVersions: async ({ request }) => {
      const actual = JSON.parse(await readFile(sourcePath, 'utf8')) as StewardSizingSourceVersions
      await appendWitness({
        type: 'source-read',
        expected: request.expectedSourceVersions,
        actual,
      })
      return actual
    },
    invokeOperation: async ({ request, operation }) => {
      const record = await readSingleExecutionRecord()
      await appendWitness({
        type: 'invoke',
        accountId,
        utaMutationReference: request.utaMutationReference,
        operationId: request.operation.operationId,
        effect: request.operation.effect,
        requestQuantity: request.operation.totalQuantity,
        operationAction: operation.action,
        operationQuantity: operation.action === 'closePosition'
          ? operation.quantity.toString()
          : null,
        recordMutationReference: record.utaMutationReference,
      })
      return {
        action: operation.action,
        success: true,
        status: 'submitted' as const,
        orderId: `scheduler-fixture-${process.pid}`,
      }
    },
  }

  const manager = new UTAManager({ stewardMutationFixtureProducer: producer })
  await manager.initUTA(config)

  const app = new Hono()
  const auth = createUtaInternalAuth()
  app.use('/api/trading', auth)
  app.use('/api/trading/*', auth)
  app.use('/api/trading/*', async (c, next) => {
    if (c.req.method === 'POST' && c.req.path.endsWith('/steward/mutation')) {
      await appendWitness({
        type: 'authorized-http',
        internalTokenMatched: c.req.header(UTA_INTERNAL_TOKEN_HEADER) === internalToken,
        workspaceAuthzLevel: c.req.header(UTA_STEWARD_WORKSPACE_AUTHZ_HEADER) ?? null,
      })
    }
    await next()
  })
  app.route('/api/trading', createTradingRoutes({ utaManager: manager } as unknown as UTAEngineContext))

  const server = serve({
    fetch: app.fetch,
    hostname: '127.0.0.1',
    port: 0,
  }, (info) => {
    process.stdout.write(`STEWARD_UTA_READY ${JSON.stringify({ port: info.port })}\n`)
  })

  let stopping = false
  const stop = async (): Promise<void> => {
    if (stopping) return
    stopping = true
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await manager.closeAll()
  }
  process.once('SIGTERM', () => { void stop().then(() => process.exit(0)) })
  process.once('SIGINT', () => { void stop().then(() => process.exit(0)) })
}

function fixtureOperation(request: StewardUtaMutationRequest): Operation {
  if (request.operation.effect !== 'reduce') {
    throw new Error('scheduler integration fixture accepts reduce-only operations')
  }
  return {
    action: 'closePosition',
    contract: makeContract({
      aliceId: request.operation.instrument,
      symbol: request.operation.instrument.split('/').at(-1) ?? 'ASSET-A',
    }),
    quantity: new Decimal(request.operation.totalQuantity),
  }
}

async function readSingleExecutionRecord(): Promise<{ utaMutationReference: string }> {
  const files = (await readdir(executionRecordsDir)).filter((file) => file.endsWith('.json'))
  if (files.length !== 1) {
    throw new Error(`expected one pre-operation Execution Record, found ${files.length}`)
  }
  return JSON.parse(await readFile(join(executionRecordsDir, files[0]!), 'utf8')) as {
    utaMutationReference: string
  }
}

async function appendWitness(value: unknown): Promise<void> {
  const handle = await open(witnessPath, 'a', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
