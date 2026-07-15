import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { backfillCodexOverrideMarkers } from './0013_codex_provider_override_marker/index.js'

let root: string
const wsDir: Record<string, string> = {}

const MARKER_REL = '.alice/codex-provider-override.marker'

async function makeLauncher(ids: string[]): Promise<void> {
  await mkdir(root, { recursive: true })
  const workspaces = ids.map((id) => {
    const dir = join(root, 'workspaces', id)
    wsDir[id] = dir
    return { id, tag: id, dir, createdAt: '2026-01-01T00:00:00Z', agents: [] }
  })
  await writeFile(join(root, 'workspaces.json'), JSON.stringify({ version: 1, workspaces }), 'utf-8')
  for (const w of workspaces) await mkdir(w.dir, { recursive: true })
}

/** Byte-exact shape the real (pre-#230) `writeAiConfig` produces for a full
 *  provider override — the ONLY shape `isStrictLegacyCodexOverride` accepts. */
const REAL_OVERRIDE_TOML =
  'model = "gpt-x"\nmodel_provider = "workspace"\n\n' +
  '[model_providers.workspace]\nname = "OpenAlice workspace provider"\n' +
  'base_url = "https://oai.test/v1"\nenv_key = "OPENALICE_WORKSPACE_KEY"\nwire_api = "responses"\n'

async function writeLegacyOverride(id: string): Promise<void> {
  await mkdir(join(wsDir[id], '.codex'), { recursive: true })
  await writeFile(join(wsDir[id], '.codex', 'config.toml'), REAL_OVERRIDE_TOML, 'utf-8')
  await writeFile(
    join(wsDir[id], '.codex', 'env.json'),
    JSON.stringify({ OPENALICE_WORKSPACE_KEY: 'sk-legacy' }, null, 2) + '\n',
    'utf-8',
  )
}

