import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import type { CliAdapter, SpawnContext, WorkspaceAiCred } from '../cli-adapter.js';
import { readWorkspaceFile, writeWorkspaceFile } from '../file-service.js';

const SESSION_FILE_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

const CLAUDE_SETTINGS_PATH = '.claude/settings.local.json';

/**
 * CLI binaries every `injectTools` template (chat, steward) teaches the agent
 * to use via injected skills — see `CLI_TOOLS_SKILLS` in `context-injector.ts`
 * (keep this list in sync with that one). Pre-approving Bash access to these
 * specific, already-taught binaries is not a new capability grant: the skill
 * files already teach the agent to invoke them regardless of which template
 * spawned it.
 *
 * Without this, Claude Code's default permission model treats each
 * *subcommand family* (tool name + first positional arg — "alice-uta
 * account", "alice-uta order", "alice-uta market", ...) as its own one-time
 * approval gate: fine for a human-attended session (click through once per
 * family), fatal for an unattended steward wake (issue #92) — the PTY just
 * sits on an interactive "This command requires approval" prompt with no one
 * to answer it, until the wake's deadline timeout fires. Confirmed live
 * 2026-07-08 against a real steward wake session.
 *
 * `Bash(<tool> *)` is Claude Code's current "wildcard" match syntax (the
 * space-separated form; `Bash(<tool>:*)` colon-prefix matching still works
 * but is documented as legacy) — verified empirically against claude
 * 2.1.202 via a standalone PTY probe: a single `Bash(alice-uta *)` entry
 * covers every subcommand family (account/order/market/git/...) in one rule,
 * not just the first family used in a session, eliminating the repeated
 * per-family prompt entirely.
 *
 * Scope: applied globally to every claude spawn (interactive + headless),
 * not gated per-template. `SpawnContext` carries no template identity today
 * (see `cli-adapter.ts`), so scoping this to steward-only would mean
 * threading template identity through the adapter interface and every call
 * site — real plumbing cost for no added safety, since chat and steward (the
 * only two `injectTools` templates) already teach these same binaries
 * unconditionally.
 *
 * A Bash allow rule cannot cover everything: a heredoc body that embeds JSON
 * (e.g. `cat >> ledger.jsonl <<'EOF' ... EOF`, the steward's original
 * ledger-write pattern) trips a SEPARATE "Contains brace with quote
 * character (expansion obfuscation)" prompt — a static too-complex/
 * unparseable classification Claude Code applies before any
 * `permissions.allow` Bash rule is even consulted (verified empirically: it
 * still fires with a matching `Bash(cat *)` rule in place). Confirmed live
 * 2026-07-08 running a real steward campaign cell (issue #101): this
 * stalled an unattended wake at the ledger-write step with no one to answer
 * the prompt.
 *
 * The only path that fully clears it: skip Bash for that step entirely and
 * use Claude Code's native `Write`/`Edit` tool instead, pre-approved via the
 * bare tool names below (no path-scoped form like `Write(decisions.jsonl)`
 * or `Write(**)` worked in this Claude Code version — only the bare name
 * does). This is a materially broader grant than the Bash rules above: it
 * waives confirmation for the FIRST write/edit of any file in the session,
 * not just the ledger — a deliberate, maintainer-approved tradeoff (2026-07-
 * 09) specifically to unblock unattended steward campaign runs, not a
 * default this adapter would pick unprompted. `docs/steward-persistent-loop-
 * implementation.zh.md` §13 records the decision. This alone does not fix
 * anything by itself — the steward's ledger-write instructions (see the
 * `steward` template's `instruction.md`, issue #98) must actually tell the
 * agent to use the Write/Edit tool for this step rather than a Bash
 * heredoc, or the permission grant sits unused.
 */
const PRETRUSTED_BASH_TOOLS = ['alice', 'alice-analysis', 'alice-uta', 'alice-workspace', 'traderhub'];
const PRETRUSTED_FILE_TOOLS = ['Write', 'Edit'];

