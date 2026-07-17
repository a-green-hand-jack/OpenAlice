/**
 * End-to-end check of the create flow, exercising the real moving parts in
 * order: bootstrap.mjs (run on the bundled Node + dugite's bundled git) →
 * launcher context injection → launcher initial commit. Proves the workspace
 * is a fresh-git repo with exactly one clean commit (the "Harness rule"), and
 * — via the PATH-stripped case — that creation needs NO system git or bash.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { injectWorkspaceContext } from './context-injector.js';
import { AdapterRegistry } from './cli-adapter.js';
import { logger } from './logger.js';
import { shellAdapter } from './adapters/shell.js';
import { TemplateRegistry, type TemplateMeta } from './template-registry.js';
import { WorkspaceCreator, commitInitial } from './workspace-creator.js';
import { WorkspaceRegistry } from './workspace-registry.js';

const HERE = fileURLToPath(new URL('.', import.meta.url)); // src/workspaces/
const CHAT_DIR = join(HERE, 'templates', 'chat');
const CHAT_FILES = join(CHAT_DIR, 'files');
const CHAT_BOOTSTRAP = join(CHAT_DIR, 'bootstrap.mjs');
const AQ_DIR = join(HERE, 'templates', 'auto-quant');
const AQ_BOOTSTRAP = join(AQ_DIR, 'bootstrap.mjs');
const STEWARD_DIR = join(HERE, 'templates', 'steward');
const STEWARD_FILES = join(STEWARD_DIR, 'files');
const STEWARD_BOOTSTRAP = join(STEWARD_DIR, 'bootstrap.mjs');

/**
 * Run a bootstrap.mjs exactly as the launcher's runScript does: on the bundled
 * Node (`process.execPath`) with ELECTRON_RUN_AS_NODE. `strip` removes git/bash
 * from PATH to prove the bare-machine path uses only dugite's embedded git.
 */
function runBootstrap(
  script: string,
  args: readonly string[],
  extraEnv: NodeJS.ProcessEnv,
  strip = false,
): Promise<string> {
  const env = strip
    ? { HOME: process.env.HOME, ELECTRON_RUN_AS_NODE: '1', PATH: '', ...extraEnv }
    : { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...extraEnv };
  return run(process.execPath, [script, ...args], env);
}

function autoQuantMeta(): TemplateMeta {
  return {
    name: 'auto-quant',
    bootstrapScript: AQ_BOOTSTRAP,
    filesDir: join(AQ_DIR, 'files'),
    instructionPath: join(AQ_DIR, 'files', 'instruction.md'),
    templateDir: AQ_DIR,
    version: '1.0.0',
    defaultAgents: ['claude', 'codex'],
    injectTools: false,
    injectPersona: false,
    bundledSkills: [],
  };
}