async function markerExists(id: string): Promise<boolean> {
  try {
    await stat(join(wsDir[id], MARKER_REL))
    return true
  } catch {
    return false
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mig0013-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('0013 codex provider override marker backfill', () => {
  it('backfills the marker for a workspace with a proven (strict-signature) legacy override', async () => {
    await makeLauncher(['ws1'])
    await writeLegacyOverride('ws1')

    const res = await backfillCodexOverrideMarkers(root)
    expect(res).toEqual({ backfilled: 1, workspaces: 1 })
    expect(await markerExists('ws1')).toBe(true)
  })

  it('is idempotent — a second run does not re-count an already-marked workspace', async () => {
    await makeLauncher(['ws1'])
    await writeLegacyOverride('ws1')

    await backfillCodexOverrideMarkers(root)
    const second = await backfillCodexOverrideMarkers(root)
    expect(second).toEqual({ backfilled: 0, workspaces: 0 })
  })

  it('skips a workspace that already has the marker, even without re-checking the signature', async () => {
    await makeLauncher(['ws1'])
    await mkdir(join(wsDir['ws1'], '.alice'), { recursive: true })
    await writeFile(join(wsDir['ws1'], MARKER_REL), '', 'utf-8')
    // Deliberately no .codex/ content at all — proves the "already marked" skip
    // short-circuits before the signature check.

    const res = await backfillCodexOverrideMarkers(root)
    expect(res).toEqual({ backfilled: 0, workspaces: 0 })
  })

  it('does NOT backfill a workspace polluted by Codex CLI cold-start bootstrap (issue #230 round-2 repro)', async () => {
    await makeLauncher(['ws1'])
    await mkdir(join(wsDir['ws1'], '.codex', 'agents'), { recursive: true })
    await writeFile(join(wsDir['ws1'], '.codex', 'agents', 'note-taker.toml'), 'name = "note-taker"\n', 'utf-8')
    await writeFile(
      join(wsDir['ws1'], '.codex', 'config.toml'),
      'personality = "pragmatic"\n[projects."/abs/path"]\ntrust_level = "trusted"\n',
      'utf-8',
    )
    // No env.json — matches the real repro exactly.

    const res = await backfillCodexOverrideMarkers(root)
    expect(res).toEqual({ backfilled: 0, workspaces: 0 })
    expect(await markerExists('ws1')).toBe(false)
  })

  it('does NOT backfill a weak-signal workspace (config.toml with a full-looking block but no env.json)', async () => {
    await makeLauncher(['ws1'])
    await mkdir(join(wsDir['ws1'], '.codex'), { recursive: true })
    await writeFile(join(wsDir['ws1'], '.codex', 'config.toml'), REAL_OVERRIDE_TOML, 'utf-8')
    // No env.json.

    const res = await backfillCodexOverrideMarkers(root)
    expect(res).toEqual({ backfilled: 0, workspaces: 0 })
  })

  it('does NOT backfill the known model-only legacy blind spot (documented, not a regression)', async () => {
    await makeLauncher(['ws1'])
    await mkdir(join(wsDir['ws1'], '.codex'), { recursive: true })
    await writeFile(join(wsDir['ws1'], '.codex', 'config.toml'), 'model = "gpt-y"\n', 'utf-8')
    await writeFile(join(wsDir['ws1'], '.codex', 'env.json'), '{}\n', 'utf-8')

    const res = await backfillCodexOverrideMarkers(root)
    expect(res).toEqual({ backfilled: 0, workspaces: 0 })
  })

  it('backfills when env.json is exactly {} alongside the full provider TOML (legacy no-apiKey shape)', async () => {
    await makeLauncher(['ws1'])
    await mkdir(join(wsDir['ws1'], '.codex'), { recursive: true })
    await writeFile(join(wsDir['ws1'], '.codex', 'config.toml'), REAL_OVERRIDE_TOML, 'utf-8')
    await writeFile(join(wsDir['ws1'], '.codex', 'env.json'), '{}\n', 'utf-8')

    const res = await backfillCodexOverrideMarkers(root)
    expect(res).toEqual({ backfilled: 1, workspaces: 1 })
    expect(await markerExists('ws1')).toBe(true)
  })

  it('does NOT backfill when env.json has no OPENALICE_WORKSPACE_KEY (issue #230 reviewer repro)', async () => {
    await makeLauncher(['ws1'])
    await mkdir(join(wsDir['ws1'], '.codex'), { recursive: true })
    await writeFile(join(wsDir['ws1'], '.codex', 'config.toml'), REAL_OVERRIDE_TOML, 'utf-8')
    await writeFile(join(wsDir['ws1'], '.codex', 'env.json'), JSON.stringify({ UNRELATED_USER_SETTING: 'x' }), 'utf-8')

    const res = await backfillCodexOverrideMarkers(root)
    expect(res).toEqual({ backfilled: 0, workspaces: 0 })
    expect(await markerExists('ws1')).toBe(false)
  })

  it('does NOT backfill when env.json has the real key plus an extra unrelated field (issue #230 correction)', async () => {
    await makeLauncher(['ws1'])
    await mkdir(join(wsDir['ws1'], '.codex'), { recursive: true })
    await writeFile(join(wsDir['ws1'], '.codex', 'config.toml'), REAL_OVERRIDE_TOML, 'utf-8')
    await writeFile(
      join(wsDir['ws1'], '.codex', 'env.json'),
      JSON.stringify({ OPENALICE_WORKSPACE_KEY: 'sk-legacy', UNRELATED: 'y' }),
      'utf-8',
    )

    const res = await backfillCodexOverrideMarkers(root)
    expect(res).toEqual({ backfilled: 0, workspaces: 0 })
    expect(await markerExists('ws1')).toBe(false)
  })

  it('skips (never throws on) a workspace with unparseable env.json', async () => {
    await makeLauncher(['ws1'])
    await mkdir(join(wsDir['ws1'], '.codex'), { recursive: true })
    await writeFile(join(wsDir['ws1'], '.codex', 'config.toml'), REAL_OVERRIDE_TOML, 'utf-8')
    await writeFile(join(wsDir['ws1'], '.codex', 'env.json'), '{ not json', 'utf-8')

    const res = await backfillCodexOverrideMarkers(root)
    expect(res).toEqual({ backfilled: 0, workspaces: 0 })
    expect(await markerExists('ws1')).toBe(false)
  })

  it('processes multiple workspaces independently — one polluted, one a proven legacy override', async () => {
    await makeLauncher(['polluted', 'legacy'])
    await mkdir(join(wsDir['polluted'], '.codex', 'agents'), { recursive: true })
    await writeFile(join(wsDir['polluted'], '.codex', 'agents', 'note-taker.toml'), 'name = "note-taker"\n', 'utf-8')
    await writeFile(
      join(wsDir['polluted'], '.codex', 'config.toml'),
      'personality = "pragmatic"\n[projects."/abs/path"]\ntrust_level = "trusted"\n',
      'utf-8',
    )
    await writeLegacyOverride('legacy')

    const res = await backfillCodexOverrideMarkers(root)
    expect(res).toEqual({ backfilled: 1, workspaces: 1 })
    expect(await markerExists('polluted')).toBe(false)
    expect(await markerExists('legacy')).toBe(true)
  })

  it('no-ops when there is no launcher / workspaces.json', async () => {
    const res = await backfillCodexOverrideMarkers(join(root, 'nope'))
    expect(res).toEqual({ backfilled: 0, workspaces: 0 })
  })
})
