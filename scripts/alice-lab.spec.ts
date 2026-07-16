import { describe, expect, it } from 'vitest'

import {
  derivePortBlock,
  deriveExitCode,
  generateRunId,
  validateExperimentConfig,
} from '../tools/campaigns/_lib.mjs'

/**
 * Regression spec for issue #259: `tools/campaigns/lab.mjs` (one-command
 * experiment matrix runner). Covers the pure decision-logic surface the
 * runner delegates to `_lib.mjs` — config validation/normalization,
 * run-id generation, port-block derivation, and exit-code derivation from
 * completed run results. Process/stack lifecycle (stack boot, run-cell
 * child spawning, batch cleanup, teardown) is not covered here — that
 * surface is exercised by a live smoke run, not a unit spec.
 */

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    name: 'e-test',
    weeks: 2,
    rounds: 1,
    cells: ['bull-cx'],
    arms: [{ id: 'a1', agent: 'codex', model: 'gpt-5.3-codex-spark' }],
    maxRuns: 4,
    ...overrides,
  }
}

describe('validateExperimentConfig (issue #259)', () => {
  it('accepts a minimal valid config and fills in defaults', () => {
    const result = validateExperimentConfig(baseConfig())
    expect(result.name).toBe('e-test')
    expect(result.basePort).toBe(49631)
    expect(result.allowHoldout).toBe(false)
    expect(result.totalRuns).toBe(1)
    expect(result.arms).toEqual([{ id: 'a1', agent: 'codex', model: 'gpt-5.3-codex-spark' }])
  })

  it('accepts an explicit basePort and multiple arms/cells/rounds under budget', () => {
    const config = baseConfig({
      cells: ['bull-cx', 'chop-cx'],
      rounds: 2,
      arms: [
        { id: 'v1', agent: 'codex', model: 'gpt-5.6-sol', overlayDir: '/abs/overlay-v1' },
        { id: 'v2', agent: 'codex', model: 'gpt-5.6-sol' },
      ],
      maxRuns: 8,
      basePort: 49700,
    })
    const result = validateExperimentConfig(config)
    expect(result.totalRuns).toBe(8) // 2 arms x 2 cells x 2 rounds
    expect(result.basePort).toBe(49700)
    expect(result.arms[0].overlayDir).toBe('/abs/overlay-v1')
    expect(result.arms[1].overlayDir).toBeUndefined()
  })

  it('rejects an unknown top-level field', () => {
    expect(() => validateExperimentConfig(baseConfig({ bogus: true }))).toThrow(/unknown field/)
  })

  it('rejects an unknown arm field', () => {
    const config = baseConfig({ arms: [{ id: 'a1', agent: 'codex', model: 'm', extra: 1 }] })
    expect(() => validateExperimentConfig(config)).toThrow(/unknown field/)
  })

  it('rejects a missing required field', () => {
    const config = baseConfig()
    delete (config as Record<string, unknown>).maxRuns
    expect(() => validateExperimentConfig(config)).toThrow(/missing required field: maxRuns/)
  })

  it('rejects a duplicate arm id', () => {
    const config = baseConfig({
      arms: [
        { id: 'v1', agent: 'codex', model: 'm1' },
        { id: 'v1', agent: 'codex', model: 'm2' },
      ],
    })
    expect(() => validateExperimentConfig(config)).toThrow(/duplicate arm id/)
  })

  it('refuses to start when arms x cells x rounds exceeds maxRuns', () => {
    const config = baseConfig({ cells: ['bull-cx', 'chop-cx'], rounds: 3, maxRuns: 4 })
    expect(() => validateExperimentConfig(config)).toThrow(/budget exceeded/)
  })

  it('refuses a non-codex arm agent (v1 supports codex only)', () => {
    const config = baseConfig({ arms: [{ id: 'a1', agent: 'claude', model: 'haiku' }] })
    expect(() => validateExperimentConfig(config)).toThrow(/v1 only supports "codex" arms/)
  })

  it('refuses a holdout cell without allowHoldout: true', () => {
    const config = baseConfig({ cells: ['holdout-bull-amd'] })
    expect(() => validateExperimentConfig(config)).toThrow(/holdout cell/)
  })

  it('accepts a holdout cell when allowHoldout: true', () => {
    const config = baseConfig({ cells: ['holdout-bull-amd'], allowHoldout: true })
    const result = validateExperimentConfig(config)
    expect(result.cells).toEqual(['holdout-bull-amd'])
  })
})

describe('generateRunId (issue #259)', () => {
  it('formats as <name>-<armId>-<cell>-r<round>', () => {
    expect(generateRunId('e-opt1', 'v1', 'bull-cx', 3)).toBe('e-opt1-v1-bull-cx-r3')
  })
})

describe('derivePortBlock (issue #259)', () => {
  it('derives web/mcp/uta/ui from a base port with the checked-in default gap', () => {
    expect(derivePortBlock(49631)).toEqual({ web: 49631, mcp: 49632, uta: 49633, ui: 49635 })
  })

  it('derives consistently from a non-default base port', () => {
    expect(derivePortBlock(49700)).toEqual({ web: 49700, mcp: 49701, uta: 49702, ui: 49704 })
  })
})

describe('deriveExitCode (issue #259)', () => {
  it('returns 0 when every run succeeded', () => {
    expect(deriveExitCode([{ status: 'ok' }, { status: 'ok' }])).toBe(0)
  })

  it('returns 2 when at least one run failed', () => {
    expect(deriveExitCode([{ status: 'ok' }, { status: 'failed' }])).toBe(2)
  })

  it('returns 2 when at least one run was skipped (arm boot failure)', () => {
    expect(deriveExitCode([{ status: 'ok' }, { status: 'skipped' }])).toBe(2)
  })

  it('returns 2 for an empty result set', () => {
    expect(deriveExitCode([])).toBe(2)
  })
})
