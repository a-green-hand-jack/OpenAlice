import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { Logger } from './logger.js';
import { TEMPLATE_POLICY_CONTRACT_VERSION, TemplateRegistry } from './template-registry.js';

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

async function writeBase(root: string, name: string, injectPersona = true): Promise<void> {
  const templateDir = join(root, name);
  await mkdir(join(templateDir, 'files'), { recursive: true });
  await Promise.all([
    writeFile(join(templateDir, 'bootstrap.mjs'), 'export {};\n'),
    writeFile(join(templateDir, 'files', 'instruction.md'), `${name} base instruction\n`),
    writeFile(join(templateDir, 'template.json'), JSON.stringify({ injectPersona })),
  ]);
}

async function writeOverlay(
  root: string,
  name: string,
  manifest: unknown = { extends: name, contractVersion: TEMPLATE_POLICY_CONTRACT_VERSION },
): Promise<void> {
  const templateDir = join(root, name);
  await mkdir(join(templateDir, 'files'), { recursive: true });
  await Promise.all([
    writeFile(join(templateDir, 'template.json'), JSON.stringify(manifest)),
    writeFile(join(templateDir, 'files', 'policy.md'), `${name} overlay policy\n`),
  ]);
}

describe('TemplateRegistry policy overlays', () => {
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
      instructionPath: join(baseRoot, 'steward', 'files', 'instruction.md'),
      policyContent: 'steward overlay policy\n',
      policyContractVersion: TEMPLATE_POLICY_CONTRACT_VERSION,
    });
  });

  it('rejects an overlay for a base that does not inject persona instructions', async () => {
    const baseRoot = await makeRoot('template-registry-base-');
    const overlayRoot = await makeRoot('template-registry-overlay-');
    await writeBase(baseRoot, 'auto-quant', false);
    await writeOverlay(overlayRoot, 'auto-quant');

    await expect(TemplateRegistry.load(baseRoot, logger, overlayRoot)).rejects.toThrow(
      /base template "auto-quant" does not enable persona instruction injection/i,
    );
  });

  it.each([
    ['has no base registry to extend', 'steward', { extends: 'steward', contractVersion: 1 }, undefined, /requires a readable base template root/i, true],
    ['references a missing base', 'missing', { extends: 'missing', contractVersion: 1 }, undefined, /base template .*missing.*not registered/i],
    ['does not match its directory name', 'steward', { extends: 'chat', contractVersion: 1 }, undefined, /must extend same-named base template/i],
    ['duplicates a base through another directory', 'steward-copy', { extends: 'steward', contractVersion: 1 }, undefined, /must extend same-named base template/i],
    ['uses a non-minimal manifest', 'steward', { extends: 'steward', contractVersion: 1, injectPersona: true }, undefined, /must declare contractVersion 1/i],
    ['omits its contract version', 'steward', { extends: 'steward' }, undefined, /must declare contractVersion 1/i],
    ['uses an unsupported contract version', 'steward', { extends: 'steward', contractVersion: 2 }, undefined, /must declare contractVersion 1/i],
    ['ships a bootstrap', 'steward', { extends: 'steward', contractVersion: 1 }, 'bootstrap.mjs', /must not ship bootstrap/i],
    ['omits its policy', 'steward', { extends: 'steward', contractVersion: 1 }, 'remove-policy', /missing files\/policy\.md/i],
  ])('fails closed when an overlay %s', async (_label, name, manifest, mutation, expected, missingBase = false) => {
    const baseRoot = await makeRoot('template-registry-base-');
    const overlayRoot = await makeRoot('template-registry-overlay-');
    if (missingBase) await rm(baseRoot, { recursive: true, force: true });
    else await writeBase(baseRoot, 'steward');
    await writeOverlay(overlayRoot, name, manifest);
    if (mutation === 'bootstrap.mjs') {
      await writeFile(join(overlayRoot, name, mutation), 'export {};\n');
    }
    if (mutation === 'remove-policy') {
      await rm(join(overlayRoot, name, 'files', 'policy.md'));
    }

    await expect(TemplateRegistry.load(baseRoot, logger, overlayRoot)).rejects.toThrow(expected);
  });
});
