import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { mkdir, open, readdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

import type { BootstrapContext, CliAdapter, ContextTelemetry, OnDiskSession, SpawnContext, WorkspaceAiCred } from '../cli-adapter.js';
import { readWorkspaceFile, writeWorkspaceFile } from '../file-service.js';

const CODEX_CONFIG_PATH = '.codex/config.toml';
const CODEX_ENV_PATH = '.codex/env.json';
const CODEX_KEY_ENV_NAME = 'OPENALICE_WORKSPACE_KEY';
const CODEX_PROVIDER_NAME = 'workspace';
const CODEX_MODEL_OVERRIDE_PATH = '.alice/steward/core-agent-model.txt';

/**
 * OpenAI Codex CLI (Rust rewrite, `codex-cli`).
 *
 * Verified empirically against `codex-cli 0.130.0` on macOS:
 * - Resume CLI: `codex resume --last` (= most recent for this cwd; codex
 *   filters by cwd by default), and `codex resume <uuid>` for a specific id.
 *   So the resume model is structurally the same as claude's `--continue` /
 *   `--resume <id>`, just expressed as a subcommand instead of a flag.
 * - Sessions live at `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`
 *   (uncompressed plain JSONL). The directory tree is **global, not
 *   per-cwd**, so transcript discovery via fs.watch is degenerate here —
 *   we'd see new files from every codex session on the machine, not just
 *   this workspace. v1 punts on this (`transcriptDiscovery: 'none'`); the
 *   `codex resume` picker is cwd-aware and handles the user-facing case.
 * - Trust model: codex prompts on first run for any cwd not in
 *   `~/.codex/config.toml` `[projects."<abs>"] trust_level`. `bootstrap()`
 *   pre-writes that entry so the launcher's spawn doesn't stall on the
 *   prompt.
 *
 * AI provider model — two modes, mutually exclusive:
 *
 *   1. **Default (no override).** Workspace has no `.codex/` directory.
 *      Adapter doesn't set `CODEX_HOME`. Codex reads the user's global
 *      `~/.codex/auth.json` + `~/.codex/config.toml` — exactly what a
 *      vanilla `codex` invocation in any project does. The OpenAlice MCP
 *      servers are wired via per-invocation `-c mcp_servers...url=...`
 *      flags in `composeCommand` below, so MCP is visible without polluting
 *      the user's global config.
 *
 *   2. **Override (user-configured via OpenAlice UI).** Workspace has its
 *      own `.codex/{config.toml, env.json[, auth.json]}`. Adapter sets
 *      `CODEX_HOME=<cwd>/.codex`. Codex reads workspace files only,
 *      isolated from global state.
 *
 * No symlinks, no global-fallback inheritance. The `-c` flag is OpenAlice's
 * workspace-scoped MCP registration — analogous to claude's `.mcp.json` cwd
 * discovery, but driven via codex's CLI override flag since codex has no
 * cwd-MCP convention of its own.
 */

export const codexAdapter: CliAdapter = {
  id: 'codex',
  displayName: 'Codex',
  binary: 'codex',
  namePrefix: 'x',
  capabilities: {
    parallelPerCwd: true,
    resumeLast: true,
    resumeById: true,
    // by-id resume (claude-level): codex can't be assigned an id at spawn, so
    // the watcher polls `listOnDisk` post-spawn — codex writes a global
    // `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` whose line-1 `session_meta`
    // carries { id, cwd }, so we attribute by cwd and persist the id as
    // resumeHint. Then `codex resume <id>` (composeCommand) resumes by id.
    transcriptDiscovery: 'subprocess',
    headless: true,
  },

  /**
   * Prepends MCP server flags only when OpenAlice's optional MCP server is
   * enabled. The default tool path is CLI-mode (`alice*` shell commands), so a
   * workspace must still spawn even when no MCP URL is present.
   */
  composeCommand(_base: readonly string[], ctx: SpawnContext): readonly string[] {
    const head = codexModelHead(ctx, codexMcpHead(ctx));
    if (ctx.resume === undefined) {
      // Quick-chat seed: `codex [-c …] -- <prompt>` opens the interactive TUI on
      // that prompt ("Optional user prompt to start the session" per `codex
      // --help`). `--` terminates options so a `-`-leading prompt is safe (codex
      // accepts `--` at the top level; verified). Seeding only on fresh spawns —
      // codex's `resume <id>` subcommand has no positional-prompt slot.
      if (ctx.initialPrompt) return [...head, '--', ctx.initialPrompt];
      return head;
    }
    if (ctx.resume === 'last') return [...head, 'resume', '--last'];
    return [...head, 'resume', ctx.resume.sessionId];
  },

  // Headless codex is CLI-MODE, NOT MCP: `codex exec` cancels EVERY MCP tool
  // call when there's no human to approve — even under approval_policy=never
  // (verified: "user cancelled MCP tool call") — so MCP is dead weight here.
  // Instead the agent reads data via `alice` and reports via `alice-workspace`
  // (shell commands codex runs autonomously). Three GLOBAL `-c` (before `exec`)
  // make that work:
  //   approval_policy=never                        — don't block on approval
  //   sandbox_mode=workspace-write                 — let it write the workspace
  //   sandbox_workspace_write.network_access=true  — let `alice*` reach the
  //                       loopback CLI gateway (else: "...fetch failed").
  // No mcp_servers head (interactive composeCommand keeps it — MCP works there
  // with a human approver). `--` terminates options before the trailing prompt.
  composeHeadlessCommand(_base: readonly string[], _ctx: SpawnContext, prompt: string): readonly string[] {
    const head = codexModelHead(_ctx, ['codex']);
    return [
      ...head,
      '-c',
      'approval_policy="never"',
      '-c',
      'sandbox_mode="workspace-write"',
      '-c',
      'sandbox_workspace_write.network_access=true',
      'exec',
      '--json',
      '--',
      prompt,
    ];
  },

  // `codex exec --json` line 1 is `{"type":"thread.started","thread_id":…}`;
  // the thread_id EQUALS the rollout's `session_meta.id` (verified 0.137.0,
  // 2026-06-11 — same uuid in ~/.codex/sessions/…/rollout-*.jsonl), so it
  // resumes via `codex resume <id>` like any interactively-captured id.
  extractHeadlessSessionId(line: string): string | null {
    try {
      const evt = JSON.parse(line) as Record<string, unknown>;
      if (evt['type'] !== 'thread.started') return null;
      return typeof evt['thread_id'] === 'string' ? evt['thread_id'] : null;
    } catch {
      return null;
    }
  },

  async writeAiConfig(cwd: string, cred: WorkspaceAiCred): Promise<void> {
    const hasProvider = !!(cred.baseUrl || cred.model);

    if (!hasProvider) {
      // Reset: tear down the workspace's entire `.codex/` directory. The
      // adapter's `composeEnv` won't set `CODEX_HOME` when the directory is
      // absent, so codex falls back to the user's global `~/.codex/`. We
      // don't leave empty stubs behind — workspace files exist only when
      // there's an actual override. Note: `CODEX_HOME` is exclusive (not a
      // merge layer), so a half-empty `.codex/` would *shadow* the user's
      // global login and break auth. Full teardown is the only safe reset.
      const codexDir = join(cwd, '.codex');
      await rm(codexDir, { recursive: true, force: true });
      return;
    }

    // Provider override. config.toml carries only model / model_provider /
    // [model_providers.*] — the OpenAlice MCP server entries are wired per-spawn
    // via this adapter's `-c mcp_servers...url=...` flags, so we
    // don't repeat it here.
    let toml = '';
    if (cred.model) toml += `model = ${tomlString(cred.model)}\n`;
    if (cred.baseUrl) toml += `model_provider = "${CODEX_PROVIDER_NAME}"\n`;
    if (cred.baseUrl) {
      toml += '\n';
      toml += `[model_providers.${CODEX_PROVIDER_NAME}]\n`;
      toml += `name = "OpenAlice workspace provider"\n`;
      toml += `base_url = ${tomlString(cred.baseUrl)}\n`;
      toml += `env_key = "${CODEX_KEY_ENV_NAME}"\n`;
      // Codex 0.130+ only speaks the OpenAI Responses API — it hard-rejects
      // wire_api="chat" — so this is always "responses" regardless of the
      // credential's wireShape. See memory reference_codex_chat_dead.
      toml += `wire_api = "responses"\n`;
    }
    await writeWorkspaceFile(cwd, CODEX_CONFIG_PATH, toml);

    // env.json: holds the per-workspace API key codex picks up via env_key.
    // composeEnv reads this and exports at spawn.
    if (cred.apiKey) {
      const envObj: Record<string, string> = { [CODEX_KEY_ENV_NAME]: cred.apiKey };
      await writeWorkspaceFile(cwd, CODEX_ENV_PATH, JSON.stringify(envObj, null, 2) + '\n');
    } else {
      await writeWorkspaceFile(cwd, CODEX_ENV_PATH, '{}\n');
    }
  },

  async readAiConfig(cwd: string): Promise<WorkspaceAiCred | null> {
    const tomlRaw = await readWorkspaceFile(cwd, CODEX_CONFIG_PATH);
    const envRaw = await readWorkspaceFile(cwd, CODEX_ENV_PATH);
    if (tomlRaw === null && envRaw === null) return null;

    let baseUrl: string | null = null;
    let wireApi: 'chat' | 'responses' | null = null;
    let model: string | null = null;
    if (tomlRaw) {
      // Shape-specific extraction: we always write the provider section as
      // `[model_providers.workspace]` with `base_url`, `wire_api`, plus
      // top-level `model`. Regex is brittle in general but our shape is
      // controlled (writer above produces deterministic output).
      const providerBlock = tomlRaw.match(/\[model_providers\.workspace\][^\[]*/);
      if (providerBlock) {
        const block = providerBlock[0];
        const base = block.match(/base_url\s*=\s*"([^"]*)"/);
        if (base) baseUrl = base[1] ?? null;
        const wire = block.match(/wire_api\s*=\s*"(chat|responses)"/);
        if (wire) wireApi = wire[1] as 'chat' | 'responses';
      }
      const modelMatch = tomlRaw.match(/^model\s*=\s*"([^"]*)"\s*$/m);
      if (modelMatch) model = modelMatch[1] ?? null;
    }

    let apiKey: string | null = null;
    if (envRaw) {
      try {
        const env = JSON.parse(envRaw) as Record<string, unknown>;
        const k = env[CODEX_KEY_ENV_NAME];
        if (typeof k === 'string') apiKey = k;
      } catch { /* ignore parse error, leave apiKey null */ }
    }

    if (baseUrl === null && apiKey === null && model === null && wireApi === null) return null;
    // Codex is Responses-only, so the unified wireShape is always openai-responses.
    return { baseUrl, apiKey, model, wireApi, wireShape: 'openai-responses' };
  },

  /**
   * Set `CODEX_HOME` only when workspace has its own `.codex/` directory
   * (override mode). Otherwise codex falls back to its own `~/.codex/`,
   * which is its normal behavior in any uninvolved project. The "reset
   * to default" UI action deletes the entire `.codex/` directory so the
   * adapter naturally falls back here.
   *
   * `.codex/env.json` is OpenAlice's per-workspace key bridge. Codex's
   * `[model_providers.X].env_key` field indirects through an env var; the
   * UI writes the chosen key into `env.json` and the adapter exports it
   * at spawn so codex's `env_key` lookup resolves. This is the only place
   * we bridge file → env, and the source of truth is still the workspace
   * file (not OpenAlice's internal state).
   */
  composeEnv(ctx: SpawnContext): Record<string, string> {
    const result: Record<string, string> = {};
    const workspaceCodex = join(ctx.cwd, '.codex');
    if (!existsSync(workspaceCodex)) return result;
    result['CODEX_HOME'] = workspaceCodex;
    const envFile = join(workspaceCodex, 'env.json');
    if (existsSync(envFile)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(envFile, 'utf8'));
        if (parsed && typeof parsed === 'object') {
          for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof v === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
              result[k] = v;
            }
          }
        }
      } catch {
        // ignore parse errors; file is user-editable and v1 doesn't surface
      }
    }
    return result;
  },

  async bootstrap(ctx: BootstrapContext): Promise<void> {
    await ensureTrustedProject(ctx.cwd);
  },

  /**
   * List codex sessions belonging to THIS workspace cwd, for the transcript
   * watcher's post-spawn id capture (codex can't be assigned an id at spawn).
   * Sessions live at `$CODEX_HOME/sessions` (override mode) or
   * `~/.codex/sessions` (default), partitioned `YYYY/MM/DD`, GLOBAL across all
   * cwds. We read each rollout's line-1 `session_meta { id, cwd }` (written at
   * session start) and keep only those whose cwd matches — scanning just the
   * newest dated leaves since a just-spawned session is today's.
   */
  async listOnDisk(cwd: string): Promise<readonly OnDiskSession[]> {
    const root = existsSync(join(cwd, '.codex'))
      ? join(cwd, '.codex', 'sessions')
      : join(homedir(), '.codex', 'sessions');
    const target = resolve(cwd);
    const out: OnDiskSession[] = [];
    for (const leaf of await recentDatedLeaves(root, 2)) {
      let files: string[];
      try {
        files = await readdir(leaf);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!CODEX_ROLLOUT_RE.test(f)) continue;
        const fp = join(leaf, f);
        try {
          const meta = JSON.parse(await firstLine(fp)) as {
            type?: string;
            payload?: { id?: string; cwd?: string };
          };
          const id = meta.payload?.id;
          const rolloutCwd = meta.payload?.cwd;
          if (meta.type !== 'session_meta' || typeof id !== 'string' || typeof rolloutCwd !== 'string') continue;
          if (resolve(rolloutCwd) !== target) continue;
          const st = await stat(fp);
          out.push({ sessionId: id, file: fp, mtime: st.mtime.toISOString(), sizeBytes: st.size });
        } catch {
          // partial / unreadable rollout — skip
        }
      }
    }
    return out;
  },

  /**
   * Latest context-window telemetry for `sessionId` (issue #132). Locates the
   * session's rollout via `listOnDisk` (cwd-attributed), then reads the tail
   * of its `token_count` events. Best-effort: any miss (no rollout on disk yet,
   * no token event, unreadable file) returns null so a wake is never blocked.
   */
  async readContextTelemetry(cwd: string, sessionId: string): Promise<ContextTelemetry | null> {
    return readCodexContextTelemetry(cwd, sessionId);
  },
};

