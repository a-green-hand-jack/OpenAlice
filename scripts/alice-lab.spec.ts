import { describe, expect, it } from 'vitest'

import {
  derivePortBlock,
  deriveBootOutcome,
  deriveExitCode,
  deriveTeardownOutcome,
  generateRunId,
  isPortFreeError,
  lastLogLines,
  parseLabArgs,
  validateExperimentConfig,
} from '../tools/campaigns/_lib.mjs'

/**
 * Regression spec for issue #259: `tools/campaigns/lab.mjs` (one-command
 * experiment matrix runner). Covers the pure decision-logic surface the
 * runner delegates to `_lib.mjs` — config validation/normalization,
 * run-id generation, port-block derivation, exit-code derivation from
 * completed run results, and (review follow-up) the stack-teardown /
 * boot-race decision helpers. Process/stack lifecycle itself (spawning,
 * signal handling, actually polling a real port) is not covered here —
 * that surface is exercised by a live smoke run, not a unit spec.
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

describe('isPortFreeError (issue #259 review LOW 2)', () => {
  it('treats a fetch ECONNREFUSED rejection as port-free', () => {
    const err = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' }),
    })
    expect(isPortFreeError(err)).toBe(true)
  })

  it('does not treat an abort/timeout rejection as port-free', () => {
    const err = new DOMException('The operation was aborted', 'TimeoutError')
    expect(isPortFreeError(err)).toBe(false)
  })

  it('does not treat a cause-less TypeError as port-free', () => {
    expect(isPortFreeError(new TypeError('fetch failed'))).toBe(false)
  })

  it('does not treat an unrelated cause code as port-free', () => {
    const err = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }),
    })
    expect(isPortFreeError(err)).toBe(false)
  })

  it('handles non-object input without throwing', () => {
    expect(isPortFreeError(null)).toBe(false)
    expect(isPortFreeError(undefined)).toBe(false)
    expect(isPortFreeError('nope')).toBe(false)
  })
})

describe('deriveTeardownOutcome (issue #259 review CRITICAL)', () => {
  it('is ok when the port freed', () => {
    expect(deriveTeardownOutcome({ armId: 'a1', port: 49631, freed: true, timeoutMs: 30_000 })).toEqual({ ok: true })
  })

  it('is a runner-fatal failure when the port never freed', () => {
    const result = deriveTeardownOutcome({ armId: 'a1', port: 49631, freed: false, timeoutMs: 30_000 })
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/arm a1/)
    expect(result.reason).toMatch(/port 49631/)
    expect(result.reason).toMatch(/still bound/)
    expect(result.reason).toMatch(/SIGTERM\+SIGKILL/)
  })
})

describe('deriveBootOutcome (issue #259 review HIGH)', () => {
  it('is ok when the stack became ready', () => {
    expect(deriveBootOutcome({ ready: true, exited: false, timeoutMs: 240_000 })).toEqual({ ok: true })
  })

  it('fails immediately with an "exited" status when the child died during boot', () => {
    const result = deriveBootOutcome({ ready: false, exited: true, exitCode: 1, exitSignal: null, timeoutMs: 240_000 })
    expect(result.ok).toBe(false)
    expect(result.status).toBe('exited')
    expect(result.reason).toBe('stack process exited during boot (code 1 / signal null)')
  })

  it('reports a null exit code/signal when neither is available', () => {
    const result = deriveBootOutcome({ ready: false, exited: true, timeoutMs: 240_000 })
    expect(result.reason).toBe('stack process exited during boot (code null / signal null)')
  })

  it('falls back to a "timeout" status when the deadline passed without exit or readiness', () => {
    const result = deriveBootOutcome({ ready: false, exited: false, timeoutMs: 240_000 })
    expect(result.ok).toBe(false)
    expect(result.status).toBe('timeout')
    expect(result.reason).toBe('stack did not become ready within 240000ms')
  })
})

describe('parseLabArgs (issue #261)', () => {
  it('parses "run <cfg>" without a leading --', () => {
    expect(parseLabArgs(['run', 'experiments/foo.json'])).toEqual({ configPath: 'experiments/foo.json' })
  })

  it('tolerates a single leading -- (pnpm 11 passes it through argv)', () => {
    expect(parseLabArgs(['--', 'run', 'experiments/foo.json'])).toEqual({ configPath: 'experiments/foo.json' })
  })

  it('still usage-errors on a bare --', () => {
    expect(() => parseLabArgs(['--'])).toThrow(/usage: lab\.mjs run <experiment\.json>/)
  })

  it('still usage-errors when cmd is missing entirely', () => {
    expect(() => parseLabArgs([])).toThrow(/usage: lab\.mjs run <experiment\.json>/)
  })

  it('still rejects a wrong command after a leading --', () => {
    expect(() => parseLabArgs(['--', 'walk', 'experiments/foo.json'])).toThrow(/usage: lab\.mjs run <experiment\.json>/)
  })

  it('still rejects extra trailing arguments', () => {
    expect(() => parseLabArgs(['run', 'experiments/foo.json', 'extra'])).toThrow(/unexpected extra argument\(s\): extra/)
  })

  it('still rejects extra trailing arguments after a leading --', () => {
    expect(() => parseLabArgs(['--', 'run', 'experiments/foo.json', 'extra'])).toThrow(/unexpected extra argument\(s\): extra/)
  })

  it('rejects a second leading -- (only one is stripped)', () => {
    expect(() => parseLabArgs(['--', '--', 'run', 'experiments/foo.json'])).toThrow(/usage: lab\.mjs run <experiment\.json>/)
  })
})

describe('lastLogLines (issue #259 review HIGH)', () => {
  it('returns the last n lines', () => {
    const text = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')
    const result = lastLogLines(text, 5)
    expect(result.split('\n')).toEqual(['line 25', 'line 26', 'line 27', 'line 28', 'line 29'])
  })

  it('drops a single trailing empty line from a final newline', () => {
    expect(lastLogLines('a\nb\nc\n', 5)).toBe('a\nb\nc')
  })

  it('returns the whole text when it has fewer lines than n', () => {
    expect(lastLogLines('only one line', 20)).toBe('only one line')
  })

  it('handles empty/undefined input without throwing', () => {
    expect(lastLogLines('', 5)).toBe('')
    expect(lastLogLines(undefined as unknown as string, 5)).toBe('')
  })
})
