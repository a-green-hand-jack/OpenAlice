import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { exec as gitExec } from 'dugite';
import { DEFAULT_AUTHZ_LEVEL } from '@traderalice/uta-protocol';

import { readCredentials, readWorkspaceCredentialDefaults } from '@/core/config.js';

import type { AdapterRegistry } from './cli-adapter.js';
import {
  injectWorkspaceContext,
  refreshWorkspaceInstructions,
  writeStewardContextManifest,
} from './context-injector.js';
import { injectWorkspaceCredentials } from './credential-injection.js';
import type { Logger } from './logger.js';
import { generatePetnameId } from './petname-id.js';
import type { AgentCredentialDecl, TemplateRegistry } from './template-registry.js';
import type { WorkspaceMeta, WorkspaceRegistry } from './workspace-registry.js';

export interface BootstrapEnv {
  /**
   * Optional path to an Auto-Quant clone the user wants to override the
   * managed mirror with. Templates that don't read `AQ_TEMPLATE_DIR`
   * ignore this. Empty string when env unset.
   */
  readonly templateDir: string;
  /** Absolute path to the launcher repo root (for `${AQ_LAUNCHER_REPO_ROOT}` references). */
  readonly launcherRepoRoot: string;
}

export interface CreatorOptions {
  readonly workspacesRoot: string;
  readonly templateRegistry: TemplateRegistry;
  readonly adapterRegistry: AdapterRegistry;
  readonly bootstrapEnv: BootstrapEnv;
  readonly bootstrapTimeoutMs: number;
  readonly registry: WorkspaceRegistry;
  readonly logger: Logger;
}

export type CreateResult =
  | { readonly ok: true; readonly workspace: WorkspaceMeta }
  | {
      readonly ok: false;
      readonly code:
        | 'invalid_tag'
        | 'tag_in_use'
        | 'bootstrap_failed'
        | 'injection_failed'
        | 'unknown_template'
        | 'unknown_agent';
      readonly message: string;
      readonly stderr?: string;
      readonly exitCode?: number;
    };

export type StewardRuntimeFace = 'pty' | 'machine';
export type StewardRuntimeRefreshResult =
  | {
      readonly ok: true;
      readonly desiredDigest: string;
      readonly forceFreshPty: boolean;
      readonly forceFreshMachine: boolean;
    }
  | {
      readonly ok: true;
      readonly desiredDigest?: never;
      readonly forceFreshPty?: never;
      readonly forceFreshMachine?: never;
    }
  | { readonly ok: false; readonly message: string };

export interface StewardRuntimeLeaseContext {
  /** Exact runtime/instruction generation protected by this lease. */
  readonly desiredDigest: string;
  /** This face has not yet acknowledged the protected generation. */
  readonly forceFresh: boolean;
}

export class StewardRuntimeRefreshError extends Error {
  constructor(public readonly detail: string) {
    super(`steward runtime refresh failed: ${detail}`);
    this.name = 'StewardRuntimeRefreshError';
  }
}

const STEWARD_RUNTIME_STATE_PATH = '.alice/steward/runtime-state.json';
const STEWARD_RUNTIME_STATE_VERSION = 1;
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;

interface StewardRuntimeState {
  readonly version: typeof STEWARD_RUNTIME_STATE_VERSION;
  readonly desiredDigest: string;
  readonly acknowledged: Readonly<Record<StewardRuntimeFace, string | null>>;
}

interface RecoveredStewardRuntimeState {
  readonly desiredDigest: string | null;
  readonly acknowledged: Readonly<Record<StewardRuntimeFace, string | null>>;
}

export interface CreateWorkspaceOptions {
  readonly agentsRequested?: readonly string[];
  readonly blind?: boolean;
  readonly blindAllowBarSources?: readonly string[];
}

const TAG_RE = /^[a-z0-9][a-z0-9_-]{0,32}$/;

