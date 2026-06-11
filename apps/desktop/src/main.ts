/**
 * Electron main process — OpenAlice's guardian.
 *
 * Responsibilities (MVP):
 *   1. Probe free ports for backend web + MCP (starts at 47331 to dodge the
 *      crowded 3000s range; auto-fallback if taken — local user never sees
 *      "Alice can't start" for a port collision).
 *   2. Spawn the backend (`dist/main.js`) as a child process with the
 *      chosen ports injected as env (`OPENALICE_WEB_PORT` /
 *      `OPENALICE_MCP_PORT` — picked up by `src/core/config.ts`'s
 *      env override). Single source of truth lives on the env channel for
 *      spawn-time-fixed values; runtime-mutable config still flows via
 *      file-reread.
 *   3. Wait for backend HTTP readiness, then open a BrowserWindow pointed
 *      at the same port (same-origin, no CORS surface).
 *   4. On quit: SIGTERM the backend, SIGKILL after 5s if it hangs.
 *
 * Out of scope (future iterations): tray icon, auto-update, code signing,
 * graceful-shutdown UX polish, multi-window, native menu integration.
 */

import { app, BrowserWindow, dialog } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { probeFreePort } from './probe-port.js'
import { relocateLegacyData } from './relocate-data.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

let backend: ChildProcess | null = null
let appQuitting = false

const DEFAULT_WEB_PORT_START = 47331
const READY_TIMEOUT_MS = 30_000
const SIGTERM_GRACE_MS = 5_000

// ── Port configuration ──────────────────────────────────────
// Inline mirror of scripts/guardian/shared.ts (the desktop package is a
// separate release surface — same reason probe-port.ts is duplicated).
// Keep semantics in sync: env > data/config/ports.json > default; broken
// or in-use explicit config fails loud.

function parsePort(raw: unknown, origin: string): number {
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`[guardian] invalid port ${JSON.stringify(raw)} from ${origin} — expected an integer in 1..65535`)
  }
  return n
}

async function readPortsFile(userDataHome: string): Promise<Partial<Record<'web' | 'mcp' | 'uta', number>>> {
  const filePath = resolve(userDataHome, 'data', 'config', 'ports.json')
  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch {
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`[guardian] ${filePath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`[guardian] ${filePath} must be a JSON object like {"web":47331,"mcp":47332,"uta":47333}`)
  }
  const out: Partial<Record<'web' | 'mcp' | 'uta', number>> = {}
  for (const name of ['web', 'mcp', 'uta'] as const) {
    const v = (parsed as Record<string, unknown>)[name]
    if (v !== undefined) out[name] = parsePort(v, `${filePath} ("${name}")`)
  }
  return out
}

/** Explicit (env/file) port → assert free or throw; unset → probe upward. */
async function claimPort(
  name: string,
  envKey: string,
  fileValue: number | undefined,
  probeStart: number,
): Promise<number> {
  const envRaw = process.env[envKey]
  const explicit =
    envRaw !== undefined && envRaw !== ''
      ? { value: parsePort(envRaw, envKey), origin: envKey }
      : fileValue !== undefined
        ? { value: fileValue, origin: 'data/config/ports.json' }
        : null
  if (explicit === null) return probeFreePort(probeStart)
  try {
    return await probeFreePort(explicit.value, explicit.value)
  } catch {
    throw new Error(
      `[guardian] port ${explicit.value} (${name}, from ${explicit.origin}) is already in use — free it or configure another port`,
    )
  }
}

async function waitForBackendReady(port: number, timeoutMs = READY_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      // 5xx still means the server is up; only treat connect errors as not-ready.
      const res = await fetch(`http://127.0.0.1:${port}/`, { method: 'GET' })
      if (res.status < 500) return
    } catch {
      // ECONNREFUSED etc. — backend not bound yet
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`backend did not become ready on port ${port} within ${timeoutMs}ms`)
}

