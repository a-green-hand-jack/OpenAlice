/**
 * Persistent portfolio guard state.
 *
 * Storage layout:
 *   data/trading/{accountId}/portfolio-guard-state.json
 *
 * This is intentionally separate from commit.json and snapshots: guard state
 * must survive UTA restarts even when no snapshot has been taken recently.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { dataPath } from '@/core/paths.js'

const STATE_FILE = 'portfolio-guard-state.json'
const DEFAULT_BASE_DIR = dataPath('trading')

export interface PortfolioGuardState {
  version: 1
  maxDrawdown?: {
    highWaterMark: string
  }
  dailyLoss?: {
    /** UTC date in YYYY-MM-DD form. DailyLossGuard deliberately uses UTC. */
    utcDate: string
    dayStartEquity: string
  }
}

export interface PortfolioGuardStateStore {
  read(): Promise<PortfolioGuardState>
  update(mutator: (state: PortfolioGuardState) => void | PortfolioGuardState): Promise<PortfolioGuardState>
}

export interface PortfolioGuardStateStoreOptions {
  baseDir?: string
}

export function portfolioGuardStatePath(accountId: string, options?: PortfolioGuardStateStoreOptions): string {
  return resolve(options?.baseDir ?? DEFAULT_BASE_DIR, accountId, STATE_FILE)
}

export function createPortfolioGuardStateStore(
  accountId: string,
  options?: PortfolioGuardStateStoreOptions,
): PortfolioGuardStateStore {
  const filePath = portfolioGuardStatePath(accountId, options)
  let writeChain = Promise.resolve()

  async function readState(): Promise<PortfolioGuardState> {
    try {
      return normalize(JSON.parse(await readFile(filePath, 'utf-8')))
    } catch (err) {
      if (isNotFound(err)) return emptyState()
      throw err
    }
  }

  async function writeState(state: PortfolioGuardState): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true })
    const tmp = `${filePath}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(state, null, 2), 'utf-8')
    await rename(tmp, filePath)
  }

  return {
    async read() {
      await writeChain
      return readState()
    },

    update(mutator) {
      const nextWrite = writeChain.then(async () => {
        const draft = cloneState(await readState())
        const next = normalize(mutator(draft) ?? draft)
        await writeState(next)
        return next
      })
      writeChain = nextWrite.then(() => undefined, () => undefined)
      return nextWrite
    },
  }
}

export function createInMemoryPortfolioGuardStateStore(): PortfolioGuardStateStore {
  let state = emptyState()
  return {
    async read() {
      return cloneState(state)
    },
    async update(mutator) {
      const draft = cloneState(state)
      state = normalize(mutator(draft) ?? draft)
      return cloneState(state)
    },
  }
}

function emptyState(): PortfolioGuardState {
  return { version: 1 }
}

function cloneState(state: PortfolioGuardState): PortfolioGuardState {
  return {
    version: 1,
    ...(state.maxDrawdown ? { maxDrawdown: { ...state.maxDrawdown } } : {}),
    ...(state.dailyLoss ? { dailyLoss: { ...state.dailyLoss } } : {}),
  }
}

function normalize(raw: unknown): PortfolioGuardState {
  if (!isRecord(raw) || raw.version !== 1) {
    throw new Error('portfolio guard state: unsupported or corrupt state file')
  }

  const state: PortfolioGuardState = { version: 1 }
  if (raw.maxDrawdown !== undefined && !isRecord(raw.maxDrawdown)) {
    throw new Error('portfolio guard state: corrupt maxDrawdown section')
  }
  if (isRecord(raw.maxDrawdown) && typeof raw.maxDrawdown.highWaterMark !== 'string') {
    throw new Error('portfolio guard state: corrupt maxDrawdown section')
  }
  if (isRecord(raw.maxDrawdown)) {
    state.maxDrawdown = { highWaterMark: raw.maxDrawdown.highWaterMark }
  }
  if (raw.dailyLoss !== undefined && !isRecord(raw.dailyLoss)) {
    throw new Error('portfolio guard state: corrupt dailyLoss section')
  }
  if (isRecord(raw.dailyLoss) && (
    typeof raw.dailyLoss.utcDate !== 'string' ||
    typeof raw.dailyLoss.dayStartEquity !== 'string'
  )) {
    throw new Error('portfolio guard state: corrupt dailyLoss section')
  }
  if (isRecord(raw.dailyLoss)) {
    state.dailyLoss = {
      utcDate: raw.dailyLoss.utcDate,
      dayStartEquity: raw.dailyLoss.dayStartEquity,
    }
  }
  return state
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function isNotFound(err: unknown): boolean {
  return isRecord(err) && err.code === 'ENOENT'
}