/**
 * Resolve the adapter set a new workspace is created with. This is the single
 * home of the agent policy, so every create path — the form, quick-chat,
 * headless — converges on it:
 *
 * - An explicit `agentsRequested` (a caller pinning a subset) wins verbatim.
 * - Otherwise a workspace gets EVERY registered adapter enabled; restricting
 *   it was a create-time decision with no first-action basis. The template's
 *   `defaultAgents` is honored as an ordering hint for agent runtimes, while
 *   utility adapters such as `shell` are kept at the tail so they never become
 *   an implicit workload.
 *
 * This used to live in the frontend create hook alone, which silently left
 * backend-only callers (quick-chat) on the bare-`defaultAgents` set.
 */
export function resolveCreateAgents(
  agentsRequested: readonly string[] | undefined,
  templateDefaultAgents: readonly string[],
  allAdapterIds: readonly string[],
): readonly string[] {
  if (agentsRequested && agentsRequested.length > 0) return agentsRequested;
  const utility = new Set(['shell']);
  const ordered = [...new Set([...templateDefaultAgents, ...allAdapterIds])];
  return [
    ...ordered.filter((id) => !utility.has(id)),
    ...ordered.filter((id) => utility.has(id)),
  ];
}

function normalizeBlindAllowBarSources(sources: readonly string[]): readonly string[] {
  return [...new Set(sources.map((s) => s.trim()).filter((s) => s.length > 0))];
}

/**
 * Creates a workspace by invoking the template's bootstrap script.
 *
 * The launcher itself knows nothing about git, branches, or results.tsv —
 * each template's script encapsulates that. We give it `tag` + `outDir` +
 * a small env contract (`AQ_TEMPLATE_DIR`, `AQ_SHARED_DATA_DIR`,
 * `AQ_TEMPLATE_FILES_DIR`, `AQ_LAUNCHER_REPO_ROOT`), wait for exit 0, and
 * on success append the resulting WorkspaceMeta to the registry.
 */
export class WorkspaceCreator {
  private readonly stewardRuntimeRefreshes = new Map<string, Promise<StewardRuntimeRefreshResult>>();
  private readonly stewardRuntimeTransitions = new Map<string, Promise<void>>();

  constructor(private readonly opts: CreatorOptions) {}