function run(cmd: string, args: readonly string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c: Buffer) => { out += c.toString(); });
    child.stderr.on('data', (c: Buffer) => { err += c.toString(); });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${err}`))));
  });
}

function chatMeta(): TemplateMeta {
  return {
    name: 'chat',
    bootstrapScript: CHAT_BOOTSTRAP,
    filesDir: CHAT_FILES,
    instructionPath: join(CHAT_FILES, 'instruction.md'),
    templateDir: CHAT_DIR,
    version: '1.0.0',
    defaultAgents: ['claude', 'codex'],
    injectTools: true,
    injectPersona: true,
    bundledSkills: ['scan-value-chain'],
  };
}

function stewardMeta(): TemplateMeta {
  return {
    name: 'steward',
    bootstrapScript: STEWARD_BOOTSTRAP,
    filesDir: STEWARD_FILES,
    instructionPath: join(STEWARD_FILES, 'instruction.md'),
    templateDir: STEWARD_DIR,
    version: '0.1.0',
    defaultAgents: ['codex'],
    injectTools: true,
    injectPersona: true,
    bundledSkills: [],
  };
}

let parent: string;
let dir: string;
beforeEach(async () => {
  parent = await mkdtemp(join(tmpdir(), 'ws-e2e-'));
  dir = join(parent, 'workspace');
});
afterEach(async () => {
  await rm(parent, { recursive: true, force: true });
});

describe('chat workspace create: bootstrap → inject → commit', () => {
  it('yields a fresh-git workspace with one clean launcher commit', async () => {
    // 1. real bootstrap.mjs — git init + README + excludes, NO commit. PATH
    //    stripped: proves a bare machine (no system git, no bash) still works
    //    via dugite's bundled git.
    await runBootstrap(CHAT_BOOTSTRAP, ['testtag', dir], { AQ_TEMPLATE_ROOT: CHAT_DIR }, true);
    // 2. launcher-owned injection
    await injectWorkspaceContext({ template: chatMeta(), wsId: 'ws-e2e-1', dir });
    // 3. launcher-owned initial commit
    await commitInitial(dir, 'chat: testtag');

    // injected files all present
    for (const rel of [
      'CLAUDE.md', 'AGENTS.md', 'README.md',
      '.claude/skills/scan-value-chain/SKILL.md',
      '.agents/skills/scan-value-chain/SKILL.md',
      '.pi/skills/scan-value-chain/SKILL.md',
      // per-CLI playbooks injected for every tool-bearing template
      '.claude/skills/alice/SKILL.md',
      '.claude/skills/alice-analysis/SKILL.md',
      '.claude/skills/alice-uta/SKILL.md',
      '.claude/skills/alice-workspace/SKILL.md',
      '.claude/skills/traderhub/SKILL.md',
    ]) {
      expect(existsSync(join(dir, rel)), rel).toBe(true);
    }

    // CLI-only injection: no MCP files are written at all
    expect(existsSync(join(dir, '.mcp.json'))).toBe(false);
    expect(existsSync(join(dir, '.pi/extensions/openalice-bridge.ts'))).toBe(false);

    // exactly one commit, launcher author, right message
    const log = await run('git', ['-C', dir, 'log', '--pretty=%an <%ae>%n%s']);
    expect(log.trim()).toBe('launcher <launcher@local>\nchat: testtag');

    // working tree is clean (injected files were committed, not left dangling)
    const status = await run('git', ['-C', dir, 'status', '--porcelain']);
    expect(status.trim()).toBe('');
  });
});

describe('auto-quant workspace create: clone → scrub → commit', () => {
  it('scrubs cloned history + remote into a fresh-git workspace with one launcher commit', async () => {
    // fake upstream: history + an origin pointing at the public repo
    const src = join(parent, 'fake-auto-quant');
    await run('git', ['init', '-q', '-b', 'main', src]);
    await writeFile(join(src, 'strategy.py'), 'print("hi")\n');
    await run('git', ['-C', src, 'add', '.']);
    await run('git', ['-C', src, '-c', 'user.email=u@x', '-c', 'user.name=u', 'commit', '-q', '-m', 'upstream history']);
    await run('git', ['-C', src, 'remote', 'add', 'origin', 'https://github.com/TraderAlice/Auto-Quant.git']);

    const aqDir = join(parent, 'aq-workspace');
    await runBootstrap(AQ_BOOTSTRAP, ['aqtag', aqDir], { AQ_TEMPLATE_DIR: src });
    // auto-quant injects nothing (all flags false); launcher still commits.
    await injectWorkspaceContext({ template: autoQuantMeta(), wsId: 'ws-aq-1', dir: aqDir });
    await commitInitial(aqDir, 'auto-quant: aqtag');

    // working tree carries the upstream content + the results scaffold...
    expect(existsSync(join(aqDir, 'strategy.py'))).toBe(true);
    expect(existsSync(join(aqDir, 'results.tsv'))).toBe(true);
    // ...but history + remote are scrubbed (the Harness rule)
    expect((await run('git', ['-C', aqDir, 'remote', '-v'])).trim()).toBe('');
    expect((await run('git', ['-C', aqDir, 'log', '--pretty=%s'])).trim()).toBe('auto-quant: aqtag');
    expect((await run('git', ['-C', aqDir, 'status', '--porcelain'])).trim()).toBe('');
    expect((await run('git', ['-C', aqDir, 'rev-parse', '--abbrev-ref', 'HEAD'])).trim()).toBe('autoresearch/aqtag');
  });
});

describe('chat workspace create — CLI-only injection (no MCP)', () => {
  it('injects the per-CLI alice*/traderhub skills and writes no MCP files', async () => {
    await runBootstrap(CHAT_BOOTSTRAP, ['clitag', dir], { AQ_TEMPLATE_ROOT: CHAT_DIR });
    await injectWorkspaceContext({ template: chatMeta(), wsId: 'ws-cli-1', dir });
    await commitInitial(dir, 'chat: clitag');

    expect(existsSync(join(dir, '.mcp.json'))).toBe(false);                          // no MCP injected
    expect(existsSync(join(dir, '.pi/extensions/openalice-bridge.ts'))).toBe(false); // no Pi bridge
    expect(existsSync(join(dir, '.claude/skills/alice-uta/SKILL.md'))).toBe(true);   // trading skill discoverable
    expect(existsSync(join(dir, '.claude/skills/traderhub/SKILL.md'))).toBe(true);
    expect(existsSync(join(dir, '.claude/skills/scan-value-chain/SKILL.md'))).toBe(true);
    expect(existsSync(join(dir, '.pi/skills/alice-uta/SKILL.md'))).toBe(true);  // Pi discovers .pi/skills
    expect((await run('git', ['-C', dir, 'status', '--porcelain'])).trim()).toBe('');
  });
});

describe('steward workspace create: scaffold → manifest → commit', () => {
  it('yields the steward file layout and versioned context manifest in the initial commit', async () => {
    await runBootstrap(STEWARD_BOOTSTRAP, ['stewardtag', dir], { AQ_TEMPLATE_ROOT: STEWARD_DIR }, true);
    await injectWorkspaceContext({ template: stewardMeta(), wsId: 'ws-steward-1', dir });
    await commitInitial(dir, 'steward: stewardtag');

    for (const rel of [
      'README.md',
      'AGENTS.md',
      'CLAUDE.md',
      '.alice/steward/README.md',
      '.alice/steward/config.json',
      '.alice/steward/context-manifest.json',
      '.alice/steward/validate-ledger.mjs',
      '.alice/steward/schemas/decision-ledger.v3.json',
      '.alice/steward/wakes/.gitkeep',
      '.alice/steward/ledger/decisions.jsonl',
      '.alice/steward/supervisor.jsonl',
      '.agents/skills/alice-uta/SKILL.md',
    ]) {
      expect(existsSync(join(dir, rel)), rel).toBe(true);
    }

    const config = JSON.parse(await readFile(join(dir, '.alice/steward/config.json'), 'utf8')) as {
      agent: string;
      sessionId: string | null;
      monthlyBudget: { modelUsd: number; serverUsd: number };
    };
    expect(config.agent).toBe('codex');
    expect(config.sessionId).toBeNull();
    expect(config.monthlyBudget).toEqual({ modelUsd: 200, serverUsd: 50 });

    const manifest = JSON.parse(await readFile(join(dir, '.alice/steward/context-manifest.json'), 'utf8')) as {
      template: { name: string; version: string };
      coreAgent: { id: string; model: string | null };
      wrapperPrompt: { path: string; sha256: string };
      instructions: Array<{ path: string }>;
      skills: Array<{ name: string }>;
      schemas: {
        wake: number;
        decisionLedger: number;
        decisionLedgerArtifact: { path: string; sha256: string };
      };
    };
    expect(manifest.template).toEqual({ name: 'steward', version: '0.1.0' });
    expect(manifest.coreAgent).toEqual({ id: 'codex', model: null });
    expect(manifest.wrapperPrompt.path).toBe('.alice/steward/README.md');
    expect(manifest.instructions.map((r) => r.path)).toEqual(['AGENTS.md', 'CLAUDE.md']);
    expect(manifest.skills.map((s) => s.name)).toContain('alice-uta');
    expect(manifest.schemas.wake).toBe(1);
    expect(manifest.schemas.decisionLedger).toBe(3);
    expect(manifest.schemas.decisionLedgerArtifact.path).toBe('.alice/steward/schemas/decision-ledger.v3.json');

    const excludes = await readFile(join(dir, '.git/info/exclude'), 'utf8');
    expect(excludes).toContain('.alice/steward/state.json');
    expect(excludes).toContain('.alice/steward/locks/');
    expect(excludes).toContain('.alice/steward/supervisor.jsonl');

    expect((await run('git', ['-C', dir, 'log', '--pretty=%s'])).trim()).toBe('steward: stewardtag');
    expect((await run('git', ['-C', dir, 'status', '--porcelain'])).trim()).toBe('');

    // regression (#87): the exclude entry must match the file the runtime
    // actually appends to on every supervisor tick (appendSupervisorEvent in
    // src/workspaces/steward/supervisor.ts writes to this exact path). Mimic
    // a tick's append here and prove it stays invisible to git status — the
    // whole point of the exclude per docs/steward-persistent-loop-implementation.zh.md §4.5.
    await appendFile(
      join(dir, '.alice/steward/supervisor.jsonl'),
      `${JSON.stringify({ at: '2026-01-01T00:00:00.000Z', type: 'cost_summary' })}\n`,
    );
    const statusAfterTick = await run('git', ['-C', dir, 'status', '--porcelain']);
    expect(statusAfterTick).not.toContain('supervisor.jsonl');
    expect(statusAfterTick.trim()).toBe('');
  });
});

describe('steward policy overlay: create and both runtime faces', () => {
  it('uses the startup snapshot for creation and PTY/machine runtime leases', async () => {
    const overlayRoot = join(parent, 'instruction-overlay');
    const overlayPolicy = join(overlayRoot, 'steward', 'files', 'policy.md');
    await mkdir(join(overlayRoot, 'steward', 'files'), { recursive: true });
    await Promise.all([
      writeFile(join(overlayRoot, 'steward', 'template.json'), JSON.stringify({ extends: 'steward', contractVersion: 1 }), 'utf8'),
      writeFile(overlayPolicy, '# steward policy startup snapshot\n', 'utf8'),
    ]);

    const templates = await TemplateRegistry.load(join(HERE, 'templates'), logger, overlayRoot);
    const registry = await WorkspaceRegistry.load(join(parent, 'registry.json'), logger);
    const adapters = new AdapterRegistry();
    adapters.register(shellAdapter, { default: true });
    const creator = new WorkspaceCreator({
      workspacesRoot: parent,
      templateRegistry: templates,
      adapterRegistry: adapters,
      bootstrapEnv: { templateDir: '', launcherRepoRoot: process.cwd() },
      bootstrapTimeoutMs: 60_000,
      registry,
      logger,
    });

    const created = await creator.create('overlay-steward', 'steward', ['shell']);
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.message);
    expect(await readFile(join(created.workspace.dir, 'AGENTS.md'), 'utf8')).toContain(
      '# steward policy startup snapshot',
    );
    expect(await readFile(join(created.workspace.dir, 'AGENTS.md'), 'utf8')).toContain(
      '## Platform Mechanics (OpenAlice-owned)',
    );
    await writeFile(overlayPolicy, '# steward policy changed on disk\n', 'utf8');

    const pty = await creator.withStewardRuntimeLease(created.workspace, 'pty', async (runtime) => runtime);
    const machine = await creator.withStewardRuntimeLease(created.workspace, 'machine', async (runtime) => runtime);
    expect(pty.forceFresh).toBe(true);
    expect(machine).toEqual({ desiredDigest: pty.desiredDigest, forceFresh: true });
    expect(await readFile(join(created.workspace.dir, 'AGENTS.md'), 'utf8')).toContain(
      '# steward policy startup snapshot',
    );
    expect(await readFile(join(created.workspace.dir, 'AGENTS.md'), 'utf8')).not.toContain(
      'policy changed on disk',
    );

    await expect(creator.withStewardRuntimeLease(
      created.workspace,
      'pty',
      async (runtime) => runtime,
    )).resolves.toEqual({ desiredDigest: pty.desiredDigest, forceFresh: false });
    await expect(creator.withStewardRuntimeLease(
      created.workspace,
      'machine',
      async (runtime) => runtime,
    )).resolves.toEqual({ desiredDigest: pty.desiredDigest, forceFresh: false });
    expect(JSON.parse(await readFile(join(created.workspace.dir, '.alice/steward/runtime-state.json'), 'utf8'))).toMatchObject({
      desiredDigest: pty.desiredDigest,
      acknowledged: { pty: pty.desiredDigest, machine: pty.desiredDigest },
    });
  });
});