/**
 * Find `sessionId`'s rollout among this cwd's on-disk codex sessions and read
 * the newest `token_count` event's `input_tokens` / `model_context_window`.
 * Shares `listOnDisk`'s cwd-attribution + recent-leaf scan (a persistent
 * steward session actively receiving wakes keeps its rollout in a recent dated
 * leaf), so it inherits the same discovery window. Returns null on any miss.
 */
export async function readCodexContextTelemetry(cwd: string, sessionId: string): Promise<ContextTelemetry | null> {
  const sessions = await codexAdapter.listOnDisk!(cwd);
  const match = sessions.find((s) => s.sessionId === sessionId);
  if (!match) return null;
  const tail = await readLastTokenCount(match.file);
  if (!tail) return null;
  return { inputTokens: tail.inputTokens, modelContextWindow: tail.modelContextWindow, source: match.file };
}

/**
 * Stream a codex rollout JSONL and return the LAST `token_count` event's
 * `payload.info.total_token_usage.input_tokens` +
 * `payload.info.model_context_window`. Streams line-by-line (a rollout can hold
 * a many-KB degenerate turn) and only JSON-parses lines that mention
 * `token_count`. Returns null when the file has no usable token_count event.
 */
export async function readLastTokenCount(
  fp: string,
): Promise<{ inputTokens: number; modelContextWindow: number } | null> {
  let input: ReturnType<typeof createReadStream>;
  try {
    input = createReadStream(fp, { encoding: 'utf8' });
  } catch {
    return null;
  }
  const rl = createInterface({ input, crlfDelay: Infinity });
  let latest: { inputTokens: number; modelContextWindow: number } | null = null;
  try {
    for await (const line of rl) {
      if (!line.includes('"token_count"')) continue;
      try {
        const evt = JSON.parse(line) as {
          payload?: {
            type?: string;
            info?: {
              total_token_usage?: { input_tokens?: unknown };
              model_context_window?: unknown;
            };
          };
        };
        if (evt.payload?.type !== 'token_count') continue;
        const inputTokens = evt.payload.info?.total_token_usage?.input_tokens;
        const modelContextWindow = evt.payload.info?.model_context_window;
        if (typeof inputTokens === 'number' && typeof modelContextWindow === 'number') {
          latest = { inputTokens, modelContextWindow };
        }
      } catch {
        // malformed line — skip, keep the last good token_count
      }
    }
  } catch {
    // read error mid-stream — return whatever we captured (possibly null)
  } finally {
    rl.close();
    input.destroy();
  }
  return latest;
}