  async create(
    tag: string,
    templateName: string,
    agentsRequestedOrOptions?: readonly string[] | CreateWorkspaceOptions,
    legacyOptions?: Omit<CreateWorkspaceOptions, 'agentsRequested'>,
  ): Promise<CreateResult> {
    const createOptions: CreateWorkspaceOptions = Array.isArray(agentsRequestedOrOptions)
      ? { ...(legacyOptions ?? {}), agentsRequested: agentsRequestedOrOptions }
      : { ...(agentsRequestedOrOptions ?? {}), ...(legacyOptions ?? {}) };
    if (!TAG_RE.test(tag)) {
      return {
        ok: false,
        code: 'invalid_tag',
        message: `tag must match ${TAG_RE.source}`,
      };
    }
    if (this.opts.registry.hasTag(tag)) {
      return { ok: false, code: 'tag_in_use', message: `tag in use: ${tag}` };
    }
    const template = this.opts.templateRegistry.get(templateName);
    if (!template) {
      return {
        ok: false,
        code: 'unknown_template',
        message: `unknown template: ${templateName}`,
      };
    }

    // Agent policy lives in `resolveCreateAgents` (this file) so every create
    // path — form, quick-chat, headless — converges on it.
    const agents = resolveCreateAgents(
      createOptions.agentsRequested,
      template.defaultAgents,
      this.opts.adapterRegistry.list().map((a) => a.id),
    );

    // Validate every requested adapter exists in the registry.
    for (const a of agents) {
      if (!this.opts.adapterRegistry.get(a)) {
        return {
          ok: false,
          code: 'unknown_agent',
          message: `unknown agent: ${a}`,
        };
      }
    }

    const id = generatePetnameId(templateName, {
      fallbackPrefix: 'workspace',
      isTaken: (candidate) =>
        this.opts.registry.hasId(candidate) ||
        existsSync(join(this.opts.workspacesRoot, candidate)),
    });
    const dir = join(this.opts.workspacesRoot, id);
    const log = this.opts.logger.child({ tag, id, dir, template: templateName, agents });

    log.info('bootstrap.start', { script: template.bootstrapScript });

    const result = await runScript(
      template.bootstrapScript,
      [tag, dir],
      {
        AQ_TEMPLATE_DIR: this.opts.bootstrapEnv.templateDir,
        AQ_TEMPLATE_FILES_DIR: template.filesDir,
        AQ_TEMPLATE_ROOT: template.templateDir,
        AQ_LAUNCHER_REPO_ROOT: this.opts.bootstrapEnv.launcherRepoRoot,
        // AQ_LAUNCHER_ROOT is intentionally NOT set here. bootstrap.sh's
        // ${AQ_LAUNCHER_ROOT:-$HOME/.openalice/workspaces} default matches
        // config.ts's default; a user-exported value flows in via
        // `process.env` inheritance (see `runScript()` below).
      },
      this.opts.bootstrapTimeoutMs,
    );

    if (!result.ok) {
      log.warn('bootstrap.failed', {
        exitCode: result.exitCode,
        stderr: result.stderr.slice(0, 4000),
      });
      // Surface the actual reason in the message, not just the exit code —
      // a null exit code (spawn failure: bash-not-found on Windows, timeout)
      // rendered as "code unknown" tells the user nothing, while result.stderr
      // already carries the why (e.g. the Git-for-Windows install hint).
      const reason = result.stderr.trim();
      const headline =
        result.exitCode === null
          ? 'bootstrap could not start'
          : `bootstrap script exited with code ${result.exitCode}`;
      return {
        ok: false,
        code: 'bootstrap_failed',
        message: reason ? `${headline}:\n${reason.slice(-500)}` : headline,
        stderr: result.stderr,
        ...(result.exitCode !== null ? { exitCode: result.exitCode } : {}),
      };
    }

    // Launcher-owned context injection (persona / skills / CLI playbooks, gated by the
    // template manifest), then the initial commit. The launcher — not the
    // bootstrap script — owns what lands in the workspace's first commit.
    try {
      await injectWorkspaceContext({ template, wsId: id, dir });
    } catch (err) {
      log.warn('inject.failed', { err });
      await rm(dir, { recursive: true, force: true });
      return {
        ok: false,
        code: 'injection_failed',
        message: `context injection failed: ${(err as Error).message}`,
      };
    }
    try {
      await commitInitial(dir, `${templateName}: ${tag}`);
    } catch (err) {
      log.warn('initial_commit.failed', { err });
      await rm(dir, { recursive: true, force: true });
      return {
        ok: false,
        code: 'injection_failed',
        message: `initial commit failed: ${(err as Error).message}`,
      };
    }

    // Per-adapter technical bootstrap (MCP wiring, trust entries, …). Each
    // adapter is responsible for idempotency. We log but don't fail the
    // workspace create on a single adapter's bootstrap failure — the user
    // can still use it manually, the launcher just won't have prepped it.
    for (const a of agents) {
      const adapter = this.opts.adapterRegistry.get(a);
      if (!adapter?.bootstrap) continue;
      try {
        await adapter.bootstrap({
          wsId: id,
          cwd: dir,
          launcherRepoRoot: this.opts.bootstrapEnv.launcherRepoRoot,
        });
      } catch (err) {
        log.warn('adapter.bootstrap_failed', { agent: a, err });
      }
    }

    // Credential seeding — runs POST-commit so the secret never lands in the
    // initial commit (the adapter config files are kept out of git by
    // `_common.sh`'s excludes; post-commit is the belt-and-braces). The source
    // is the user's per-agent workspace defaults (Settings › AI Provider) merged
    // with any template-declared `agentCredentials` — the template wins per agent
    // (explicit per-template intent), though in practice no in-repo template
    // declares them, so the user defaults are the effective source. Best-effort:
    // a miss (disabled agent, dangling slug, incompatible wire) warns + skips,
    // the workspace stays usable.
    try {
      const userDefaults = await readWorkspaceCredentialDefaults();
      const effective: Record<string, AgentCredentialDecl> = {
        ...userDefaults,
        ...(template.agentCredentials ?? {}),
      };
      if (Object.keys(effective).length > 0) {
        const credentials = await readCredentials();
        await injectWorkspaceCredentials({
          dir,
          agents,
          agentCredentials: effective,
          adapterRegistry: this.opts.adapterRegistry,
          credentials,
          logger: log,
        });
      }
    } catch (err) {
      log.warn('cred_inject.failed', { err });
    }

    const workspace: WorkspaceMeta = {
      id,
      tag,
      dir,
      createdAt: new Date().toISOString(),
      template: templateName,
      spawnedFromVersion: template.version,
      authzLevel: DEFAULT_AUTHZ_LEVEL,
      agents,
      ...(createOptions.blind === true ? { blind: true } : {}),
      ...(createOptions.blindAllowBarSources !== undefined
        ? { blindAllowBarSources: normalizeBlindAllowBarSources(createOptions.blindAllowBarSources) }
        : {}),
    };
    await this.opts.registry.add(workspace);
    log.info('bootstrap.ok', { stdout: result.stdout.slice(-400) });
    return { ok: true, workspace };
  }

