/**
 * 0013_codex_provider_override_marker — backfill the OpenAlice-owned
 * `.alice/codex-provider-override.marker` file for pre-existing workspaces
 * that already carry a genuine codex provider override written by the OLD
 * codex adapter (before issue #230's fix moved the `CODEX_HOME` /
 * `listOnDisk` / context-telemetry judgment off of ".codex/ directory
 * exists" and onto this marker).
 *
 * Why a strict six-literal signature and not "config.toml exists": issue
 * #230's investigation found the OLD adapter's ".codex/ directory exists"
 * check is accidentally satisfied by Codex CLI's OWN cold-start bootstrap
 * (it writes its own config.toml/sqlite/skills/sessions/version.json the
 * first time CODEX_HOME points at an empty/new home) and by unrelated
 * `.codex/agents/*.toml` subagent defs — so "a `.codex/config.toml` exists"
 * is NOT proof OpenAlice wrote it; it can be pure Codex-native pollution
 * left behind by the very bug this issue fixes. `isStrictLegacyCodexOverride`
 * below requires ALL SIX literal strings the OLD `writeAiConfig` hardcodes to
 * be present at once (provider name / env-key / wire_api / top-level
 * model_provider, plus a JSON-object env.json) — a coincidence across all six
 * is not realistically possible from Codex's own generated content (verified
 * against both a real repro's polluted config.toml and the
 * codex.trust-config.spec.ts SEED fixture, itself modeled on a real
 * ~/.codex/config.toml; neither satisfies any of the six).
 *
 * Known, deliberately accepted gap: a workspace whose override only set
 * `cred.model` (no `cred.baseUrl`) produces a `config.toml` with just
 * `model = "..."` — indistinguishable from Codex-native/user content, so it
 * is NOT backfilled here. Its adapter falls back to the global login until
 * the user re-saves a provider config in the UI, which writes a fresh marker.
 *
 * Frozen, self-contained point-in-time artifact (mirrors
 * 0010_workspace_issues_to_markdown's doc comment): it inlines its own copy
 * of the constants and signature check rather than importing
 * `src/workspaces/adapters/codex.ts`, so it keeps behaving correctly even as
 * that adapter's logic evolves further. Data lives outside `data/` — in each
 * workspace checkout under the launcher root (`AQ_LAUNCHER_ROOT`, else
 * `~/.openalice/workspaces`) — so the body resolves the launcher root itself
 * and uses raw fs; the config-scoped `ctx` is unused.
 *
 * Idempotent: a workspace that already has the marker is skipped. A single
 * bad workspace (permission error, malformed JSON/TOML) is logged and
 * skipped — never blocks startup.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import type { Migration } from '../types.js'

/** Mirror of the launcher-root resolution in `src/workspaces/config.ts`. Inlined
 *  (not imported) to keep this migration frozen against that module's evolution. */
function defaultLauncherRoot(): string {
  return resolve(process.env['AQ_LAUNCHER_ROOT'] ?? join(homedir(), '.openalice', 'workspaces'))
}

const CODEX_CONFIG_REL = '.codex/config.toml'
const CODEX_ENV_REL = '.codex/env.json'
const CODEX_OVERRIDE_MARKER_REL = '.alice/codex-provider-override.marker'

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

async function readIfExists(p: string): Promise<string | null> {
  try {
    return await readFile(p, 'utf-8')
  } catch {
    return null
  }
}

/**
 * Frozen copy of `src/workspaces/adapters/codex.ts`'s
 * `isStrictLegacyCodexOverride` (issue #230) — see the module doc comment
 * above for why a strict six-literal match is required instead of "a
 * `.codex/config.toml` exists".
 */