/**
 * Optional `codex -c mcp_servers.*` head. When MCP is disabled, return the
 * bare codex command and let the workspace use the injected `alice*` CLIs.
 *
 * Reads OPENALICE_MCP_URL / AQ_WS_ID from the spawn-bound env and points Codex
 * at `/mcp/:wsId`, the workspace-scoped union catalog. Do not also register
 * the global `/mcp` server here: that bypasses the Steward authz filter.
 */
function codexMcpHead(ctx: SpawnContext): string[] {
  const base = [
    'codex',
    '-c',
    'sandbox_mode="workspace-write"',
    '-c',
    'sandbox_workspace_write.network_access=true',
  ];
  const mcpUrl = ctx.env['OPENALICE_MCP_URL'];
  if (!mcpUrl) {
    return base;
  }
  const workspaceId = ctx.env['AQ_WS_ID'];
  if (!workspaceId) {
    throw new Error('codex adapter: AQ_WS_ID missing from spawn env');
  }
  return [
    ...base,
    '-c',
    `mcp_servers.openalice.url="${mcpUrl}/${workspaceId}"`,
  ];
}

function codexModelHead(ctx: SpawnContext, head: string[]): string[] {
  const model = readCodexModelOverride(ctx.cwd);
  if (!model) return head;
  return [...head, '-m', model];
}