  /**
   * Idempotently refresh a steward workspace's launcher-owned runtime artifacts
   * (issue #140 merge gate): re-run the template's bootstrap script in
   * `--refresh-runtime` mode, which updates ONLY validate-ledger.mjs, the steward
   * schema artifact and runtime directories, README/git-exclude launcher files,
   * authoritative AGENTS.md/CLAUDE.md, and the launcher-owned context manifest.
   * The current runtime/instruction digest is persisted with a per-face
   * acknowledgement, so a fresh PTY session/machine thread can acknowledge the
   * exact generation it loaded without a stale acknowledgement clearing a newer
   * generation. It never inits a repo and never touches user
   * content (config/wakes/ledger/finalize/drafts). A no-op for non-steward
   * workspaces. Wake dispatch uses `withStewardRuntimeLease` after its account
   * lock instead of consuming this method's cacheable result; this public refresh
   * remains the standalone maintenance/coalescing surface. Returns an actionable
   * error on failure.
   */
  async refreshStewardRuntime(
    meta: Pick<WorkspaceMeta, 'template' | 'dir'>,
  ): Promise<StewardRuntimeRefreshResult> {
    if (meta.template !== 'steward') return { ok: true };
    const active = this.stewardRuntimeRefreshes.get(meta.dir);
    if (active) return active;
    const refresh = this.withStewardRuntimeTransition(
      meta.dir,
      () => this.refreshStewardRuntimeSerialized(meta),
    );
    this.stewardRuntimeRefreshes.set(meta.dir, refresh);
    try {
      return await refresh;
    } finally {
      if (this.stewardRuntimeRefreshes.get(meta.dir) === refresh) {
        this.stewardRuntimeRefreshes.delete(meta.dir);
      }
    }
  }

