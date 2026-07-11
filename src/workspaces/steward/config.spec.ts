import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readStewardConfig } from './config.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'steward-config-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeConfig(body: string): Promise<void> {
  await mkdir(join(dir, '.alice', 'steward'), { recursive: true });
  await writeFile(join(dir, '.alice', 'steward', 'config.json'), body, 'utf8');
}

describe('readStewardConfig load-time validation (issue #153)', () => {
  it('returns {} and never warns when the file is absent', async () => {
    const warnings: { message: string; detail: Record<string, unknown> }[] = [];
    const config = await readStewardConfig(
      { dir },
      { onWarn: (message, detail) => warnings.push({ message, detail }) },
    );

    expect(config).toEqual({});
    expect(warnings).toEqual([]);
  });

  it('a valid config never warns', async () => {
    await writeConfig(JSON.stringify({
      agent: 'codex',
      controlFace: 'machine',
      sessionRotation: { threshold: 0.65 },
      monthlyBudget: { modelUsd: 50 },
    }));
    const warnings: { message: string; detail: Record<string, unknown> }[] = [];
    const config = await readStewardConfig(
      { dir },
      { onWarn: (message, detail) => warnings.push({ message, detail }) },
    );

    expect(config['controlFace']).toBe('machine');
    expect(warnings).toEqual([]);
  });

  it('a bad controlFace value fires ONE warning naming the key and value, and the raw value is still returned unchanged for the S6 fail-safe', async () => {
    await writeConfig(JSON.stringify({ controlFace: 'PTY' }));
    const warnings: { message: string; detail: Record<string, unknown> }[] = [];
    const config = await readStewardConfig(
      { dir },
      { onWarn: (message, detail) => warnings.push({ message, detail }) },
    );

    // The fail-safe downstream (`decideStewardControlFace`) still needs the RAW
    // (invalid) value — validation here is observational only, never sanitizing.
    expect(config['controlFace']).toBe('PTY');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toBe('steward.config_invalid');
    const issues = warnings[0]?.detail['issues'] as string[];
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('controlFace');
    expect(issues[0]).toContain('PTY');
  });

  it('multiple bad fields still fire exactly ONE warning naming every offending key/value', async () => {
    await writeConfig(JSON.stringify({ controlFace: 'PTY', sessionRotation: { threshold: 'high' } }));
    const warnings: { message: string; detail: Record<string, unknown> }[] = [];
    await readStewardConfig({ dir }, { onWarn: (message, detail) => warnings.push({ message, detail }) });

    expect(warnings).toHaveLength(1);
    const issues = warnings[0]?.detail['issues'] as string[];
    expect(issues.some((i) => i.includes('controlFace') && i.includes('PTY'))).toBe(true);
    expect(issues.some((i) => i.includes('sessionRotation.threshold') && i.includes('high'))).toBe(true);
  });

  it('an unrecognized top-level key is NOT flagged (forward-compat passthrough)', async () => {
    await writeConfig(JSON.stringify({ someBrandNewFutureKey: 'whatever' }));
    const warnings: { message: string; detail: Record<string, unknown> }[] = [];
    const config = await readStewardConfig({ dir }, { onWarn: (message, detail) => warnings.push({ message, detail }) });

    expect(config['someBrandNewFutureKey']).toBe('whatever');
    expect(warnings).toEqual([]);
  });

  it('never warns when no onWarn callback is provided, even for an invalid config', async () => {
    await writeConfig(JSON.stringify({ controlFace: 'PTY' }));
    await expect(readStewardConfig({ dir })).resolves.toEqual({ controlFace: 'PTY' });
  });

  it('malformed JSON keeps throwing exactly as before (existing behavior unchanged) — onWarn is never called', async () => {
    await writeConfig('{ not valid json');
    const warnings: unknown[] = [];
    await expect(
      readStewardConfig({ dir }, { onWarn: (message, detail) => warnings.push({ message, detail }) }),
    ).rejects.toThrow();
    expect(warnings).toEqual([]);
  });

  it('a non-object JSON value (array) keeps throwing exactly as before', async () => {
    await writeConfig('[]\n');
    await expect(readStewardConfig({ dir })).rejects.toThrow('.alice/steward/config.json must be an object');
  });
});