function readCodexModelOverride(cwd: string): string | null {
  const path = join(cwd, CODEX_MODEL_OVERRIDE_PATH);
  if (!existsSync(path)) return null;
  const model = readFileSync(path, 'utf8').trim();
  if (!/^[A-Za-z0-9._:-]+$/.test(model)) return null;
  return model;
}

const CODEX_ROLLOUT_RE = /^rollout-.*\.jsonl$/;

/** Newest `count` `YYYY/MM/DD` leaf dirs under a date-partitioned root. A
 *  just-spawned session is in today's leaf, so the newest few suffice. */
async function recentDatedLeaves(root: string, count: number): Promise<string[]> {
  const newestNumeric = async (dir: string, n: number): Promise<string[]> => {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return [];
    }
    return names
      .filter((x) => /^\d+$/.test(x))
      .sort()
      .reverse()
      .slice(0, n)
      .map((x) => join(dir, x));
  };
  const leaves: string[] = [];
  for (const y of await newestNumeric(root, 1)) {
    for (const m of await newestNumeric(y, 1)) {
      for (const d of await newestNumeric(m, count)) leaves.push(d);
    }
  }
  return leaves;
}

/** First line only — codex rollout line-1 (session_meta) can be many KB
 *  (it embeds the full base instructions), so stream rather than readFile. */
