import { mkdir, mkdtemp, open, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureTrustedProject } from './codex.js';

/**
 * Issue #124: six concurrent workspace bootstraps each called
 * `ensureTrustedProject`, doing an uncoordinated read-modify-write of the
 * shared `~/.codex/config.toml`. Blocks were lost (5/6 survived) or the file
 * ended up malformed TOML, which stalled every Codex steward wake. These
 * specs pin the fix: serialized + atomic persistence, path canonicalization,
 * and failure isolation.
 */

const SEED = [
  '# user global codex config',
  'model = "gpt-5-codex"',
  '',
  '[history]',
  'persistence = "save-all"',
  '',
].join('\n');

let root: string;
let configPath: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'codex-trust-'));
  configPath = join(root, '.codex', 'config.toml');
  await mkdir(join(root, '.codex'), { recursive: true });
  await writeFile(configPath, SEED, 'utf8');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function projectHeader(abs: string): string {
  const esc = abs.replace(/[\\"]/g, (c) => `\\${c}`);
  return `[projects."${esc}"]`;
}

describe('codex ensureTrustedProject — concurrency + atomicity (issue #124)', () => {
  it('N=6 concurrent calls for distinct projects all land, user content preserved byte-for-byte', async () => {
    const projects: string[] = [];
    for (let i = 0; i < 6; i++) {
      const p = join(root, 'projects', `ws-${i}`);
      await mkdir(p, { recursive: true });
      projects.push(p);
    }

    await Promise.all(projects.map((p) => ensureTrustedProject(p, { configPath })));

    const result = await readFile(configPath, 'utf8');

    // Unrelated user config survives byte-for-byte (we only ever append).
    expect(result.startsWith(SEED)).toBe(true);

    // Every one of the six trust blocks is present (none lost to a race).
    for (const p of projects) {
      const abs = await realOrResolve(p);
      expect(result).toContain(projectHeader(abs));
    }
    expect(result.match(/^\[projects\."/gm)?.length).toBe(6);

    // TOML-shaped: every project header is followed by a trust_level line.
    expect(result.match(/trust_level = "trusted"/g)?.length).toBe(6);
  });

  it('already-present project is a no-op and does not clobber a user-set read_only', async () => {
    const p = join(root, 'projects', 'preset');
    await mkdir(p, { recursive: true });
    const abs = await realOrResolve(p);
    const seeded = `${SEED}\n${projectHeader(abs)}\ntrust_level = "read_only"\n`;
    await writeFile(configPath, seeded, 'utf8');

    await ensureTrustedProject(p, { configPath });

    const result = await readFile(configPath, 'utf8');
    expect(result).toBe(seeded); // untouched
    expect(result).toContain('trust_level = "read_only"');
    expect(result).not.toContain('trust_level = "trusted"');
  });

  it('canonicalizes a symlinked project path (registers the realpath target)', async () => {
    const realDir = join(root, 'projects', 'real-target');
    await mkdir(realDir, { recursive: true });
    const linkPath = join(root, 'projects', 'link');
    await symlink(realDir, linkPath);

    await ensureTrustedProject(linkPath, { configPath });

    const result = await readFile(configPath, 'utf8');
    const realAbs = await realOrResolve(realDir);
    expect(result).toContain(projectHeader(realAbs));
    // The symlink path itself must NOT be registered.
    expect(result).not.toContain(projectHeader(resolve(linkPath)));
  });

  it('fails only this bootstrap on lock timeout, leaving config.toml intact', async () => {
    const p = join(root, 'projects', 'blocked');
    await mkdir(p, { recursive: true });

    // Hold a fresh (non-stale) lock so acquisition times out fast.
    const lockPath = `${configPath}.lock`;
    const holder = await open(lockPath, 'wx');
    try {
      await expect(
        ensureTrustedProject(p, { configPath, lockTimeoutMs: 60, lockRetryMs: 10, lockStaleMs: 60_000 }),
      ).rejects.toThrow(/could not acquire lock/i);
    } finally {
      await holder.close();
      await rm(lockPath, { force: true });
    }

    // Config never truncated / malformed — still the exact seed.
    const result = await readFile(configPath, 'utf8');
    expect(result).toBe(SEED);
  });

  it('reclaims a stale lock and still registers the project', async () => {
    const p = join(root, 'projects', 'stale-holder');
    await mkdir(p, { recursive: true });

    // Leave a lock behind, then treat any age as stale so it is reclaimed.
    const lockPath = `${configPath}.lock`;
    await writeFile(lockPath, 'dead pid', 'utf8');

    await ensureTrustedProject(p, { configPath, lockStaleMs: 0, lockTimeoutMs: 2_000 });

    const result = await readFile(configPath, 'utf8');
    const abs = await realOrResolve(p);
    expect(result).toContain(projectHeader(abs));
  });
});

/** Match the adapter's canonicalization: realpath, falling back to resolve. */
async function realOrResolve(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return resolve(p);
  }
}