  private async refreshStewardRuntimeSerialized(
    meta: Pick<WorkspaceMeta, 'template' | 'dir'>,
  ): Promise<StewardRuntimeRefreshResult> {
    const template = this.opts.templateRegistry.get('steward');
    if (!template) {
      return { ok: false, message: 'steward template is not registered; cannot refresh workspace runtime' };
    }
    const result = await runScript(
      template.bootstrapScript,
      ['--refresh-runtime', meta.dir],
      {
        AQ_TEMPLATE_DIR: this.opts.bootstrapEnv.templateDir,
        AQ_TEMPLATE_FILES_DIR: template.filesDir,
        AQ_TEMPLATE_ROOT: template.templateDir,
        AQ_LAUNCHER_REPO_ROOT: this.opts.bootstrapEnv.launcherRepoRoot,
      },
      this.opts.bootstrapTimeoutMs,
    );
    if (!result.ok) {
      const reason = result.stderr.trim();
      const headline =
        result.exitCode === null
          ? 'steward runtime refresh could not start'
          : `steward runtime refresh exited with code ${result.exitCode}`;
      return { ok: false, message: reason ? `${headline}: ${reason.slice(-500)}` : headline };
    }
    try {
      await refreshWorkspaceInstructions({ template, dir: meta.dir });
      await writeStewardContextManifest({ template, dir: meta.dir });
      const desiredDigest = await computeStewardRuntimeDigest(meta.dir);
      const current = await readStewardRuntimeState(meta.dir);
      const state: StewardRuntimeState = {
        version: STEWARD_RUNTIME_STATE_VERSION,
        desiredDigest,
        acknowledged: current.acknowledged,
      };
      await writeStewardRuntimeState(meta.dir, state);
      return {
        ok: true,
        desiredDigest,
        forceFreshPty: state.acknowledged.pty !== desiredDigest,
        forceFreshMachine: state.acknowledged.machine !== desiredDigest,
      };
    } catch (err) {
      return {
        ok: false,
        message: `steward launcher artifact refresh failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  async acknowledgeStewardRuntimeFresh(
    meta: Pick<WorkspaceMeta, 'template' | 'dir'>,
    face: StewardRuntimeFace,
    desiredDigest: string,
  ): Promise<boolean> {
    if (meta.template !== 'steward') return true;
    return this.withStewardRuntimeTransition(
      meta.dir,
      () => this.acknowledgeStewardRuntimeFreshSerialized(meta.dir, face, desiredDigest),
    );
  }

  /**
   * Hold the workspace runtime generation stable while a control face consumes
   * it. The authoritative refresh happens only after the caller has acquired
   * its account lock; every other refresh/ack queues behind this lease until
   * session/thread start, wake injection/turn-start, and the exact-generation
   * acknowledgement have completed. The callback must throw on an unsuccessful
   * dispatch so a failed face is never acknowledged.
   */
  async withStewardRuntimeLease<T>(
    meta: Pick<WorkspaceMeta, 'template' | 'dir'>,
    face: StewardRuntimeFace,
    operation: (runtime: StewardRuntimeLeaseContext) => Promise<T>,
  ): Promise<T> {
    if (meta.template !== 'steward') {
      throw new Error('steward runtime lease requires a steward workspace');
    }
    return this.withStewardRuntimeTransition(meta.dir, async () => {
      const refreshed = await this.refreshStewardRuntimeSerialized(meta);
      if (!refreshed.ok) throw new StewardRuntimeRefreshError(refreshed.message);
      if (refreshed.desiredDigest === undefined) {
        throw new StewardRuntimeRefreshError('steward refresh returned no runtime generation');
      }
      const forceFresh = face === 'pty'
        ? refreshed.forceFreshPty
        : refreshed.forceFreshMachine;
      const value = await operation({
        desiredDigest: refreshed.desiredDigest,
        forceFresh,
      });
      if (forceFresh) {
        const acknowledged = await this.acknowledgeStewardRuntimeFreshSerialized(
          meta.dir,
          face,
          refreshed.desiredDigest,
        );
        if (!acknowledged) {
          throw new Error(
            `steward runtime generation changed while ${face} lease was held`,
          );
        }
      }
      return value;
    });
  }

  private async acknowledgeStewardRuntimeFreshSerialized(
    workspaceDir: string,
    face: StewardRuntimeFace,
    desiredDigest: string,
  ): Promise<boolean> {
    const current = await readStewardRuntimeState(workspaceDir);
    if (current.desiredDigest !== desiredDigest) return false;
    await writeStewardRuntimeState(workspaceDir, {
      version: STEWARD_RUNTIME_STATE_VERSION,
      desiredDigest,
      acknowledged: {
        ...current.acknowledged,
        [face]: desiredDigest,
      },
    });
    return true;
  }

  private withStewardRuntimeTransition<T>(
    workspaceDir: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.stewardRuntimeTransitions.get(workspaceDir) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const settled = result.then(() => undefined, () => undefined);
    this.stewardRuntimeTransitions.set(workspaceDir, settled);
    return result.finally(() => {
      if (this.stewardRuntimeTransitions.get(workspaceDir) === settled) {
        this.stewardRuntimeTransitions.delete(workspaceDir);
      }
    });
  }
}

async function computeStewardRuntimeDigest(workspaceDir: string): Promise<string> {
  const [runtimeRaw, agentsRaw, claudeRaw] = await Promise.all([
    readFile(join(workspaceDir, '.alice/steward/runtime.json'), 'utf8'),
    readFile(join(workspaceDir, 'AGENTS.md'), 'utf8'),
    readFile(join(workspaceDir, 'CLAUDE.md'), 'utf8'),
  ]);
  const runtime = JSON.parse(runtimeRaw) as { protocol?: unknown };
  if (!Number.isInteger(runtime.protocol)) {
    throw new Error('.alice/steward/runtime.json has no integer protocol');
  }
  const digestInput = JSON.stringify({
    protocol: runtime.protocol,
    agentsSha256: sha256(agentsRaw),
    claudeSha256: sha256(claudeRaw),
  });
  return sha256(digestInput);
}

async function readStewardRuntimeState(
  workspaceDir: string,
): Promise<RecoveredStewardRuntimeState> {
  const empty: RecoveredStewardRuntimeState = {
    desiredDigest: null,
    acknowledged: { pty: null, machine: null },
  };
  try {
    const parsed = JSON.parse(
      await readFile(join(workspaceDir, STEWARD_RUNTIME_STATE_PATH), 'utf8'),
    ) as unknown;
    if (!isRecord(parsed) || parsed['version'] !== STEWARD_RUNTIME_STATE_VERSION) return empty;
    const acknowledged = isRecord(parsed['acknowledged']) ? parsed['acknowledged'] : {};
    return {
      desiredDigest: normalizeDigest(parsed['desiredDigest']),
      acknowledged: {
        pty: normalizeDigest(acknowledged['pty']),
        machine: normalizeDigest(acknowledged['machine']),
      },
    };
  } catch {
    return empty;
  }
}

async function writeStewardRuntimeState(
  workspaceDir: string,
  state: StewardRuntimeState,
): Promise<void> {
  const statePath = join(workspaceDir, STEWARD_RUNTIME_STATE_PATH);
  const stateDir = join(workspaceDir, '.alice/steward');
  const tmpPath = `${statePath}.tmp-${process.pid}-${randomUUID()}`;
  await mkdir(stateDir, { recursive: true });
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tmpPath, 'wx');
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tmpPath, statePath);
    await syncDirectory(stateDir);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(tmpPath, { force: true }).catch(() => undefined);
  }
}

async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, 'r');
    try {
      await handle.sync().catch(() => undefined);
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is unavailable on some platforms.
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeDigest(value: unknown): string | null {
  return typeof value === 'string' && SHA256_HEX_RE.test(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The launcher's initial commit — uniform across templates (the "Harness rule":
 * every workspace is a fresh-git repo with a clean initial commit, no inherited
 * history, no pushable remote). Replaces the old per-template `commit_initial`
 * bash helper, byte-identical in message + author. The bootstrap script has
 * already run `git init` and set excludes; we just stage and commit.
 */
export async function commitInitial(dir: string, message: string): Promise<void> {
  await runGit(dir, ['add', '.']);
  await runGit(dir, [
    '-c', 'user.email=launcher@local',
    '-c', 'user.name=launcher',
    'commit', '-q', '-m', message,
  ]);
}

// Routes through the bundled git (dugite) so the launcher's initial commit
// needs no system git — same reason the bootstrap scripts use _common.mjs's
// git(). dugite resolves with an exitCode (it only rejects when git fails to
// launch), so a non-zero exit is turned into a throw to preserve the old
// reject-on-failure contract.
async function runGit(dir: string, args: readonly string[]): Promise<void> {
  const r = await gitExec([...args], dir);
  if (r.exitCode !== 0) {
    throw new Error(`git ${args[0] ?? ''} exited ${r.exitCode}: ${String(r.stderr).slice(0, 500)}`);
  }
}

interface RunResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}

const WINDOWS_BASH_HINT =
  'hint: this template ships a bash bootstrap script. OpenAlice\'s built-in ' +
  'templates (chat, auto-quant) need no bash — only third-party templates do. ' +
  'To use this one, install Git for Windows from https://gitforwindows.org/ so ' +
  'bash is on PATH, or run OpenAlice from inside WSL2.';

/**
 * Run a bootstrap script.
 *
 * On macOS / Linux the script is invoked directly — the kernel reads the
 * `#!/usr/bin/env bash` shebang and launches bash. On Windows the kernel
 * doesn't read shebangs and there's no native bash, so we invoke bash
 * explicitly with the script as its first argument. This requires `bash`
 * to be on PATH, which Git for Windows provides under its default install
 * options (WSL also works if OpenAlice itself is run from inside WSL).
 *
 * Exported for unit testing — the platform branch needs coverage that
 * doesn't depend on which OS the tests happen to run on.
 */
export function runScript(
  script: string,
  args: readonly string[],
  extraEnv: { [key: string]: string },
  timeoutMs: number,
): Promise<RunResult> {
  const isMjs = script.endsWith('.mjs');
  const isWindows = process.platform === 'win32';

  // `.mjs` (built-in templates): run on the Electron-bundled Node. In the
  // packaged app `process.execPath` is the Electron binary; ELECTRON_RUN_AS_NODE
  // flips it to pure-Node mode (a harmless no-op for a plain `node` execPath in
  // dev). No bash, no shebang reliance → works on a bare Windows/Mac box.
  // `.sh` (third-party fallback): unix reads the `#!/usr/bin/env bash` shebang;
  // Windows has no native bash, so we invoke `bash <script>` explicitly, which
  // requires bash on PATH (Git for Windows / WSL).
  const cmd = isMjs ? process.execPath : isWindows ? 'bash' : script;
  const cmdArgs = isMjs || isWindows ? [script, ...args] : args;
  const env = isMjs
    ? { ...process.env, ...extraEnv, ELECTRON_RUN_AS_NODE: '1' }
    : { ...process.env, ...extraEnv };

  return new Promise((resolve) => {
    const child = spawn(cmd, cmdArgs, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;

    child.stdout.on('data', (c: Buffer) => stdoutChunks.push(c));
    child.stderr.on('data', (c: Buffer) => stderrChunks.push(c));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, 2000);
    }, timeoutMs);
    timer.unref();

    child.on('error', (err) => {
      clearTimeout(timer);
      const errMsg = (err as Error).message;
      // ENOENT on Windows when we tried `bash` (a `.sh` third-party template)
      // means Git Bash / WSL bash isn't on PATH — surface the install hint.
      // Built-in `.mjs` templates run on the bundled Node and never hit this.
      const hinted =
        !isMjs && isWindows && /ENOENT/i.test(errMsg) ? `${errMsg}\n${WINDOWS_BASH_HINT}` : errMsg;
      resolve({
        ok: false,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: `${hinted}\n${Buffer.concat(stderrChunks).toString('utf8')}`,
        exitCode: null,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (timedOut) {
        resolve({
          ok: false,
          stdout,
          stderr: `[timed out after ${timeoutMs}ms]\n${stderr}`,
          exitCode: code,
        });
        return;
      }
      resolve({
        ok: code === 0,
        stdout,
        stderr,
        exitCode: code,
      });
    });
  });
}