async function firstLine(fp: string): Promise<string> {
  const input = createReadStream(fp, { encoding: 'utf8' });
  const rl = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of rl) return line;
    return '';
  } finally {
    rl.close();
    input.destroy();
  }
}

export interface TrustProjectOptions {
  /** Override the shared codex config file. Default `~/.codex/config.toml`. */
  configPath?: string;
  /** Lock-acquisition budget before failing the bootstrap. Default 10s. */
  lockTimeoutMs?: number;
  /** A lock older than this is treated as stale and reclaimed. Default 30s. */
  lockStaleMs?: number;
  /** Poll interval while waiting for a contended lock. Default 50ms. */
  lockRetryMs?: number;
}

export function defaultCodexConfigPath(): string {
  return join(homedir(), '.codex', 'config.toml');
}

/**
 * In-process serialization: one promise queue per config file. Six concurrent
 * workspace bootstraps in the SAME Alice process (session pool / headless
 * dispatch) all target one `~/.codex/config.toml`; without this they'd
 * interleave read-modify-write and lose blocks. Keyed by the resolved config
 * path so distinct config files never block each other.
 */
const trustConfigQueues = new Map<string, Promise<unknown>>();

/**
 * Add (or no-op if present) a `[projects."<abs>"] trust_level = "trusted"`
 * entry to `~/.codex/config.toml`. We don't bring in a TOML library because
 * the section grammar is simple and we only ever APPEND one section per
 * workspace — unrelated user config is preserved byte-for-byte.
 *
 * Concurrency safety (issue #124): six concurrent bootstraps used to do an
 * uncoordinated read-modify-write of this shared file, so blocks were lost or
 * the file ended up malformed TOML, stalling every Codex steward wake. This is
 * now guarded on two layers — an in-process promise queue (same-process
 * bootstraps) AND a cross-process `O_EXCL` lock file with stale-lock reclaim
 * (different processes) — and the read-check-modify-write all happens inside
 * the critical section so a block appended by a concurrent writer is never
 * lost. Persistence is atomic (unique temp + fsync + rename), so a failure can
 * never leave `config.toml` truncated.
 *
 * If the project is already present we leave the file alone, regardless of
 * what value it has (the user may have set `read_only` deliberately).
 */
