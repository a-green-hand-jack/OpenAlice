import { describe, expect, it } from 'vitest';

import type { SpawnContext } from '../cli-adapter.js';
import { claudeAdapter } from './claude.js';

/**
 * Issue #92: an unattended steward wake stalls forever the first time the
 * live claude session runs a NEW `alice-uta` subcommand family (`account`,
 * then `order`, then `market`, ...) — Claude Code's default permission model
 * treats each as its own one-time "This command requires approval" gate, and
 * nobody is watching the PTY to answer it. Fix: widen the `--settings` JSON
 * every claude spawn already carries (`AUTOTRUST_SETTINGS`) with a
 * `permissions.allow` list pre-trusting the CLI binaries every `injectTools`
 * template teaches via skills (`CLI_TOOLS_SKILLS` in `context-injector.ts`).
 *
 * The actual "does this pattern stop the prompt" claim was verified live via
 * a standalone PTY probe against real claude 2.1.202 (not covered here —
 * vitest can't drive an interactive TUI). This spec only pins the
 * `composeCommand` / `composeHeadlessCommand` --settings contract so a future
 * refactor can't silently drop the allow list.
 */

function ctx(extra: Partial<SpawnContext> = {}): SpawnContext {
  return { cwd: '/tmp/ws', env: {}, ...extra };
}

function settingsArg(argv: readonly string[]): Record<string, unknown> {
  const i = argv.indexOf('--settings');
  expect(i).toBeGreaterThanOrEqual(0);
  return JSON.parse(argv[i + 1] as string) as Record<string, unknown>;
}

describe('claude adapter — permission pre-seed (issue #92)', () => {
  it('composeCommand carries a Bash allow rule for every taught CLI tool', () => {
    const settings = settingsArg(claudeAdapter.composeCommand(['claude'], ctx()));
    const permissions = settings['permissions'] as { allow: string[] };
    expect(permissions.allow).toEqual(
      expect.arrayContaining([
        'Bash(alice *)',
        'Bash(alice-analysis *)',
        'Bash(alice-uta *)',
        'Bash(alice-workspace *)',
        'Bash(traderhub *)',
      ]),
    );
  });

  it('composeCommand carries bare Write/Edit grants (maintainer-approved, unblocks the ledger-write step a Bash rule cannot cover)', () => {
    const settings = settingsArg(claudeAdapter.composeCommand(['claude'], ctx()));
    const permissions = settings['permissions'] as { allow: string[] };
    expect(permissions.allow).toEqual(expect.arrayContaining(['Write', 'Edit']));
  });

  it('composeHeadlessCommand carries the same allow list', () => {
    expect(claudeAdapter.composeHeadlessCommand).toBeDefined();
    const argv = claudeAdapter.composeHeadlessCommand!(['claude'], ctx(), 'run the checklist');
    const settings = settingsArg(argv);
    const permissions = settings['permissions'] as { allow: string[] };
    expect(permissions.allow).toEqual(expect.arrayContaining(['Bash(alice-uta *)']));
  });

  it('still carries the pre-existing MCP auto-trust flag (no regression)', () => {
    const settings = settingsArg(claudeAdapter.composeCommand(['claude'], ctx()));
    expect(settings['enableAllProjectMcpServers']).toBe(true);
  });

  it('allow rules use the wildcard-space form, not the legacy colon-prefix form', () => {
    const settings = settingsArg(claudeAdapter.composeCommand(['claude'], ctx()));
    const permissions = settings['permissions'] as { allow: string[] };
    for (const rule of permissions.allow) {
      expect(rule).not.toContain(':*');
    }
  });
});
