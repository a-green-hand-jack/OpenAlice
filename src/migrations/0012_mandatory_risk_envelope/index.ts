/**
 * Materialize the fail-closed Risk Envelope field on every persisted account.
 * Existing accounts receive `riskEnvelope: null`; no permissive defaults are
 * invented. Invalid/partial pre-release shapes also become null, while a
 * complete contract-valid envelope (including reserved asset_class scope) is
 * preserved for the production admission layer to classify explicitly.
 */

import { randomUUID } from 'node:crypto'
import { chmod, open, rename, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

import { riskEnvelopeSchema } from '@traderalice/uta-protocol'

import type { Migration } from '../types.js'
import { isSealedEnvelope, seal, unseal } from '@/core/sealing.js'

const FILENAME = 'accounts.json'

export const migration: Migration = {
  id: '0012_mandatory_risk_envelope',
  appVersion: '0.73.0-beta',
  introducedAt: '2026-07-12',
  affects: ['accounts.json'],
  summary: 'Materialize fail-closed null Risk Envelopes for existing accounts without granting autonomy',
  rationale: 'docs/steward-decision-contracts.zh.md §4',
  up: async (ctx) => {
    const raw = await ctx.readJson(FILENAME)
    if (raw === undefined) return

    const decoded = isSealedEnvelope(raw) ? await unseal(raw) : raw
    if (!Array.isArray(decoded)) return

    let changed = false
    const accounts = decoded.map((value) => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
      const account = value as Record<string, unknown>
      if (!Object.prototype.hasOwnProperty.call(account, 'riskEnvelope')) {
        changed = true
        return { ...account, riskEnvelope: null }
      }
      if (account['riskEnvelope'] === null || riskEnvelopeSchema.safeParse(account['riskEnvelope']).success) {
        return account
      }
      changed = true
      return { ...account, riskEnvelope: null }
    })
    if (!changed) return

    const path = resolve(ctx.configDir(), FILENAME)
    const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`
    const handle = await open(tmp, 'wx', 0o600)
    try {
      await handle.writeFile(JSON.stringify(await seal(accounts), null, 2) + '\n', 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await rename(tmp, path)
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => undefined)
      throw err
    }
    await chmod(path, 0o600).catch(() => undefined)
  },
}
