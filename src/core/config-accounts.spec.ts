import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir, platform } from 'node:os'
import { join } from 'node:path'

/**
 * readUTAsConfig / writeUTAsConfig round-trip through the sealed at-rest
 * format. config.ts resolves CONFIG_DIR at import, so each test re-imports
 * under a fresh temp OPENALICE_HOME (global-provider-keys.spec.ts pattern).
 */
let home: string
let configDir: string
let savedHome: string | undefined

async function loadConfigModule() {
  vi.resetModules()
  process.env['OPENALICE_HOME'] = home
  const config = await import('./config.js')
  const sealing = await import('./sealing.js')
  return { config, sealing }
}

beforeEach(async () => {
  savedHome = process.env['OPENALICE_HOME']
  home = await mkdtemp(join(tmpdir(), 'oa-accounts-'))
  configDir = join(home, 'data', 'config')
})

afterEach(async () => {
  if (savedHome === undefined) delete process.env['OPENALICE_HOME']
  else process.env['OPENALICE_HOME'] = savedHome
  vi.resetModules()
  await rm(home, { recursive: true, force: true })
})

const ACCOUNT = {
  id: 'okx-test',
  presetId: 'okx',
  presetConfig: { apiKey: 'plain-api-key', secret: 'plain-secret' },
}

const RISK_ENVELOPE = {
  version: 1,
  maxPositionPctOfEquity: 25,
  maxSingleOrderPctOfEquity: 10,
  maxDailyLossPct: 5,
  maxDrawdownPct: 10,
  scope: { kind: 'whitelist' as const, symbols: ['AAPL'] },
  autonomyCeiling: 'paper' as const,
  revoked: false,
  revokedReason: null,
}

describe('UTA accounts at-rest sealing', () => {
  it('write → sealed envelope on disk (0600), read → original records', async () => {
    const { config, sealing } = await loadConfigModule()
    await config.writeUTAsConfig([ACCOUNT] as never)

    const path = join(configDir, 'accounts.json')
    const onDisk = JSON.parse(await readFile(path, 'utf-8'))
    expect(sealing.isSealedEnvelope(onDisk)).toBe(true)
    expect(JSON.stringify(onDisk)).not.toContain('plain-secret')
    if (platform() !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o600)
    }

    const back = await config.readUTAsConfig()
    expect(back).toHaveLength(1)
    expect(back[0].id).toBe('okx-test')
    expect(back[0].presetConfig).toEqual(ACCOUNT.presetConfig)
  })

  it('first run seeds a sealed empty store and the sealing key', async () => {
    const { config } = await loadConfigModule()
    expect(await config.readUTAsConfig()).toEqual([])
    expect(existsSync(join(configDir, 'accounts.json'))).toBe(true)
    expect(existsSync(join(home, 'sealing.key'))).toBe(true)
  })

  it('still reads a legacy plaintext array (pre-0009 store)', async () => {
    const { config } = await loadConfigModule()
    await mkdir(configDir, { recursive: true })
    await writeFile(join(configDir, 'accounts.json'), JSON.stringify([ACCOUNT], null, 2))

    const back = await config.readUTAsConfig()
    expect(back).toHaveLength(1)
    expect(back[0].presetConfig['apiKey']).toBe('plain-api-key')
  })

  it('quarantines an unreadable sealed store and recovers with an empty one', async () => {
    const { config, sealing } = await loadConfigModule()
    await config.writeUTAsConfig([ACCOUNT] as never)
    await rm(join(home, 'sealing.key')) // simulate data/ copied to a machine without the key

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await config.readUTAsConfig()).toEqual([])
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('could not be unsealed'))
    } finally {
      errSpy.mockRestore()
    }

    // Original preserved under a quarantine name, fresh sealed store seeded.
    const files = await readdir(configDir)
    expect(files.some((f) => f.startsWith('accounts.json.sealed-unreadable-'))).toBe(true)
    const reseeded = JSON.parse(await readFile(join(configDir, 'accounts.json'), 'utf-8'))
    expect(sealing.isSealedEnvelope(reseeded)).toBe(true)
    // A new key was minted by the reseed, so subsequent reads work again.
    expect(await config.readUTAsConfig()).toEqual([])
  })

  it('serializes concurrent deterministic revokes into one monotonic version', async () => {
    const { config } = await loadConfigModule()
    await config.writeUTAsConfig([{ ...ACCOUNT, riskEnvelope: RISK_ENVELOPE }] as never)

    const results = await Promise.all(Array.from({ length: 128 }, (_, index) =>
      config.revokeUTARiskEnvelope(ACCOUNT.id, `deterministic risk trigger ${index}`)))

    expect(results.every((result) => result.version === 2 && result.revoked)).toBe(true)
    expect(new Set(results.map((result) => result.revokedReason)).size).toBe(1)
    expect((await config.readUTAsConfig())[0]?.riskEnvelope).toMatchObject({
      version: 2,
      revoked: true,
      revokedReason: expect.stringContaining('deterministic risk trigger'),
    })
  })

  it('does not lose concurrent envelope version mutations', async () => {
    const { config } = await loadConfigModule()
    await config.writeUTAsConfig([{ ...ACCOUNT, riskEnvelope: RISK_ENVELOPE }] as never)

    await Promise.all(Array.from({ length: 64 }, () => config.mutateUTAsConfig((accounts) => {
      const account = accounts[0]!
      const envelope = account.riskEnvelope!
      accounts[0] = {
        ...account,
        riskEnvelope: { ...envelope, version: envelope.version + 1 },
      }
      return accounts
    })))

    expect((await config.readUTAsConfig())[0]?.riskEnvelope?.version).toBe(65)
  })

  it('requires exact version advancement for human envelope edits while allowing human clear', async () => {
    const { config } = await loadConfigModule()
    expect(() => config.assertHumanRiskEnvelopeTransition(
      RISK_ENVELOPE,
      { ...RISK_ENVELOPE, maxPositionPctOfEquity: 20 },
    )).toThrow(/version must advance exactly once/)
    expect(() => config.assertHumanRiskEnvelopeTransition(
      RISK_ENVELOPE,
      { ...RISK_ENVELOPE, version: 3, maxPositionPctOfEquity: 20 },
    )).toThrow(/version must advance exactly once/)
    expect(() => config.assertHumanRiskEnvelopeTransition(
      { ...RISK_ENVELOPE, version: 2, revoked: true, revokedReason: 'stop' },
      { ...RISK_ENVELOPE, version: 3 },
    )).not.toThrow()
  })
})