app.whenReady().then(async () => {
  // Build output lives at <repo>/dist/electron/main.js and <repo>/dist/main.js
  // (sibling directories at <repo>/dist/). The desktop package source is at
  // apps/desktop/src/ but tsconfig.outDir is ../../dist/electron, so this
  // sibling-resolve is unchanged from the pre-split layout.
  const backendEntry = resolve(__dirname, '..', 'main.js')

  // Two homes — user data vs app resources. See src/core/paths.ts for why
  // they're split. User data lives at ~/.openalice in BOTH branches — one
  // store shared with `pnpm dev` and bare `pnpm start`, so accounts are
  // configured once, not per topology. App resources stay lifecycle-owned:
  // .app/Contents/Resources when packaged, the repo in dev.
  const repoRoot = resolve(__dirname, '..', '..')
  const userDataHome = join(homedir(), '.openalice')
  const homeEnv = app.isPackaged
    ? {
        OPENALICE_HOME: userDataHome,
        // .app/Contents/Resources/ — sibling of app.asar
        OPENALICE_APP_HOME: dirname(app.getAppPath()),
      }
    : {
        OPENALICE_HOME: userDataHome,
        OPENALICE_APP_HOME: repoRoot,
      }

  // Pre-global-root installs kept user data under Electron's userData dir.
  // Move it once, BEFORE ports.json is read from the new root and before the
  // backend boots (it would run migrations against an empty store). On
  // failure: surface and quit — booting beside the user's real data would
  // fork their trading history.
  if (app.isPackaged) {
    try {
      await relocateLegacyData(app.getPath('userData'), userDataHome)
    } catch (err) {
      dialog.showErrorBox(
        'OpenAlice — data relocation failed',
        `Could not move the user data store from\n${app.getPath('userData')}/data\nto\n${userDataHome}/data\n\n` +
          `${err instanceof Error ? err.message : String(err)}\n\nNothing was deleted. Please move the directory manually, then relaunch.`,
      )
      app.quit()
      return
    }
  }

  // Port precedence: env (OPENALICE_*_PORT) > data/config/ports.json (under
  // the user-data home, same L1 file the dev/prod guardians read) > probe
  // from the default. Explicitly configured ports fail loud when taken —
  // the user pinned them; silently drifting would break their bookmarks /
  // firewall rules. Unconfigured ports keep the probe-upward behavior.
  const portsFile = await readPortsFile(homeEnv.OPENALICE_HOME)
  const webPort = await claimPort('web', 'OPENALICE_WEB_PORT', portsFile.web, DEFAULT_WEB_PORT_START)
  const mcpPort = await claimPort('mcp', 'OPENALICE_MCP_PORT', portsFile.mcp, webPort + 1)

  backend = spawn(process.execPath, [backendEntry], {
    env: {
      ...process.env,
      // CRITICAL: without this, the spawned process tries to start as
      // another Electron "main process" (opens a new app instance) rather
      // than executing the JS file as Node. `process.execPath` is the
      // Electron binary in main-process context; only this env switches
      // it to pure-Node runtime mode.
      ELECTRON_RUN_AS_NODE: '1',
      OPENALICE_WEB_PORT: String(webPort),
      OPENALICE_MCP_PORT: String(mcpPort),
      // The desktop shell doesn't spawn UTA yet (Alice expects a Guardian
      // to provide OPENALICE_UTA_URL — known gap in the Electron topology).
      // Forward a ports.json uta value anyway so the L1 file behaves
      // uniformly once that wiring lands; explicit env still wins via the
      // ...process.env spread above.
      ...(portsFile.uta !== undefined && !process.env['OPENALICE_UTA_PORT']
        ? { OPENALICE_UTA_PORT: String(portsFile.uta) }
        : {}),
      // Hint for the backend (future use): we're under Electron, not a
      // bare `node dist/main.js`. Today nothing reads this; future
      // graceful-shutdown / update-flow code can branch on it.
      OPENALICE_LAUNCHER: 'electron',
      ...homeEnv,
    },
    stdio: 'inherit',
  })

  backend.once('exit', (code, signal) => {
    console.log(`[guardian] backend exited code=${code} signal=${signal}`)
    if (!appQuitting) app.quit()
  })

  console.log(`[guardian] backend pid=${backend.pid} webPort=${webPort} mcpPort=${mcpPort}`)

  await waitForBackendReady(webPort)

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'OpenAlice',
    webPreferences: {
      preload: resolve(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  win.loadURL(`http://localhost:${webPort}/`)
})

app.on('before-quit', (e) => {
  if (appQuitting) return
  if (!backend || backend.killed || backend.exitCode !== null) return
  appQuitting = true
  e.preventDefault()
  console.log(`[guardian] SIGTERM → backend pid=${backend.pid}`)
  backend.kill('SIGTERM')
  const sigkill = setTimeout(() => {
    if (backend && !backend.killed) {
      console.warn(`[guardian] backend did not exit after ${SIGTERM_GRACE_MS}ms → SIGKILL`)
      backend.kill('SIGKILL')
    }
  }, SIGTERM_GRACE_MS)
  backend.once('exit', () => {
    clearTimeout(sigkill)
    app.exit(0)
  })
})

app.on('window-all-closed', () => {
  // MVP: quit on last-window-close everywhere (including macOS).
  // Future: tray icon + macOS "stay alive in background" semantics so the
  // user can close the window without killing in-flight cron jobs.
  app.quit()
})