/**
 * Claude Code can park project-scoped MCP servers at "⏸ Pending approval" when
 * a workspace does provide them. New built-in OpenAlice templates no longer
 * write `.mcp.json` (the default tool path is the injected `alice*` CLI shims),
 * but keep the auto-trust setting at spawn so third-party/satellite workspaces
 * that do ship MCP config do not stall on first launch.
 */
const AUTOTRUST_SETTINGS = JSON.stringify({
  enableAllProjectMcpServers: true,
  permissions: {
    allow: [
      ...PRETRUSTED_BASH_TOOLS.map((bin) => `Bash(${bin} *)`),
      ...PRETRUSTED_FILE_TOOLS,
    ],
  },
});

/** dashed-cwd convention used by Claude Code's project store. */
function projectKey(workspaceDir: string): string {
  const abs = resolve(workspaceDir);
  return abs.replaceAll('/', '-').replaceAll('.', '-');
}

/**
 * The Claude Code adapter is the original launcher target. v2.M1 keeps its
 * behavior bit-identical with what shipped previously (`composeCommand` here
 * is the verbatim move of `index.ts:composeCommand` from before refactor).
 *
 * Tool access for built-in templates comes from the workspace-local `alice*`
 * CLI shims and skills. Claude's native MCP path is still tolerated for
 * third-party templates, but it is no longer the launcher-owned default.
 */