export async function ensureTrustedProject(cwd: string, opts: TrustProjectOptions = {}): Promise<void> {
  const configPath = opts.configPath ?? defaultCodexConfigPath();
  // Canonicalize before both registering AND comparing (macOS `/tmp` →
  // `/private/tmp`) so a symlinked cwd doesn't register a second, divergent
  // trust entry. The workspace dir may not exist yet on first bootstrap, so
  // fall back to a plain resolve() when realpath can't stat it.
  let abs: string;
  try {
    abs = await realpath(cwd);
  } catch {
    abs = resolve(cwd);
  }

  const prev = trustConfigQueues.get(configPath) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(() => trustProjectCritical(abs, configPath, opts));
  trustConfigQueues.set(configPath, run.catch(() => undefined));
  return run;
}

/** Lock-guarded read-check-modify-write + atomic persist. */
async function trustProjectCritical(abs: string, configPath: string, opts: TrustProjectOptions): Promise<void> {
  const dir = dirname(configPath);
  await mkdir(dir, { recursive: true });

  const lockPath = `${configPath}.lock`;
  const handle = await acquireConfigLock(lockPath, configPath, opts);
  try {
    let existing = '';
    try {
      existing = await readFile(configPath, 'utf8');
    } catch (err) {
      if (!isENOENT(err)) throw err;
    }

    // Match either single- or triple-bracket [projects."<path>"] headers.
    // Note: a pre-fix (#124) entry may have been registered under the
    // OLD non-canonical `resolve(cwd)` path (e.g. `/tmp/x` instead of the
    // realpath `/private/tmp/x` on macOS). That legacy entry won't match this
    // canonical header, so a second, canonical block can end up appended for
    // the same real project. Accepted as harmless — codex only reads
    // `trust_level` off whichever header matches its own (also realpath'd)
    // cwd going forward, and this file is user-editable regardless.
    const headerEsc = abs.replace(/[\\"]/g, (c) => `\\${c}`);
    const headerRe = new RegExp(
      `^\\[projects\\."${headerEsc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\]\\s*$`,
      'm',
    );
    if (headerRe.test(existing)) return; // already configured — don't clobber

    const block = `\n[projects."${headerEsc}"]\ntrust_level = "trusted"\n`;
    const next = existing.endsWith('\n') || existing.length === 0 ? existing + block : existing + '\n' + block;
    await atomicWrite(configPath, next);
  } finally {
    await releaseConfigLock(handle, lockPath);
  }
}

/**
 * Cross-process guard: create `<configPath>.lock` with `O_EXCL` (the `wx`
 * flag). If it already exists we wait; a lock older than `lockStaleMs` is a
 * crashed holder and gets reclaimed. Dependency-free, house style mirrors
 * `uta-supervisor/restart-trigger.ts` (atomic writes, bounded polling).
 *
 * Reclaim is race-free by construction: `rename()` is atomic, and a rename's
 * source path can only ever be consumed by ONE caller. When several waiters
 * independently observe the same stale lock (TOCTOU: they all `stat()` the
 * same old mtime), they all attempt
 * `rename(lockPath, <unique-per-waiter-tmp-name>)`. Exactly one succeeds —
 * the filesystem serializes that for us — and only that winner deletes the
 * dead lock and loops back to `open(wx)`; every other waiter's rename fails
 * with ENOENT (the path is already gone) and it simply retries `open(wx)`
 * too, contending fairly for the fresh lock the winner is about to create.
 * This avoids the earlier bug where two racers could both `stat()` the same
 * stale mtime, both reclaim via `rm`, and one's `rm` could delete the other's
 * freshly-created live lock.
 */
// Exported for the concurrent-reclaim regression spec, which needs to fire
// several racers directly against the SAME lock file without going through
// `ensureTrustedProject`'s in-process promise queue (that queue already
// fully serializes same-process callers, so it can never reproduce the
// cross-process TOCTOU this lock is guarding against — see codex.trust-config.spec.ts).
export async function acquireConfigLock(
  lockPath: string,
  configPath: string,
  opts: TrustProjectOptions,
): Promise<Awaited<ReturnType<typeof open>>> {
  const timeoutMs = opts.lockTimeoutMs ?? 10_000;
  const staleMs = opts.lockStaleMs ?? 30_000;
  const retryMs = opts.lockRetryMs ?? 50;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      const handle = await open(lockPath, 'wx');
      try {
        await handle.writeFile(`${process.pid} ${new Date().toISOString()}`, 'utf8');
      } catch (err) {
        // Successfully created the lock file but failed to write into it —
        // don't leak the fd or leave an orphaned (empty but live) lock file
        // behind for every future acquirer to trip over.
        await handle.close().catch(() => undefined);
        await rm(lockPath, { force: true }).catch(() => undefined);
        throw err;
      }
      return handle;
    } catch (err) {
      if (!isEEXIST(err)) throw err;
      // Contended — reclaim if the holder looks crashed, else wait.
      let stale = false;
      try {
        const st = await stat(lockPath);
        stale = Date.now() - st.mtimeMs > staleMs;
      } catch {
        continue; // lock vanished between open and stat — retry immediately
      }
      if (stale) {
        // Race-free reclaim — see doc comment above.
        const reclaimTmp = `${lockPath}.reclaim.${process.pid}.${randomUUID()}`;
        try {
          await rename(lockPath, reclaimTmp);
          await rm(reclaimTmp, { force: true });
        } catch {
          // Lost the reclaim race (source already gone) or another transient
          // error — either way, fall through and retry acquisition.
        }
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `codex trust config: could not acquire lock ${lockPath} within ${timeoutMs}ms — ` +
            `another codex bootstrap may be stuck. If none is running, delete ${lockPath} manually. ` +
            `${configPath} was left unchanged.`,
        );
      }
      await new Promise((r) => setTimeout(r, retryMs));
    }
  }
}

export async function releaseConfigLock(handle: Awaited<ReturnType<typeof open>>, lockPath: string): Promise<void> {
  try {
    await handle.close();
  } finally {
    await rm(lockPath, { force: true });
  }
}

/**
 * Atomic persist: write the full contents to a UNIQUE temp file (pid + random
 * suffix) in the same directory, fsync, then `rename` over the target. Never
 * truncates the live file, so a crash mid-write can't leave malformed TOML.
 */
async function atomicWrite(targetPath: string, contents: string): Promise<void> {
  const dir = dirname(targetPath);
  const base = targetPath.slice(dir.length + 1) || 'config.toml';
  const tmpPath = join(dir, `.${base}.${process.pid}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(tmpPath, 'w');
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(tmpPath, targetPath);
  } catch (err) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        /* ignore */
      }
    }
    await rm(tmpPath, { force: true }).catch(() => undefined);
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`codex trust config: failed to persist ${targetPath}: ${msg}. The file was left unchanged.`);
  }
}

function isEEXIST(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'EEXIST';
}

function isENOENT(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}

function tomlString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
