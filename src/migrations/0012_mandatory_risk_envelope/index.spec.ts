import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import type { MigrationContext } from '../types.js'

let home: string
let configDir: string
let savedHome: string | undefined

async function loadMigration() {
  vi.resetModules()
  process.env['OPENALICE_HOME'] = home
  const { migration } = await import('./index.js')
  const sealing = await import('@/core/sealing.js')
  return { migration, sealing }
}

function makeCtx(): MigrationContext {
  return {
    readJson: async <T = unknown>(filename: string): Promise<T | undefined> => {
      try {
        return JSON.parse(await readFile(resolve(configDir, filename), 'utf8')) as T
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw err
      }
    },
    writeJson: async (filename, data) => {
      await writeFile(resolve(configDir, filename), JSON.stringify(data, null, 2) + '\n')
    },
    removeJson: async (filename) => {
      await rm(resolve(configDir, filename), { force: true })
    },
    configDir: () => configDir,
  }
}

beforeEach(async () => {
  savedHome = process.env['OPENALICE_HOME']
  home = await mkdtemp(join(tmpdir(), 'oa-mig0012-'))
  configDir = join(home, 'data', 'config')
  await mkdir(configDir, { recursive: true })
})

afterEach(async () => {
  if (savedHome === undefined) delete process.env['OPENALICE_HOME']
  else process.env['OPENALICE_HOME'] = savedHome
  vi.resetModules()
  await rm(home, { recursive: true, force: true })
})

const validEnvelope = {
  version: 3,
  maxPositionPctOfEquity: 25,
  maxSingleOrderPctOfEquity: 10,
  maxDailyLossPct: 5,
  maxDrawdownPct: 10,
  scope: { kind: 'whitelist', symbols: ['AAPL'] },
  autonomyCeiling: 'paper',
  revoked: false,
  revokedReason: null,
}

describe('0012_mandatory_risk_envelope', () => {
  it('rewrites sealed accounts with explicit null and preserves complete envelopes', async () => {
    const { migration, sealing } = await loadMigration()
    const input = [
      { id: 'legacy', presetId: 'mock-simulator', presetConfig: {} },
      { id: 'configured', presetId: 'mock-simulator', presetConfig: {}, riskEnvelope: validEnvelope },
      { id: 'partial', presetId: 'mock-simulator', presetConfig: {}, riskEnvelope: { version: 1 } },
    ]
    await writeFile(
      join(configDir, 'accounts.json'),
      JSON.stringify(await sealing.seal(input), null, 2) + '\n',
    )

    await migration.up(makeCtx())

    const onDisk = JSON.parse(await readFile(join(configDir, 'accounts.json'), 'utf8'))
    expect(sealing.isSealedEnvelope(onDisk)).toBe(true)
    await expect(sealing.unseal(onDisk)).resolves.toEqual([
      { ...input[0], riskEnvelope: null },
      input[1],
      { ...input[2], riskEnvelope: null },
    ])
  })

  it('is byte-idempotent once every account has a target-shape field', async () => {
    const { migration, sealing } = await loadMigration()
    await writeFile(
      join(configDir, 'accounts.json'),
      JSON.stringify(await sealing.seal([
        { id: 'legacy', riskEnvelope: null },
        { id: 'configured', riskEnvelope: validEnvelope },
      ]), null, 2) + '\n',
    )
    await migration.up(makeCtx())
    const once = await readFile(join(configDir, 'accounts.json'), 'utf8')
    await migration.up(makeCtx())
    expect(await readFile(join(configDir, 'accounts.json'), 'utf8')).toBe(once)
  })

  it('no-ops for missing or unrecognized files', async () => {
    const { migration } = await loadMigration()
    await expect(migration.up(makeCtx())).resolves.toBeUndefined()
    await writeFile(join(configDir, 'accounts.json'), JSON.stringify({ unknown: true }))
    await expect(migration.up(makeCtx())).resolves.toBeUndefined()
    expect(JSON.parse(await readFile(join(configDir, 'accounts.json'), 'utf8'))).toEqual({ unknown: true })
  })
})
