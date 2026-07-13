import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import { promisify } from 'node:util';

import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  D4_SMOKE_CANDIDATES,
  D4_SMOKE_PROFILES,
  D4_SMOKE_RUNTIME_TREE_FILES,
  D4_SMOKE_STAGE_MANIFEST_REF,
  buildD4SmokeStageManifest,
  computeD4SmokeRuntimeTreeIdentity,
  d4SmokeDecisionWindow,
  d4SmokeWakeIdPlaceholder,
  expectedD4SmokeCellIds,
  materializeD4SmokeEvaluationManifest,
  validateD4SmokeStage,
} from './d4-smoke-stage-manifest.js';
import {
  D4_SMOKE_TEST_GIT_VERIFIER,
  approveD4SmokeTestManifest,
  createD4SmokeTestFixture,
} from './d4-smoke-test-support.js';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const execFileAsync = promisify(execFile);

describe('D4 Smoke stage manifest', () => {
  it('pins the exact G2, canonical 12 cells, detached approval, and temporal visibility contract', async () => {
    const fixture = await createD4SmokeTestFixture();
    const stage = await validateD4SmokeStage({
      ...fixture,
      repoRoot: process.cwd(),
      gitVerifier: D4_SMOKE_TEST_GIT_VERIFIER,
    });

    expect(stage.manifest.content.candidates).toEqual(D4_SMOKE_CANDIDATES);
    expect(stage.manifest.content.cells.map((cell) => cell.id)).toEqual(expectedD4SmokeCellIds());
    expect(stage.manifest.content.repetitions).toEqual(['r1']);
    expect(stage.manifest.content.baseline.runtimeTree).toMatchObject({
      schema: 'steward-d4-runtime-tree/1',
      version: 1,
      files: D4_SMOKE_RUNTIME_TREE_FILES,
    });
    expect(stage.manifest.content.baseline.runtimeTree.entries.length).toBeGreaterThan(0);
    expect(stage.manifest.content.baseline.runtimeTree.entries.every((entry) =>
      !entry.path.endsWith('.spec.ts'))).toBe(true);
    expect(stage.manifest.content.baseline.runtimeTree.entries.map((entry) => entry.path)).toEqual(
      D4_SMOKE_RUNTIME_TREE_FILES,
    );
    expect(stage.contentByCellId).toHaveLength(12);
    expect(d4SmokeDecisionWindow('bull', 11)).toEqual({
      visibleStart: 0,
      visibleEndExclusive: 115,
      asOfBarIndex: 114,
    });
    expect(d4SmokeDecisionWindow('bear', 11)).toEqual({
      visibleStart: 0,
      visibleEndExclusive: 156,
      asOfBarIndex: 155,
    });
    expect(D4_SMOKE_PROFILES.bull.totalBars - 115).toBe(5);
    expect(D4_SMOKE_PROFILES.bear.totalBars - 156).toBe(6);
    const frozenCell = stage.contentByCellId.get(expectedD4SmokeCellIds()[0]!)!;
    expect(frozenCell.decisionManifests).toHaveLength(12);
    expect(frozenCell.decisionSnapshots).toHaveLength(12);
    expect(frozenCell.decisionManifests[0]!.wakeId).toBe(d4SmokeWakeIdPlaceholder(0));
    expect(materializeD4SmokeEvaluationManifest(
      frozenCell.decisionManifests[0]!,
      0,
      'wake:opaque-runtime-fixture',
    ).wakeId).toBe('wake:opaque-runtime-fixture');
    expect(frozenCell.decisionManifests[0]!.adjustment).toEqual({
      mode: 'unadjusted',
      corporateActionRefs: [],
    });
  });

  it('rejects candidate substitution and missing or extra Smoke coverage', async () => {
    const fixture = await createD4SmokeTestFixture();
    const substitutedContent = clone(fixture.manifest.content);
    substitutedContent.candidates[0]!.modelId = 'fallback-model';
    const substituted = buildD4SmokeStageManifest(substitutedContent);
    await expect(validateD4SmokeStage({
      manifestBytes: substituted.bytes,
      receipt: approveD4SmokeTestManifest(substituted),
      repoRoot: process.cwd(),
      gitVerifier: D4_SMOKE_TEST_GIT_VERIFIER,
      contentByRef: fixture.contentByRef,
    })).rejects.toThrow(/candidate_drift/);

    for (const mode of ['missing', 'extra'] as const) {
      const content = clone(fixture.manifest.content);
      if (mode === 'missing') content.cells.pop();
      else content.cells.push(clone(content.cells[0]!));
      const artifact = buildD4SmokeStageManifest(content);
      await expect(validateD4SmokeStage({
        manifestBytes: artifact.bytes,
        receipt: approveD4SmokeTestManifest(artifact),
        repoRoot: process.cwd(),
        gitVerifier: D4_SMOKE_TEST_GIT_VERIFIER,
        contentByRef: fixture.contentByRef,
      })).rejects.toThrow(/cell_roster_drift/);
    }
  });

  it('rejects holdout refs and unverified or hash-mismatched content', async () => {
    const fixture = await createD4SmokeTestFixture();
    const holdoutContent = clone(fixture.manifest.content);
    holdoutContent.cells[0]!.evidence.candidatePayload.ref = 'd4/holdout/forbidden.json';
    const holdout = buildD4SmokeStageManifest(holdoutContent);
    await expect(validateD4SmokeStage({
      manifestBytes: holdout.bytes,
      receipt: approveD4SmokeTestManifest(holdout),
      repoRoot: process.cwd(),
      gitVerifier: D4_SMOKE_TEST_GIT_VERIFIER,
      contentByRef: fixture.contentByRef,
    })).rejects.toThrow(/holdout_forbidden/);

    const missingContent = { ...fixture.contentByRef };
    delete missingContent[fixture.manifest.content.cells[0]!.evidence.candidatePayload.ref];
    await expect(validateD4SmokeStage({
      ...fixture,
      repoRoot: process.cwd(),
      gitVerifier: D4_SMOKE_TEST_GIT_VERIFIER,
      contentByRef: missingContent,
    })).rejects.toThrow(/content_unverified/);

    const changedContent = { ...fixture.contentByRef };
    changedContent[fixture.manifest.content.cells[0]!.evidence.candidatePayload.ref] = '{}';
    await expect(validateD4SmokeStage({
      ...fixture,
      repoRoot: process.cwd(),
      gitVerifier: D4_SMOKE_TEST_GIT_VERIFIER,
      contentByRef: changedContent,
    })).rejects.toThrow(/content_hash_mismatch/);

    const changedQuotaSource = { ...fixture.contentByRef };
    const quotaEvidence = JSON.parse(changedQuotaSource[
      fixture.manifest.content.baseline.quotaForecastEvidence.ref
    ]!) as { observations: Array<{ before: { raw: { ref: string } } }> };
    changedQuotaSource[quotaEvidence.observations[0]!.before.raw.ref] = '{}';
    await expect(validateD4SmokeStage({
      ...fixture,
      repoRoot: process.cwd(),
      gitVerifier: D4_SMOKE_TEST_GIT_VERIFIER,
      contentByRef: changedQuotaSource,
    })).rejects.toThrow(/content_hash_mismatch/);
  });

  it('rejects the registered #202 flat/40-hex dependency instead of adding compatibility', async () => {
    const fixture = await createD4SmokeTestFixture();
    await expect(validateD4SmokeStage({
      manifestBytes: `${JSON.stringify(fixture.manifest.content, null, 2)}\n`,
      receipt: fixture.receipt,
      repoRoot: process.cwd(),
      gitVerifier: D4_SMOKE_TEST_GIT_VERIFIER,
      contentByRef: fixture.contentByRef,
    })).rejects.toThrow(/shape_invalid/);

    const content = clone(fixture.manifest.content);
    const cell = content.cells[0]!;
    const auditRef = cell.evidence.audit.ref;
    const audit = JSON.parse(fixture.contentByRef[auditRef]!) as {
      decisionManifests: Array<{ wakeId: string }>;
    };
    // #202 must regenerate after #201 merges; a legacy 40-hex wake template is
    // not accepted as a second schema dialect.
    audit.decisionManifests[0]!.wakeId = 'a'.repeat(40);
    const auditBytes = `${JSON.stringify(audit, null, 2)}\n`;
    cell.evidence.audit.sha256 = createHash('sha256').update(auditBytes).digest('hex');
    const artifact = buildD4SmokeStageManifest(content);
    await expect(validateD4SmokeStage({
      manifestBytes: artifact.bytes,
      receipt: approveD4SmokeTestManifest(artifact),
      repoRoot: process.cwd(),
      gitVerifier: D4_SMOKE_TEST_GIT_VERIFIER,
      contentByRef: { ...fixture.contentByRef, [auditRef]: auditBytes },
    })).rejects.toThrow(/d4-opaque-wake-placeholder/);
  });

  it('requires every D3 dataset identity field to equal its stage instrument', async () => {
    const fixture = await createD4SmokeTestFixture();
    for (const field of [
      'provider',
      'name',
      'rawSymbol',
      'assetClass',
      'timezone',
      'exchangeCalendar',
    ] as const) {
      const content = clone(fixture.manifest.content);
      const cell = content.cells[0]!;
      const auditRef = cell.evidence.audit.ref;
      const audit = JSON.parse(fixture.contentByRef[auditRef]!) as {
        decisionManifests: Array<{ dataset: Record<typeof field, string> }>;
      };
      audit.decisionManifests[0]!.dataset[field] = `changed-${field}`;
      const auditBytes = `${JSON.stringify(audit, null, 2)}\n`;
      cell.evidence.audit.sha256 = createHash('sha256').update(auditBytes).digest('hex');
      const artifact = buildD4SmokeStageManifest(content);
      await expect(validateD4SmokeStage({
        manifestBytes: artifact.bytes,
        receipt: approveD4SmokeTestManifest(artifact),
        repoRoot: process.cwd(),
        gitVerifier: D4_SMOKE_TEST_GIT_VERIFIER,
        contentByRef: { ...fixture.contentByRef, [auditRef]: auditBytes },
      })).rejects.toThrow(/D3 dataset identity differs from stage instrument/);
    }
  });

  it('rejects an invalid or drifted runtime-tree identity', async () => {
    const fixture = await createD4SmokeTestFixture();
    const content = clone(fixture.manifest.content);
    content.baseline.runtimeTree.entries[0]!.sha256 = '0'.repeat(64);
    const artifact = buildD4SmokeStageManifest(content);
    await expect(validateD4SmokeStage({
      manifestBytes: artifact.bytes,
      receipt: approveD4SmokeTestManifest(artifact),
      repoRoot: process.cwd(),
      gitVerifier: D4_SMOKE_TEST_GIT_VERIFIER,
      contentByRef: fixture.contentByRef,
    })).rejects.toThrow(/runtime_tree_drift/);

    for (const driftedProof of [
      'reviewedRuntimeTreeMatches',
      'headRuntimeTreeMatches',
      'worktreeRuntimeTreeMatches',
    ] as const) {
      await expect(validateD4SmokeStage({
        ...fixture,
        repoRoot: process.cwd(),
        gitVerifier: async () => ({
          ...(await D4_SMOKE_TEST_GIT_VERIFIER({
            repoRoot: process.cwd(),
            reviewedCommit: fixture.receipt.reviewedCommit,
            manifestBytes: fixture.manifestBytes,
            runtimeTree: fixture.manifest.content.baseline.runtimeTree,
          })),
          [driftedProof]: false,
        }),
      })).rejects.toThrow(/runtime_tree_drift/);
    }
  });

  it('changes the aggregate identity when any explicitly bound runtime dependency drifts', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'openalice-d4-runtime-closure-'));
    try {
      for (const path of D4_SMOKE_RUNTIME_TREE_FILES) {
        const target = join(repoRoot, path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, await readFile(join(process.cwd(), path)), { flag: 'wx' });
      }
      const baseline = await computeD4SmokeRuntimeTreeIdentity({ repoRoot });
      for (const path of D4_SMOKE_RUNTIME_TREE_FILES) {
        const target = join(repoRoot, path);
        const original = await readFile(target);
        await writeFile(target, Buffer.concat([original, Buffer.from('\nD4 drift\n')]));
        const drifted = await computeD4SmokeRuntimeTreeIdentity({ repoRoot });
        expect(drifted.sha256, path).not.toBe(baseline.sha256);
        await writeFile(target, original);
      }
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it('binds every transitive repo-local runtime TypeScript dependency', () => {
    const repoRoot = process.cwd();
    const visited = new Set<string>();
    const visit = (path: string): void => {
      if (visited.has(path)) return;
      visited.add(path);
      const source = readFileSync(join(repoRoot, path), 'utf8');
      const output = ts.transpileModule(source, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2023,
          verbatimModuleSyntax: true,
        },
      }).outputText;
      for (const imported of ts.preProcessFile(output, true, true).importedFiles) {
        if (!imported.fileName.startsWith('.')) continue;
        let dependency = normalize(join(dirname(path), imported.fileName));
        if (dependency.endsWith('.js')) dependency = `${dependency.slice(0, -3)}.ts`;
        if (dependency.endsWith('.ts') && existsSync(join(repoRoot, dependency))) visit(dependency);
      }
    };

    visit('src/workspaces/steward/d4-smoke-runner.ts');

    expect([...visited].sort()).toEqual(
      D4_SMOKE_RUNTIME_TREE_FILES.filter((path) => path.endsWith('.ts')).sort(),
    );
  });

  it('invalidates approval after any manifest-byte mutation and rejects declared hash drift', async () => {
    const fixture = await createD4SmokeTestFixture();
    const changedContent = clone(fixture.manifest.content);
    changedContent.cells[0]!.instrument.exchangeCalendar = 'changed';
    const changed = buildD4SmokeStageManifest(changedContent);
    await expect(validateD4SmokeStage({
      manifestBytes: changed.bytes,
      receipt: fixture.receipt,
      repoRoot: process.cwd(),
      gitVerifier: D4_SMOKE_TEST_GIT_VERIFIER,
      contentByRef: fixture.contentByRef,
    })).rejects.toThrow(/manifest_hash_mismatch/);

    const whitespaceEdited = Buffer.concat([Buffer.from(fixture.manifestBytes), Buffer.from('\n')]);
    await expect(validateD4SmokeStage({
      manifestBytes: whitespaceEdited,
      receipt: fixture.receipt,
      repoRoot: process.cwd(),
      gitVerifier: D4_SMOKE_TEST_GIT_VERIFIER,
      contentByRef: fixture.contentByRef,
    })).rejects.toThrow(/manifest_not_canonical/);

    const keyOrderEdited = `${JSON.stringify({
      version: fixture.manifest.version,
      schema: fixture.manifest.schema,
      content: fixture.manifest.content,
    }, null, 2)}\n`;
    await expect(validateD4SmokeStage({
      manifestBytes: keyOrderEdited,
      receipt: fixture.receipt,
      repoRoot: process.cwd(),
      gitVerifier: D4_SMOKE_TEST_GIT_VERIFIER,
      contentByRef: fixture.contentByRef,
    })).rejects.toThrow(/manifest_not_canonical/);
  });

  it('fails when the critic-reviewed commit is not an ancestor of the current HEAD', async () => {
    const fixture = await createD4SmokeTestFixture();
    await expect(validateD4SmokeStage({
      ...fixture,
      repoRoot: process.cwd(),
      gitVerifier: async () => ({
        head: 'feedface',
        reviewedCommitIsAncestor: false,
        reviewedManifestMatches: true,
        headManifestMatches: true,
        reviewedRuntimeTreeMatches: true,
        headRuntimeTreeMatches: true,
        worktreeRuntimeTreeMatches: true,
      }),
    })).rejects.toThrow(/reviewed_commit_not_ancestor/);
  });

  it('requires the exact approved manifest bytes to remain committed at reviewed commit and HEAD', async () => {
    const fixture = await createD4SmokeTestFixture();
    const repoRoot = await mkdtemp(join(tmpdir(), 'openalice-d4-git-proof-'));
    try {
      await execFileAsync('git', ['init'], { cwd: repoRoot });
      await execFileAsync('git', ['config', 'user.name', 'D4 Fixture'], { cwd: repoRoot });
      await execFileAsync('git', ['config', 'user.email', 'd4@example.invalid'], { cwd: repoRoot });
      const manifestPath = join(repoRoot, D4_SMOKE_STAGE_MANIFEST_REF);
      await mkdir(dirname(manifestPath), { recursive: true });
      await writeFile(manifestPath, fixture.manifestBytes, { encoding: 'utf8', flag: 'wx' });
      for (const entry of fixture.manifest.content.baseline.runtimeTree.entries) {
        const target = join(repoRoot, entry.path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, await readFile(join(process.cwd(), entry.path)), { flag: 'wx' });
      }
      await execFileAsync('git', ['add', '--all'], { cwd: repoRoot });
      await execFileAsync('git', ['commit', '-m', 'freeze manifest'], { cwd: repoRoot });
      const reviewedCommit = (await execFileAsync('git', ['rev-parse', 'HEAD'], {
        cwd: repoRoot,
        encoding: 'utf8',
      })).stdout.trim();
      const stage = await validateD4SmokeStage({
        manifestBytes: fixture.manifestBytes,
        receipt: { ...fixture.receipt, reviewedCommit },
        repoRoot,
        contentByRef: fixture.contentByRef,
      });
      expect(stage.receipt.reviewedCommit).toBe(reviewedCommit);

      const runtimePath = join(
        repoRoot,
        fixture.manifest.content.baseline.runtimeTree.entries[0]!.path,
      );
      const runtimeBytes = await readFile(runtimePath);
      await writeFile(runtimePath, Buffer.concat([runtimeBytes, Buffer.from('\nworktree drift\n')]));
      await expect(validateD4SmokeStage({
        manifestBytes: fixture.manifestBytes,
        receipt: { ...fixture.receipt, reviewedCommit },
        repoRoot,
        contentByRef: fixture.contentByRef,
      })).rejects.toThrow(/runtime_tree_drift/);
      await writeFile(runtimePath, runtimeBytes);

      await writeFile(manifestPath, Buffer.concat([Buffer.from(fixture.manifestBytes), Buffer.from('\n')]));
      await execFileAsync('git', ['add', D4_SMOKE_STAGE_MANIFEST_REF], { cwd: repoRoot });
      await execFileAsync('git', ['commit', '-m', 'drift manifest'], { cwd: repoRoot });
      await expect(validateD4SmokeStage({
        manifestBytes: fixture.manifestBytes,
        receipt: { ...fixture.receipt, reviewedCommit },
        repoRoot,
        contentByRef: fixture.contentByRef,
      })).rejects.toThrow(/manifest_not_committed/);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});