async function isStrictLegacyCodexOverride(workspaceDir: string): Promise<boolean> {
  const envRaw = await readIfExists(join(workspaceDir, CODEX_ENV_REL))
  if (envRaw === null) return false
  try {
    const parsed: unknown = JSON.parse(envRaw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false
    const keys = Object.keys(parsed as Record<string, unknown>)
    const isEmptyShape = keys.length === 0
    const isKeyOnlyShape = keys.length === 1
      && keys[0] === 'OPENALICE_WORKSPACE_KEY'
      && typeof (parsed as Record<string, unknown>)['OPENALICE_WORKSPACE_KEY'] === 'string'
    if (!isEmptyShape && !isKeyOnlyShape) return false
  } catch {
    return false
  }

  const tomlRaw = await readIfExists(join(workspaceDir, CODEX_CONFIG_REL))
  if (tomlRaw === null) return false

  const providerBlock = tomlRaw.match(/\[model_providers\.workspace\][^[]*/)
  if (!providerBlock) return false
  const block = providerBlock[0]

  const hasName = /name\s*=\s*"OpenAlice workspace provider"/.test(block)
  const hasEnvKey = /env_key\s*=\s*"OPENALICE_WORKSPACE_KEY"/.test(block)
  const hasWire = /wire_api\s*=\s*"responses"/.test(block)
  const hasTopLevelProvider = /^model_provider\s*=\s*"workspace"\s*$/m.test(tomlRaw)

  return hasName && hasEnvKey && hasWire && hasTopLevelProvider
}

interface WsMeta {
  dir?: unknown
}

/**
 * Backfill `.alice/codex-provider-override.marker` for every workspace under
 * `launcherRoot` whose `.codex/{config.toml,env.json}` satisfy the strict
 * legacy signature. Exported so the spec can drive it against a temp
 * launcher root. Never throws on a single bad workspace.
 */
export async function backfillCodexOverrideMarkers(
  launcherRoot: string = defaultLauncherRoot(),
): Promise<{ backfilled: number; workspaces: number }> {
  let registryRaw: string
  try {
    registryRaw = await readFile(join(launcherRoot, 'workspaces.json'), 'utf-8')
  } catch {
    return { backfilled: 0, workspaces: 0 } // no launcher / no workspaces yet — fresh install
  }

  let dirs: string[]
  try {
    const parsed = JSON.parse(registryRaw) as { workspaces?: WsMeta[] }
    dirs = Array.isArray(parsed.workspaces)
      ? parsed.workspaces.map((w) => (typeof w?.dir === 'string' ? w.dir : '')).filter(Boolean)
      : []
  } catch {
    return { backfilled: 0, workspaces: 0 }
  }

  let backfilled = 0
  let touched = 0
  for (const dir of dirs) {
    try {
      const markerPath = join(dir, CODEX_OVERRIDE_MARKER_REL)
      if (await exists(markerPath)) continue // already migrated (or already new) — idempotent

      if (!(await isStrictLegacyCodexOverride(dir))) continue // no proven OpenAlice override — leave alone

      await mkdir(dirname(markerPath), { recursive: true })
      const tmp = `${markerPath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
      await writeFile(tmp, '', 'utf-8')
      await rename(tmp, markerPath)
      backfilled++
      touched++
      console.log(
        `[migration 0013] ${dir}: backfilled ${CODEX_OVERRIDE_MARKER_REL} for a strict-signature legacy codex override`,
      )
    } catch (err) {
      console.log(`[migration 0013] skipped ${dir}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return { backfilled, workspaces: touched }
}

export const migration: Migration = {
  id: '0013_codex_provider_override_marker',
  appVersion: '0.73.0-beta',
  introducedAt: '2026-07-15',
  affects: [
    'workspaces/<id>/.codex/config.toml',
    'workspaces/<id>/.codex/env.json',
    'workspaces/<id>/.alice/codex-provider-override.marker',
  ],
  summary:
    'Backfill .alice/codex-provider-override.marker for workspaces with a proven legacy codex provider override (issue #230).',
  rationale:
    'Issue #230: composeEnv/listOnDisk/readCodexContextTelemetry moved from ".codex/ directory exists" (falsely satisfied by Codex CLI\'s own cold-start bootstrap and by unrelated .codex/agents/*.toml subagent defs) to an OpenAlice-owned marker file. Pre-existing workspaces that genuinely configured a codex provider override before the fix have no marker; this one-time, idempotent migration backfills it using a strict six-literal signature match so genuinely Codex-native content is never misclassified.',
  up: async () => {
    await backfillCodexOverrideMarkers()
  },
}