export const claudeAdapter: CliAdapter = {
  id: 'claude',
  displayName: 'Claude Code',
  binary: 'claude',
  namePrefix: 'c',
  capabilities: {
    parallelPerCwd: true,
    // `claude --continue` is intentionally NOT supported. It's a fragile
    // flag whose semantics ("continue most recent in cwd") fails hard when:
    //   - the projectKey dir is empty (PTY started but user never sent a
    //     message before pausing — common in practice)
    //   - multiple jsonl coexist in the dir (claude picks ambiguously and
    //     bails with "No conversation found to continue")
    //   - the most-recent session lacks a deferred-tool marker
    // It's also irrelevant to OpenAlice's model: we already track session
    // identity at the record layer, so "resume by id" is the only mode
    // that fits the workbench. Records without a resolved id get a fresh
    // spawn — better than a respawn loop into the circuit breaker.
    resumeLast: false,
    resumeById: true,
    transcriptDiscovery: 'fs-watch',
    headless: true,
  },

  composeCommand(base: readonly string[], ctx: SpawnContext): readonly string[] {
    const cmd = [...base, '--settings', AUTOTRUST_SETTINGS];
    if (ctx.resume === undefined) {
      // Quick-chat seed: `claude [flags] -- <prompt>` opens the interactive TUI
      // and auto-submits the prompt. The `--` end-of-options terminator (same as
      // the headless path) keeps a prompt starting with `-`/`--` from being
      // mis-parsed as a flag (claude accepts `--` interactively; verified).
      if (ctx.initialPrompt) return [...cmd, '--', ctx.initialPrompt];
      return cmd;
    }
    if (ctx.resume === 'last') {
      throw new Error(
        'claude adapter: "last" resume not supported — use --resume <sessionId> or undefined (fresh)',
      );
    }
    return [...cmd, '--resume', ctx.resume.sessionId];
  },

  // Headless: `claude -p` is non-interactive and exits at the turn boundary.
  // Tool access for built-in workspaces is through the injected CLI shims; do
  // not pass `--bare`, which sets CLAUDE_CODE_SIMPLE=1 and can disable project
  // features third-party templates may rely on. The prompt is the trailing
  // positional AFTER a `--` end-of-options terminator, so a prompt that starts
  // with `-`/`--` isn't mis-parsed as a flag (verified: without `--`, claude
  // errors out).
  // Output is `stream-json` (one event per line, REQUIRES --verbose — plain
  // `-p --output-format stream-json` errors out): the launcher gets live
  // progress in the task log AND every event carries `session_id`, so the
  // run's identity is captured from line 1 instead of parsed out of a final
  // result blob (verified 2.1.x, 2026-06-11).
  composeHeadlessCommand(base: readonly string[], _ctx: SpawnContext, prompt: string): readonly string[] {
    return [
      ...base,
      '--settings', AUTOTRUST_SETTINGS,
      '-p', '--output-format', 'stream-json', '--verbose',
      '--', prompt,
    ];
  },

  extractHeadlessSessionId(line: string): string | null {
    try {
      const evt = JSON.parse(line) as Record<string, unknown>;
      return typeof evt['session_id'] === 'string' ? evt['session_id'] : null;
    } catch {
      return null;
    }
  },

  async writeAiConfig(cwd: string, cred: WorkspaceAiCred): Promise<void> {
    const hasAny = cred.baseUrl || cred.apiKey || cred.model;
    if (!hasAny) {
      // Reset: delete the settings file so claude falls back to its global
      // OAuth / settings. We don't leave an empty `{}` behind — workspace
      // files exist only when there's an actual override.
      const filePath = join(cwd, CLAUDE_SETTINGS_PATH);
      await rm(filePath, { force: true });
      return;
    }
    const out: Record<string, unknown> = {};
    const env: Record<string, string> = {};
    if (cred.baseUrl) env['ANTHROPIC_BASE_URL'] = cred.baseUrl;
    // Write the key into exactly one env var. Bearer-mode gateways (MiniMax
    // international, proxy front-ends) read ANTHROPIC_AUTH_TOKEN → the CLI sends
    // `Authorization: Bearer`. Default x-api-key mode uses ANTHROPIC_API_KEY.
    // Never write both: Claude Code warns on dual-set, and the two headers
    // together can be rejected as ambiguous auth.
    if (cred.apiKey) {
      if (cred.authMode === 'bearer') env['ANTHROPIC_AUTH_TOKEN'] = cred.apiKey;
      else env['ANTHROPIC_API_KEY'] = cred.apiKey;
    }
    if (Object.keys(env).length > 0) out['env'] = env;
    if (cred.model) out['model'] = cred.model;
    await writeWorkspaceFile(cwd, CLAUDE_SETTINGS_PATH, JSON.stringify(out, null, 2) + '\n');
  },

  async readAiConfig(cwd: string): Promise<WorkspaceAiCred | null> {
    const raw = await readWorkspaceFile(cwd, CLAUDE_SETTINGS_PATH);
    if (raw === null) return null;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
    const env = (parsed['env'] ?? {}) as Record<string, unknown>;
    const baseUrl = typeof env['ANTHROPIC_BASE_URL'] === 'string' ? (env['ANTHROPIC_BASE_URL'] as string) : null;
    // The key lives in exactly one of two env vars depending on auth mode:
    // ANTHROPIC_API_KEY → x-api-key header, ANTHROPIC_AUTH_TOKEN → Bearer.
    // Which one is present tells us the mode to surface back to the modal.
    const xApiKey = typeof env['ANTHROPIC_API_KEY'] === 'string' ? (env['ANTHROPIC_API_KEY'] as string) : null;
    const authToken = typeof env['ANTHROPIC_AUTH_TOKEN'] === 'string' ? (env['ANTHROPIC_AUTH_TOKEN'] as string) : null;
    const authMode: 'x-api-key' | 'bearer' = authToken !== null ? 'bearer' : 'x-api-key';
    const apiKey = authToken ?? xApiKey;
    const model = typeof parsed['model'] === 'string' ? (parsed['model'] as string) : null;
    if (baseUrl === null && apiKey === null && model === null) return null;
    // Claude Code is anthropic-only.
    return { baseUrl, apiKey, model, authMode, wireShape: 'anthropic' };
  },

  transcriptDir(cwd: string): string {
    return join(homedir(), '.claude', 'projects', projectKey(cwd));
  },
  transcriptFileRe: SESSION_FILE_RE,
  extractSessionId(filename: string): string | null {
    const m = SESSION_FILE_RE.exec(filename);
    return m && m[1] ? m[1] : null;
  },
};
