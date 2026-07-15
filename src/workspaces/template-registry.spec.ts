import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { Logger } from './logger.js';
import { TemplateRegistry } from './template-registry.js';

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  event: () => undefined,
  child: () => logger,
};

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(root);
  return root;
}

async function writeBase(root: string, name: string): Promise<void> {
  const templateDir = join(root, name);
  await mkdir(join(templateDir, 'files'), { recursive: true });
  await Promise.all([
    writeFile(join(templateDir, 'bootstrap.mjs'), 'export {};\n'),
    writeFile(join(templateDir, 'files', 'instruction.md'), `${name} base instruction\n`),
    writeFile(join(templateDir, 'template.json'), JSON.stringify({ injectPersona: true })),
  ]);
}

async function writeOverlay(root: string, name: string, manifest = { extends: name }): Promise<void> {
  const templateDir = join(root, name);
  await mkdir(join(templateDir, 'files'), { recursive: true });
  await Promise.all([
    writeFile(join(templateDir, 'template.json'), JSON.stringify(manifest)),
    writeFile(join(templateDir, 'files', 'instruction.md'), `${name} overlay instruction\n`),
  ]);
}

describe('TemplateRegistry instruction overlays', () => {
  it('keeps base templates unchanged when no overlay root is configured', async () => {
    const baseRoot = await makeRoot('template-registry-base-');
    await Promise.all(['chat', 'auto-quant', 'steward'].map((name) => writeBase(baseRoot, name)));

    const registry = await TemplateRegistry.load(baseRoot, logger);

    expect(registry.list().map((template) => template.name)).toEqual(['auto-quant', 'chat', 'steward']);
    expect(registry.get('steward')).toMatchObject({
      bootstrapScript: join(baseRoot, 'steward', 'bootstrap.mjs'),
      templateDir: join(baseRoot, 'steward'),
      filesDir: join(baseRoot, 'steward', 'files'),
      instructionPath: join(baseRoot, 'steward', 'files', 'instruction.md'),
    });
  });

  it('applies one overlay after loading every base template without changing base runtime paths', async () => {
    const baseRoot = await makeRoot('template-registry-base-');
    const overlayRoot = await makeRoot('template-registry-overlay-');
    await Promise.all(['chat', 'auto-quant', 'steward'].map((name) => writeBase(baseRoot, name)));
    await writeOverlay(overlayRoot, 'steward');

    const registry = await TemplateRegistry.load(baseRoot, logger, overlayRoot);

    expect(registry.list().map((template) => template.name)).toEqual(['auto-quant', 'chat', 'steward']);
    expect(registry.get('steward')).toMatchObject({
      bootstrapScript: join(baseRoot, 'steward', 'bootstrap.mjs'),
      templateDir: join(baseRoot, 'steward'),
      filesDir: join(baseRoot, 'steward', 'files'),
      instructionPath: join(overlayRoot, 'steward', 'files', 'instruction.md'),
    });
  });

  it.each([
    ['has no base registry to extend', 'steward', { extends: 'steward' }, undefined, /requires a readable base template root/i, true],
    ['references a missing base', 'missing', { extends: 'missing' }, undefined, /base template .*missing.*not registered/i],
    ['does not match its directory name', 'steward', { extends: 'chat' }, undefined, /must extend same-named base template/i],
    ['duplicates a base through another directory', 'steward-copy', { extends: 'steward' }, undefined, /must extend same-named base template/i],
    ['uses a non-minimal manifest', 'steward', { extends: 'steward', injectPersona: true }, undefined, /must contain only an "extends" field/i],
    ['ships a bootstrap', 'steward', { extends: 'steward' }, 'bootstrap.mjs', /must not ship bootstrap/i],
    ['omits its instruction', 'steward', { extends: 'steward' }, 'remove-instruction', /missing files\/instruction\.md/i],
  ])('fails closed when an overlay %s', async (_label, name, manifest, mutation, expected, missingBase = false) => {
    const baseRoot = await makeRoot('template-registry-base-');
    const overlayRoot = await makeRoot('template-registry-overlay-');
    if (missingBase) await rm(baseRoot, { recursive: true, force: true });
    else await writeBase(baseRoot, 'steward');
    await writeOverlay(overlayRoot, name, manifest);
    if (mutation === 'bootstrap.mjs') {
      await writeFile(join(overlayRoot, name, mutation), 'export {};\n');
    }
    if (mutation === 'remove-instruction') {
      await rm(join(overlayRoot, name, 'files', 'instruction.md'));
    }

    await expect(TemplateRegistry.load(baseRoot, logger, overlayRoot)).rejects.toThrow(expected);
  });
});
