/**
 * Golden / characterization test for launcher-owned context injection. The
 * MCP bytes are asserted exactly; the persona composition is asserted to equal
 * `persona + "\n\n---\n\n" + <template>/CLAUDE.md` — byte-identical to what the
 * old `compose_persona_claude_md` bash produced. Skills are asserted to land in
 * both discovery paths.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { dataPath, defaultPath } from '@/core/paths.js';

import { injectWorkspaceContext, refreshWorkspaceInstructions } from './context-injector.js';
import type { TemplateMeta } from './template-registry.js';

// src/workspaces/ — this spec's directory.
const HERE = fileURLToPath(new URL('.', import.meta.url));
const CHAT_FILES = join(HERE, 'templates', 'chat', 'files');
const STEWARD_DIR = join(HERE, 'templates', 'steward');
const STEWARD_FILES = join(STEWARD_DIR, 'files');

function makeTemplate(over: Partial<TemplateMeta>): TemplateMeta {
  return {
    name: 'test',
    bootstrapScript: '',
    filesDir: '',
    instructionPath: '',
    templateDir: '',
    version: '0.0.0',
    defaultAgents: ['claude'],
    injectTools: false,
    injectPersona: false,
    bundledSkills: [],
    ...over,
  };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'inject-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const read = (rel: string): Promise<string> => readFile(join(dir, rel), 'utf8');
const sha256 = async (rel: string): Promise<string> =>
  createHash('sha256').update(await readFile(join(dir, rel))).digest('hex');

describe('injectWorkspaceContext — no MCP injection (CLI-only)', () => {
  it('never writes .mcp.json, even for a tool-bearing template', async () => {
    await injectWorkspaceContext({ template: makeTemplate({ injectTools: true }), wsId: 'ws-abc', dir });
    expect(existsSync(join(dir, '.mcp.json'))).toBe(false);
  });

  it('never writes the Pi MCP bridge extension', async () => {
    await injectWorkspaceContext({ template: makeTemplate({ injectTools: true }), wsId: 'ws-abc', dir });
    expect(existsSync(join(dir, '.pi/extensions/openalice-bridge.ts'))).toBe(false);
  });
});

describe('injectWorkspaceContext — persona', () => {
  it('composes persona + separator + template instruction into CLAUDE.md and AGENTS.md', async () => {
    // Mirror the injector's persona precedence: a live data/brain/persona.md
    // override wins over the shipped default.
    const personaPath = existsSync(dataPath('brain', 'persona.md'))
      ? dataPath('brain', 'persona.md')
      : defaultPath('persona.default.md');
    const persona = await readFile(personaPath, 'utf8');
    const instruction = await readFile(join(CHAT_FILES, 'instruction.md'), 'utf8');
    const expected = `${persona}\n\n---\n\n${instruction}`;

    await injectWorkspaceContext({
      template: makeTemplate({
        injectPersona: true,
        filesDir: CHAT_FILES,
        instructionPath: join(CHAT_FILES, 'instruction.md'),
      }),
      wsId: 'ws-abc',
      dir,
    });

    expect(await read('CLAUDE.md')).toBe(expected);
    expect(await read('AGENTS.md')).toBe(expected);
  });

  it('does not touch CLAUDE.md / AGENTS.md when injectPersona is false', async () => {
    await injectWorkspaceContext({ template: makeTemplate({ injectPersona: false }), wsId: 'ws-abc', dir });
    expect(existsSync(join(dir, 'CLAUDE.md'))).toBe(false);
    expect(existsSync(join(dir, 'AGENTS.md'))).toBe(false);
  });

  it('refreshes stale persistent-workspace instruction faces byte-identically and then becomes a no-op', async () => {
    const template = makeTemplate({
      name: 'steward',
      injectPersona: true,
      filesDir: STEWARD_FILES,
      instructionPath: join(STEWARD_FILES, 'instruction.md'),
      templateDir: STEWARD_DIR,
    });
    await writeFile(join(dir, 'AGENTS.md'), 'stale v2 instructions\n', 'utf8');
    await writeFile(join(dir, 'CLAUDE.md'), 'stale v2 instructions\n', 'utf8');

    await expect(refreshWorkspaceInstructions({ template, dir })).resolves.toEqual({ changed: true });
    expect(await read('AGENTS.md')).toBe(await read('CLAUDE.md'));
    expect(await read('AGENTS.md')).toContain('Decision Ledger Shape');
    expect(await read('AGENTS.md')).toContain('"version": 3');
    await expect(refreshWorkspaceInstructions({ template, dir })).resolves.toEqual({ changed: false });
  });

  it('uses an external authoritative instruction path while retaining base filesDir', async () => {
    const overlay = join(dir, 'overlay-instruction.md');
    await writeFile(overlay, '# external overlay\n', 'utf8');

    await injectWorkspaceContext({
      template: makeTemplate({
        name: 'overlay-test',
        injectPersona: true,
        filesDir: STEWARD_FILES,
        instructionPath: overlay,
        templateDir: STEWARD_DIR,
      }),
      wsId: 'ws-overlay-create',
      dir,
    });

    expect(await read('AGENTS.md')).toContain('# external overlay');
    expect(await read('CLAUDE.md')).toContain('# external overlay');

    await writeFile(overlay, '# external overlay refreshed\n', 'utf8');
    await expect(refreshWorkspaceInstructions({
      template: makeTemplate({
        name: 'overlay-test',
        injectPersona: true,
        filesDir: STEWARD_FILES,
        instructionPath: overlay,
        templateDir: STEWARD_DIR,
      }),
      dir,
    })).resolves.toEqual({ changed: true });
    expect(await read('AGENTS.md')).toContain('# external overlay refreshed');
    expect(await read('CLAUDE.md')).toContain('# external overlay refreshed');
  });
});

describe('injectWorkspaceContext — skills', () => {
  it('copies a bundled skill into all three CLI discovery paths', async () => {
    await injectWorkspaceContext({
      template: makeTemplate({ bundledSkills: ['scan-value-chain'] }),
      wsId: 'ws-abc',
      dir,
    });
    const expected = await readFile(defaultPath('skills', 'scan-value-chain', 'SKILL.md'), 'utf8');
    expect(await read('.claude/skills/scan-value-chain/SKILL.md')).toBe(expected);  // Claude Code
    expect(await read('.agents/skills/scan-value-chain/SKILL.md')).toBe(expected);  // Codex (+ opencode default)
    expect(await read('.pi/skills/scan-value-chain/SKILL.md')).toBe(expected);      // Pi
  });

  it('injects the per-CLI playbooks (alice* + traderhub) for a tool-bearing template', async () => {
    await injectWorkspaceContext({
      template: makeTemplate({ injectTools: true, bundledSkills: ['scan-value-chain'] }),
      wsId: 'ws-abc',
      dir,
    });
    for (const name of ['alice', 'alice-analysis', 'alice-uta', 'alice-workspace', 'traderhub', 'scan-value-chain']) {
      expect(existsSync(join(dir, '.claude/skills', name, 'SKILL.md')), name).toBe(true);
      expect(existsSync(join(dir, '.pi/skills', name, 'SKILL.md')), name).toBe(true);
    }
  });

  it('does not inject CLI playbooks when the template is not tool-bearing', async () => {
    await injectWorkspaceContext({
      template: makeTemplate({ injectTools: false, bundledSkills: ['scan-value-chain'] }),
      wsId: 'ws-abc',
      dir,
    });
    expect(existsSync(join(dir, '.claude/skills/alice-uta/SKILL.md'))).toBe(false);
    expect(existsSync(join(dir, '.claude/skills/scan-value-chain/SKILL.md'))).toBe(true);
  });

  it('injects the self-scheduling skill into every workspace, even an untooled one', async () => {
    await injectWorkspaceContext({
      template: makeTemplate({ injectTools: false }),
      wsId: 'ws-abc',
      dir,
    });
    expect(existsSync(join(dir, '.claude/skills/self-scheduling/SKILL.md'))).toBe(true);
    expect(existsSync(join(dir, '.agents/skills/self-scheduling/SKILL.md'))).toBe(true);
    expect(existsSync(join(dir, '.pi/skills/self-scheduling/SKILL.md'))).toBe(true);
  });
});

describe('injectWorkspaceContext — steward context manifest', () => {
  it('writes a manifest that versions steward wrapper, instructions, skills, and schemas', async () => {
    await mkdir(join(dir, '.alice', 'steward'), { recursive: true });
    await mkdir(join(dir, '.alice', 'steward', 'schemas'), { recursive: true });
    await writeFile(join(dir, '.alice', 'steward', 'README.md'), '# Steward Wrapper\n');
    await writeFile(join(dir, '.alice', 'steward', 'schemas', 'decision-ledger.v3.json'), '{"version":3}\n');

    await injectWorkspaceContext({
      template: makeTemplate({
        name: 'steward',
        version: '0.1.0',
        filesDir: STEWARD_FILES,
        instructionPath: join(STEWARD_FILES, 'instruction.md'),
        templateDir: STEWARD_DIR,
        injectPersona: true,
        injectTools: true,
      }),
      wsId: 'ws-steward-1',
      dir,
    });

    const raw = await read('.alice/steward/context-manifest.json');
    const manifest = JSON.parse(raw) as {
      version: number;
      template: { name: string; version: string };
      coreAgent: { id: string; model: string | null };
      wrapperPrompt: { path: string; sha256: string };
      instructions: Array<{ path: string; sha256: string }>;
      skills: Array<{ name: string; path: string; sha256: string }>;
      schemas: {
        wake: number;
        decisionLedger: number;
        decisionLedgerArtifact: { path: string; sha256: string };
      };
    };

    expect(manifest.version).toBe(1);
    expect(manifest.template).toEqual({ name: 'steward', version: '0.1.0' });
    expect(manifest.coreAgent).toEqual({ id: 'codex', model: null });
    expect(manifest.wrapperPrompt).toEqual({
      path: '.alice/steward/README.md',
      sha256: await sha256('.alice/steward/README.md'),
    });
    expect(manifest.instructions).toEqual([
      { path: 'AGENTS.md', sha256: await sha256('AGENTS.md') },
      { path: 'CLAUDE.md', sha256: await sha256('CLAUDE.md') },
    ]);
    expect(manifest.skills.map((s) => s.name)).toEqual([
      'alice',
      'alice-analysis',
      'alice-uta',
      'alice-workspace',
      'self-scheduling',
      'traderhub',
    ]);
    expect(manifest.skills.find((s) => s.name === 'alice-uta')).toEqual({
      name: 'alice-uta',
      path: '.agents/skills/alice-uta/SKILL.md',
      sha256: await sha256('.agents/skills/alice-uta/SKILL.md'),
    });
    expect(manifest.schemas).toEqual({
      wake: 1,
      decisionLedger: 3,
      decisionLedgerArtifact: {
        path: '.alice/steward/schemas/decision-ledger.v3.json',
        sha256: await sha256('.alice/steward/schemas/decision-ledger.v3.json'),
      },
    });
  });
});
