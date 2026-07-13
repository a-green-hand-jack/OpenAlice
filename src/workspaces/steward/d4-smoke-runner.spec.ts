import { execFile } from 'node:child_process';
import { access, appendFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it, vi } from 'vitest';

import { sha256StewardEvaluationContent, type StewardEvaluationDataManifest } from './evaluation-data-manifest.js';
import { createStewardEvaluationProvenanceStore } from './evaluation-provenance-store.js';
import {
  D4_SMOKE_QUOTA_WINDOWS,
  D4_SMOKE_CLAUDE_SETTINGS,
  D4_SMOKE_MODEL_TURN_COUNT,
  D4_ENGINEERING_SHAKEDOWN_APPLICABLE_WINDOWS,
  D4_ENGINEERING_SHAKEDOWN_MODEL_TURN_COUNT,
  D4SmokeCapabilityAuditLedger,
  D4EngineeringShakedownError,
  D4EngineeringShakedownFailureError,
  assertD4ActualModelIds,
  assertD4CandidateVisibleBytes,
  assertD4EngineeringShakedownFailureNonInferential,
  assertD4EngineeringShakedownNonInferential,
  classifyD4SmokeShimAttempt,
  captureD4SmokeIsolatedPreflightQuota,
  createD4SmokeForbiddenCapabilityBoundaries,
  createD4SmokeFilesystemWorkspaceAdapter,
  createD4SmokeNativeDriverFactory,
  createD4SmokeLiveQuotaReader,
  d4EngineeringShakedownQuotaEvidenceSchema,
  d4SmokeQuotaEvidenceSchema,
  deriveD4SmokeQuotaForecastBounds,
  dryRunD4Smoke,
  fictionalD4SmokeTimeline,
  installD4SmokeAuditShims,
  planD4EngineeringShakedown,
  planD4SmokeExecutions,
  runD4EngineeringShakedown,
  runD4EngineeringShakedownFilesystem,
  runD4SmokeExecution,
  runD4SmokeFilesystemExecution,
  resolveD4ClaudeNativeRuntime,
  resolveD4CodexNativeRuntime,
  validateD4EngineeringShakedownQuotaEvidence,
  validateD4SmokeExecutionPlan,
  validateD4SmokeQuotaEvidence,
  type D4EngineeringShakedownQuotaEvidence,
  type D4EngineeringShakedownFailure,
  type D4EngineeringShakedownResult,
  type D4EngineeringShakedownSelector,
  type D4ShakedownQuotaPhase,
  type D4SmokeDriverBinding,
  type D4SmokeExecutionPlan,
  type D4SmokeExecutionResult,
  type D4SmokeFilesystemExecutionInput,
  type D4SmokeQuotaEvidence,
  type D4SmokeQuotaPhase,
  type D4SmokeQuotaForecastBounds,
} from './d4-smoke-runner.js';
import { D4_SMOKE_EXECUTION_COUNT, validateD4SmokeStage } from './d4-smoke-stage-manifest.js';
import {
  D4_SMOKE_TEST_GIT_VERIFIER,
  createD4SmokeTestFixture,
} from './d4-smoke-test-support.js';
import {
  parseStewardWakeRecord,
  stewardInformationSnapshotSchema,
  type StewardWakeRecord,
} from './types.js';
import type {
  EnsureThreadOptions,
  RunTurnOptions,
  StewardMachineDriver,
  ThreadTelemetry,
  TurnOutcome,
} from './machine-driver/types.js';
import {
  ClaudeAgentSdkDriver,
  type ClaudeAgentSdkDriverOptions,
} from './machine-driver/claude-agent-sdk-driver.js';
import type { CodexAppServerDriverOptions } from './machine-driver/codex-app-server-driver.js';

const NOW = new Date('2026-07-13T12:00:00.000Z');
const execFileAsync = promisify(execFile);
type ProductionSeamKey = Extract<
  keyof D4SmokeFilesystemExecutionInput,
  | 'driverFactory'
  | 'codexRuntime'
  | 'gitVerifier'
  | 'canonicalCredentialPaths'
  | 'quotaReader'
  | 'codexControl'
  | 'claudeControl'
  | 'forecastBounds'
>;
const PRODUCTION_INPUT_EXCLUDES_SEAMS: ProductionSeamKey extends never ? true : never = true;

async function bindUnixSocket(path: string): Promise<void> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}

function quotaEvidence(manifestSha256: string, phase: D4SmokeQuotaPhase) {
  const dispatchProvider = phase.kind === 'dispatch'
    ? phase.executionId.startsWith('codex:') ? 'codex' : 'claude'
    : null;
  return {
    schema: 'steward-d4-quota-evidence/1',
    version: 1,
    manifestSha256,
    phase,
    capturedAt: '2026-07-13T11:55:00.000Z',
    validUntil: '2026-07-13T12:05:00.000Z',
    forecastExecutionCount: 108,
    forecastModelTurnCount: 1296,
    cost: {
      actualIncrementalSpendUsd: 0,
      forecastIncrementalSpendUsd: 0,
      subscriptionQuota: {
        windows: D4_SMOKE_QUOTA_WINDOWS
          .filter((window) => dispatchProvider === null || window.provider === dispatchProvider)
          .map((window) => ({
          id: window.id,
          provider: window.provider,
          usedPercent: 10,
          forecastAdditionalPercent: 5,
          sourceIdentity: `fixture:${window.id}`,
          forecast: {
            basis: 'observed_delta_upper_bound',
            observedDeltaUpperBoundPercentPerModelTurn: 5 / window.applicableModelTurnCount,
            applicableModelTurnCount: window.applicableModelTurnCount,
            observationCount: 10,
            observedAt: '2026-07-13T11:50:00.000Z',
            sourceIdentity: `fixture-observed-delta:${window.id}`,
          },
        })),
      },
      shadowApiEquivalent: { status: 'unknown', amountUsd: null },
    },
  };
}

class FakeDriver implements StewardMachineDriver {
  readonly ensureCalls: EnsureThreadOptions[] = [];
  readonly turnCalls: Array<{ input: string; options: RunTurnOptions }> = [];
  disposed = false;

  constructor(private readonly beforeTurn?: (input: {
    readonly prompt: string;
    readonly options: RunTurnOptions;
    readonly turnNumber: number;
  }) => void | Promise<void>) {}

  async ensureThread(options: EnsureThreadOptions): Promise<{ threadId: string; resumed: boolean }> {
    this.ensureCalls.push(options);
    return { threadId: 'thread-fixture', resumed: false };
  }

  async runTurn(_threadId: string, input: string, options: RunTurnOptions = {}): Promise<TurnOutcome> {
    await this.beforeTurn?.({
      prompt: input,
      options,
      turnNumber: this.turnCalls.length + 1,
    });
    this.turnCalls.push({ input, options });
    return {
      turnId: `turn-${this.turnCalls.length}`,
      status: 'completed',
      agentMessage: 'terminal artifact is read from the isolated workspace',
      durationMs: 1,
      interrupted: false,
      actualModelIds: options.model === undefined ? [] : [options.model],
    };
  }

  async interruptTurn(): Promise<void> {}
  isThreadLive(): boolean { return false; }
  readTelemetry(): ThreadTelemetry | null { return null; }
  isHealthy(): boolean { return !this.disposed; }
  async interruptInFlight(): Promise<void> {}
  async dispose(): Promise<void> { this.disposed = true; }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function subscriptionOAuthFixture(provider: 'codex' | 'claude'): string {
  return provider === 'codex'
    ? `${JSON.stringify({
        auth_mode: 'chatgpt',
        OPENAI_API_KEY: null,
        tokens: {
          access_token: 'fixture-access',
          refresh_token: 'fixture-refresh',
          id_token: 'fixture-id',
          account_id: 'fixture-account',
        },
      })}\n`
    : `${JSON.stringify({
        claudeAiOauth: {
          accessToken: 'fixture-access',
          refreshToken: 'fixture-refresh',
          subscriptionType: 'max',
        },
      })}\n`;
}

function canonicalCredentialPaths(path: string) {
  return { codex: path, claude: path };
}

function quotaForecastBounds(): D4SmokeQuotaForecastBounds {
  return Object.fromEntries(D4_SMOKE_QUOTA_WINDOWS.map(({ id, applicableModelTurnCount }) => [id, {
    observedDeltaUpperBoundPercentPerModelTurn: 1 / applicableModelTurnCount,
    applicableModelTurnCount,
    observationCount: 8,
    observedAt: '2026-07-13T11:50:00.000Z',
    sourceIdentity: `observed:${id}`,
  }])) as D4SmokeQuotaForecastBounds;
}

function codexLiveQuotaResponse() {
  const bucket = (limitId: string, usedPercent: number, credits: unknown) => ({
    limitId,
    limitName: null,
    primary: { usedPercent, windowDurationMins: 10_080, resetsAt: 1_800_000_000 },
    secondary: null,
    credits,
    individualLimit: null,
    planType: 'pro',
    rateLimitReachedType: null,
  });
  return {
    rateLimits: bucket('codex', 20, { hasCredits: false, unlimited: false, balance: '0' }),
    rateLimitsByLimitId: {
      codex: bucket('codex', 20, { hasCredits: false, unlimited: false, balance: '0' }),
      codex_bengalfox: bucket('codex_bengalfox', 0, null),
    },
    rateLimitResetCredits: { availableCount: 0, credits: [] },
  };
}

function claudeLiveQuotaResponse() {
  return {
    session: {
      total_cost_usd: 0,
      total_api_duration_ms: 0,
      model_usage: {},
    },
    subscription_type: 'max',
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 10, resets_at: '2026-07-13T13:00:00.000Z' },
      seven_day: { utilization: 30, resets_at: '2026-07-18T03:00:00.000Z' },
      model_scoped: [{
        display_name: 'Fable',
        utilization: 40,
        resets_at: '2026-07-18T03:00:00.000Z',
      }],
      extra_usage: {
        is_enabled: false,
        monthly_limit: null,
        used_credits: null,
        utilization: null,
      },
      spend: {
        enabled: false,
        used: { amount_minor: 0, currency: 'USD', exponent: 2 },
        can_purchase_credits: false,
      },
    },
  };
}

async function exerciseAuditIntegrity(
  mode: 'codex_shim' | 'truncate' | 'corrupt' | 'append_failure',
): Promise<{ readonly error: Error | null; readonly attempts: readonly { capability: string }[] }> {
  const root = await mkdtemp(join(tmpdir(), `openalice-d4-audit-${mode}-`));
  try {
    const fixture = await createD4SmokeTestFixture();
    const stage = await validateD4SmokeStage({
      ...fixture,
      repoRoot: process.cwd(),
      gitVerifier: D4_SMOKE_TEST_GIT_VERIFIER,
    });
    const sandboxBase = join(root, 'sandboxes');
    const plan = planD4SmokeExecutions(stage, sandboxBase).find(
      (candidate) => candidate.candidate.provider === 'codex',
    )!;
    const credentialSource = join(root, 'auth.json');
    await writeFile(credentialSource, subscriptionOAuthFixture('codex'), { mode: 0o600 });
    const auditLedger = new D4SmokeCapabilityAuditLedger();
    const error = await runD4SmokeExecution({
      ...fixture,
      repoRoot: process.cwd(),
      gitVerifier: D4_SMOKE_TEST_GIT_VERIFIER,
      contentByRef: fixture.contentByRef,
      sandboxBase,
      executionId: plan.executionId,
      credentialSources: [{
        provider: 'codex',
        sourceIdentity: 'codex-subscription-oauth',
        sourcePath: credentialSource,
      }],
      canonicalCredentialPaths: canonicalCredentialPaths(credentialSource),
      quotaReader: async (phase) => quotaEvidence(fixture.manifestSha256, phase),
      bootstrapWorkspace: async () => {
        await mkdir(join(plan.paths.workspace, '.alice', 'steward'), { recursive: true, mode: 0o700 });
        await writeFile(
          join(plan.paths.workspace, '.alice', 'steward', 'validate-ledger.mjs'),
          'process.exit(0)\n',
          { mode: 0o600 },
        );
      },
      driverFactory: async (binding) => ({
        driver: new FakeDriver(async ({ options }) => {
          if (mode === 'codex_shim') {
            await execFileAsync(plan.paths.runtimeCodexLauncher, [
              '--d4-audit-canary',
              '-C',
              '.',
              'push',
            ], {
              cwd: binding.cwd,
              env: { ...binding.env },
            }).catch(() => undefined);
          } else if (mode === 'truncate') {
            await appendFile(plan.paths.auditCallLedger, 'candidate bytes that are then hidden\n');
            await writeFile(plan.paths.auditCallLedger, '');
          } else if (mode === 'corrupt') {
            await appendFile(plan.paths.auditCallLedger, '{not-json}\n');
          } else {
            options.onEvent?.({
              type: 'item-completed',
              threadId: 'thread-fixture',
              turnId: 'turn-fixture',
              itemType: 'commandExecution',
              text: null,
              exitCode: 125,
              aggregatedOutput: 'D4_SMOKE_AUDIT_APPEND_FAILED EACCES',
            });
          }
        }),
        resolvedModelId: binding.modelId,
        runtimeVersion: binding.runtimeVersion,
      }),
      prepareDecision: async (decision) => {
        const record = wakeRecord(decision.wakeId, decision.fictionalAsOf);
        return { record, candidateVisibleBytes: [JSON.stringify(record)] };
      },
      readTerminalArtifact: async () => { throw new Error('audit failure must precede terminal read'); },
      auditLedger,
      now: () => NOW,
    }).then(
      () => null,
      (caught: unknown) => caught instanceof Error ? caught : new Error(String(caught)),
    );
    return { error, attempts: auditLedger.snapshot() };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('D4 Smoke quota and planner', () => {
  it('rejects missing, aliased, or fallback provider-reported model sets', () => {
    expect(() => assertD4ActualModelIds(['gpt-5.6-sol'], 'gpt-5.6-sol', 'turn')).not.toThrow();
    expect(() => assertD4ActualModelIds(undefined, 'gpt-5.6-sol', 'turn')).toThrow(/model_binding_invalid/);
    expect(() => assertD4ActualModelIds(['gpt-5.6'], 'gpt-5.6-sol', 'turn')).toThrow(/model_binding_invalid/);
    expect(() => assertD4ActualModelIds(
      ['gpt-5.6-sol', 'fallback-model'],
      'gpt-5.6-sol',
      'turn',
    )).toThrow(/model_binding_invalid/);
  });

  it('audits non-CLI account and execution-record function boundaries', () => {
    const ledger = new D4SmokeCapabilityAuditLedger();
    const boundaries = createD4SmokeForbiddenCapabilityBoundaries(
      ledger,
      () => NOW,
    );
    for (const attempt of [
      () => boundaries.account.create(),
      () => boundaries.account.edit(),
      () => boundaries.account.elevate(),
      () => boundaries.executionRecord.publish(),
      () => boundaries.uta.mutate(),
      () => boundaries.stage.proposal(),
      () => boundaries.autoPush.execute(),
    ]) {
      expect(attempt).toThrow(/forbidden_capability_attempted/);
    }
    expect(ledger.snapshot().map((attempt) => attempt.capability)).toEqual([
      'account_create',
      'account_edit',
      'account_elevate',
      'execution_record_publish',
      'uta_mutation',
      'stage',
      'auto_push',
    ]);
  });

  it('classifies only concrete mutation commands', () => {
    expect(classifyD4SmokeShimAttempt('alice-uta', ['order', 'place'])).toBe('uta_mutation');
    expect(classifyD4SmokeShimAttempt('alice-uta', ['order', 'modify'])).toBe('uta_mutation');
    expect(classifyD4SmokeShimAttempt('alice-uta', ['order', 'cancel'])).toBe('uta_mutation');
    expect(classifyD4SmokeShimAttempt('alice-uta', ['position', 'close'])).toBe('uta_mutation');
    expect(classifyD4SmokeShimAttempt('alice-uta', ['git', 'commit'])).toBe('stage');
    expect(classifyD4SmokeShimAttempt('alice-uta', ['git', 'reject'])).toBe('stage');
    expect(classifyD4SmokeShimAttempt('alice-uta', ['git', 'push'])).toBe('auto_push');
    expect(classifyD4SmokeShimAttempt('git', ['push'])).toBe('auto_push');
    expect(classifyD4SmokeShimAttempt('git', ['-C', '.', 'push'])).toBe('auto_push');
    expect(classifyD4SmokeShimAttempt('/usr/bin/git', ['push'])).toBe('auto_push');
    expect(classifyD4SmokeShimAttempt('git', ['--git-dir=.git', 'push'])).toBe('auto_push');
    expect(classifyD4SmokeShimAttempt('alice-uta', ['order', 'place', '--help'])).toBeNull();
    expect(classifyD4SmokeShimAttempt('git', ['push', '--help'])).toBeNull();
    expect(classifyD4SmokeShimAttempt('git', ['-C', '.', 'push', '--version'])).toBeNull();
    expect(classifyD4SmokeShimAttempt('alice-uta', ['account', 'list'])).toBeNull();
    expect(classifyD4SmokeShimAttempt('alice-uta', ['git', 'status'])).toBeNull();
    expect(classifyD4SmokeShimAttempt('traderhub', ['board', 'get'])).toBeNull();
    expect(classifyD4SmokeShimAttempt('alice', ['market', 'search'])).toBeNull();
    expect(classifyD4SmokeShimAttempt('traderhub', ['stage'])).toBeNull();
    expect(classifyD4SmokeShimAttempt('alice', ['push'])).toBeNull();
  });

  it('dry-runs exactly 108 unique executions without a model/provider surface', async () => {
    const fixture = await createD4SmokeTestFixture();
    const providerCall = vi.fn();
    const result = await dryRunD4Smoke({
      ...fixture,
      repoRoot: process.cwd(),
      gitVerifier: D4_SMOKE_TEST_GIT_VERIFIER,
      contentByRef: fixture.contentByRef,
      sandboxBase: '/tmp/d4-smoke-dry-run',
      quotaEvidence: quotaEvidence(fixture.manifestSha256, { kind: 'layer_admission' }),
      now: NOW,
    });

    expect(result.executionCount).toBe(108);
    expect(result.plans).toHaveLength(108);
    expect(new Set(result.plans.map((plan) => plan.executionId))).toHaveLength(108);
    expect(new Set(result.plans.map((plan) => plan.paths.root))).toHaveLength(108);
    expect(providerCall).not.toHaveBeenCalled();
  });

  it('rejects shared writable roots and fallback model bindings', async () => {
    const fixture = await createD4SmokeTestFixture();
    const stage = await validateD4SmokeStage({
      ...fixture,
      repoRoot: process.cwd(),
      gitVerifier: D4_SMOKE_TEST_GIT_VERIFIER,
    });
    const plans = planD4SmokeExecutions(stage, '/tmp/d4-smoke-plan-test');

    const shared = plans.map((plan) => ({ ...plan })) as D4SmokeExecutionPlan[];
    shared[1] = {
      ...shared[1]!,
      paths: shared[0]!.paths,
      env: shared[0]!.env,
    };
    expect(() => validateD4SmokeExecutionPlan(shared, '/tmp/d4-smoke-plan-test')).toThrow(/shared_writable_root/);

    const fallback = plans.map((plan) => ({ ...plan })) as D4SmokeExecutionPlan[];
    fallback[0] = {
      ...fallback[0]!,
      candidate: { ...fallback[0]!.candidate, modelId: 'fallback-model' },
    };
    expect(() => validateD4SmokeExecutionPlan(fallback, '/tmp/d4-smoke-plan-test')).toThrow(/model_binding_invalid/);
  });

  it('fails closed on stale, incomplete, or reserve-exhausting quota evidence', async () => {
    const fixture = await createD4SmokeTestFixture();
    const base = quotaEvidence(fixture.manifestSha256, { kind: 'layer_admission' });
    expect(() => validateD4SmokeQuotaEvidence({
      evidence: base,
      manifestSha256: fixture.manifestSha256,
      phase: { kind: 'layer_admission' },
      now: new Date('2026-07-13T12:06:00.000Z'),
    })).toThrow(/stale/);

    const incomplete = clone(base);
    incomplete.cost.subscriptionQuota.windows.pop();
    expect(() => validateD4SmokeQuotaEvidence({
      evidence: incomplete,
      manifestSha256: fixture.manifestSha256,
      phase: { kind: 'layer_admission' },
      now: NOW,
    })).toThrow(/incomplete/);

    const exhausted = clone(base);
    exhausted.cost.subscriptionQuota.windows[0]!.usedPercent = 75;
    exhausted.cost.subscriptionQuota.windows[0]!.forecastAdditionalPercent = 5;
    expect(() => validateD4SmokeQuotaEvidence({
      evidence: exhausted,
      manifestSha256: fixture.manifestSha256,
      phase: { kind: 'layer_admission' },
      now: NOW,
    })).toThrow(/reserve_exhausted/);

    const guessed = clone(base) as unknown as { cost: { subscriptionQuota: { windows: Array<Record<string, unknown>> } } };
    delete guessed.cost.subscriptionQuota.windows[0]!.forecast;
    expect(() => validateD4SmokeQuotaEvidence({
      evidence: guessed,
      manifestSha256: fixture.manifestSha256,
      phase: { kind: 'layer_admission' },
      now: NOW,
    })).toThrow(/invalid/);

    const underForecast = clone(base);
    underForecast.cost.subscriptionQuota.windows[0]!.forecastAdditionalPercent = 1;
    expect(() => validateD4SmokeQuotaEvidence({
      evidence: underForecast,
      manifestSha256: fixture.manifestSha256,
      phase: { kind: 'layer_admission' },
      now: NOW,
    })).toThrow(/full-layer forecast/);
  });

  it('reads both controls for admission and only the selected provider for dispatch', async () => {
    const fixture = await createD4SmokeTestFixture();
    const stage = await validateD4SmokeStage({
      ...fixture,
      repoRoot: process.cwd(),
      gitVerifier: D4_SMOKE_TEST_GIT_VERIFIER,
    });
    const plan = planD4SmokeExecutions(stage, '/tmp/d4-live-quota-reader')[0]!;
    const codexRequest = vi.fn(async () => codexLiveQuotaResponse());
    const claudeUsage = vi.fn(async () => claudeLiveQuotaResponse());
    const reader = createD4SmokeLiveQuotaReader({
      codexControl: { request: codexRequest },
      claudeControl: {
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: claudeUsage,
      },
      forecastBounds: quotaForecastBounds(),
      now: () => NOW,
    });

    const admission = await reader({ kind: 'layer_admission' }, plan);
    const dispatch = await reader({
      kind: 'dispatch',
      executionId: plan.executionId,
      decisionIndex: 0,
      wakeId: 'wake:fixture',
    }, plan);

    expect(codexRequest).toHaveBeenCalledTimes(2);
    expect(codexRequest).toHaveBeenNthCalledWith(1, 'account/rateLimits/read', null);
    expect(claudeUsage).toHaveBeenCalledTimes(1);
    expect(admission.cost.subscriptionQuota.windows.map((window) => window.usedPercent)).toEqual([
      20, 0, 30, 40, 10,
    ]);
    expect(dispatch.phase.kind).toBe('dispatch');
    expect(dispatch.cost.subscriptionQuota.windows.map((window) => window.provider)).toEqual([
      'codex', 'codex',
    ]);
    expect(admission.cost.subscriptionQuota.windows.every((window) =>
      window.forecastAdditionalPercent === 1)).toBe(true);

    const spendEnabled = claudeLiveQuotaResponse();
    spendEnabled.rate_limits.spend.enabled = true;
    const unsafeReader = createD4SmokeLiveQuotaReader({
      codexControl: { request: async () => codexLiveQuotaResponse() },
      claudeControl: {
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => spendEnabled,
      },
      forecastBounds: quotaForecastBounds(),
      now: () => NOW,
    });
    await expect(unsafeReader({ kind: 'layer_admission' }, plan)).rejects.toThrow(/Claude Max quota response/);
  });

  it('uses sequential provider-only preflight roots and cleans them on success and error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openalice-d4-preflight-'));
    try {
      const codexCanonical = join(root, 'auth.json');
      const claudeCanonical = join(root, '.credentials.json');
      const candidateParent = join(root, 'candidate-sandboxes');
      await writeFile(codexCanonical, subscriptionOAuthFixture('codex'), { mode: 0o600 });
      await writeFile(claudeCanonical, subscriptionOAuthFixture('claude'), { mode: 0o600 });
      await mkdir(candidateParent, { mode: 0o700 });
      const probeRoots: string[] = [];

      const snapshot = await captureD4SmokeIsolatedPreflightQuota({
        canonical: { codex: codexCanonical, claude: claudeCanonical },
        now: () => NOW,
        readCodex: async (context) => {
          const probeRoot = join(context.cwd, '..');
          probeRoots.push(probeRoot);
          await expect(access(join(context.env.CODEX_HOME!, 'auth.json'))).resolves.toBeUndefined();
          await expect(access(join(context.env.CLAUDE_CONFIG_DIR!, '.credentials.json'))).rejects.toThrow();
          return codexLiveQuotaResponse();
        },
        readClaude: async (context) => {
          await expect(access(probeRoots[0]!)).rejects.toThrow();
          const probeRoot = join(context.cwd, '..');
          probeRoots.push(probeRoot);
          await expect(access(join(context.env.CLAUDE_CONFIG_DIR!, '.credentials.json'))).resolves.toBeUndefined();
          await expect(access(join(context.env.CODEX_HOME!, 'auth.json'))).rejects.toThrow();
          return claudeLiveQuotaResponse();
        },
      });

      expect(snapshot.capturedAt).toEqual(NOW);
      expect(probeRoots).toHaveLength(2);
      expect(probeRoots.every((probeRoot) => !probeRoot.startsWith(`${candidateParent}/`))).toBe(true);
      for (const probeRoot of probeRoots) await expect(access(probeRoot)).rejects.toThrow();

      const errorRoots: string[] = [];
      await expect(captureD4SmokeIsolatedPreflightQuota({
        canonical: { codex: codexCanonical, claude: claudeCanonical },
        readCodex: async (context) => {
          errorRoots.push(join(context.cwd, '..'));
          return codexLiveQuotaResponse();
        },
        readClaude: async (context) => {
          await expect(access(errorRoots[0]!)).rejects.toThrow();
          errorRoots.push(join(context.cwd, '..'));
          throw new Error('fixture quota failure');
        },
      })).rejects.toThrow(/fixture quota failure/);
      for (const probeRoot of errorRoots) await expect(access(probeRoot)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('pins the production Codex runtime before OAuth and gives that exact executable the credential', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openalice-d4-preflight-runtime-'));
    try {
      const expectedVersion = '0.144.0';
      const exact = await resolveD4CodexNativeRuntime(expectedVersion);
      const mismatchedBin = join(root, 'mismatched-bin');
      const codexCanonical = join(root, 'auth.json');
      const claudeCanonical = join(root, '.credentials.json');
      await mkdir(mismatchedBin, { recursive: true, mode: 0o700 });
      await writeFile(
        join(mismatchedBin, 'codex'),
        '#!/bin/sh\nprintf "codex-cli 0.143.0\\n"\n',
        { mode: 0o700 },
      );
      await writeFile(codexCanonical, subscriptionOAuthFixture('codex'), { mode: 0o600 });
      await writeFile(claudeCanonical, subscriptionOAuthFixture('claude'), { mode: 0o600 });
      const sequence: string[] = [];
      const oauthExecutables: string[] = [];

      const snapshot = await captureD4SmokeIsolatedPreflightQuota({
        canonical: { codex: codexCanonical, claude: claudeCanonical },
        expectedCodexRuntimeVersion: expectedVersion,
        resolveCodexRuntime: async (version) => {
          sequence.push('resolve-runtime');
          return resolveD4CodexNativeRuntime(
            version,
            `${mismatchedBin}${delimiter}${dirname(exact.executable)}`,
          );
        },
        readCodex: async (context, runtime) => {
          sequence.push('codex-oauth');
          await expect(access(join(context.env.CODEX_HOME!, 'auth.json'))).resolves.toBeUndefined();
          oauthExecutables.push(runtime!.executable);
          return codexLiveQuotaResponse();
        },
        readClaude: async () => {
          sequence.push('claude-oauth');
          return claudeLiveQuotaResponse();
        },
      });

      expect(sequence).toEqual(['resolve-runtime', 'codex-oauth', 'claude-oauth']);
      expect(oauthExecutables).toEqual([exact.executable]);
      expect(snapshot.codexRuntime).toEqual(exact);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('derives production bounds only from critic-bound raw before/after quota sources', async () => {
    const fixture = await createD4SmokeTestFixture();
    const stage = await validateD4SmokeStage({
      ...fixture,
      repoRoot: process.cwd(),
      gitVerifier: D4_SMOKE_TEST_GIT_VERIFIER,
    });
    const bounds = deriveD4SmokeQuotaForecastBounds({ stage, contentByRef: fixture.contentByRef });
    expect(Object.keys(bounds)).toEqual(D4_SMOKE_QUOTA_WINDOWS.map(({ id }) => id));
    expect(bounds).toMatchObject({
      'codex-general-weekly': {
        observedDeltaUpperBoundPercentPerModelTurn: 0.25,
        applicableModelTurnCount: 576,
        observationCount: 1,
      },
      'codex-spark': {
        observedDeltaUpperBoundPercentPerModelTurn: 1,
        applicableModelTurnCount: 144,
        observationCount: 1,
      },
      'claude-all-model-weekly': {
        observedDeltaUpperBoundPercentPerModelTurn: 0.25,
        applicableModelTurnCount: 576,
        observationCount: 1,
      },
      'claude-fable-weekly': {
        observedDeltaUpperBoundPercentPerModelTurn: 1,
        applicableModelTurnCount: 144,
        observationCount: 1,
      },
      'claude-current-short': {
        observedDeltaUpperBoundPercentPerModelTurn: 0.25,
        applicableModelTurnCount: 576,
        observationCount: 1,
      },
    });
    expect(Object.values(bounds).every((bound) =>
      bound.observedDeltaUpperBoundPercentPerModelTurn > 0
      && bound.sourceIdentity.startsWith('critic-bound:'))).toBe(true);

    const tampered = { ...fixture.contentByRef };
    const rawRef = stage.quotaForecastEvidence.observations[0]!.before.raw.ref;
    tampered[rawRef] = `${tampered[rawRef]} `;
    expect(() => deriveD4SmokeQuotaForecastBounds({ stage, contentByRef: tampered })).toThrow(
      /source hash changed/,
    );

    const noDeltaStage = {
      ...stage,
      quotaForecastEvidence: {
        ...stage.quotaForecastEvidence,
        observations: stage.quotaForecastEvidence.observations.map((observation) => ({
          ...observation,
          after: { ...observation.before, capturedAt: observation.after.capturedAt },
        })),
      },
    };
    const noDeltaBounds = deriveD4SmokeQuotaForecastBounds({
      stage: noDeltaStage,
      contentByRef: fixture.contentByRef,
    });
    expect(Object.values(noDeltaBounds).every((bound) =>
      bound.observedDeltaUpperBoundPercentPerModelTurn > 0)).toBe(true);

    const mixedProviderStage = {
      ...stage,
      quotaForecastEvidence: {
        ...stage.quotaForecastEvidence,
        observations: [
          ...stage.quotaForecastEvidence.observations,
          ...Array.from({ length: 20 }, (_, index) => ({
            ...stage.quotaForecastEvidence.observations.find(
              (observation) => observation.provider === 'claude',
            )!,
            id: `extra-claude-${index}`,
          })),
        ],
      },
    } as typeof stage;
    const mixedProviderBounds = deriveD4SmokeQuotaForecastBounds({
      stage: mixedProviderStage,
      contentByRef: fixture.contentByRef,
    });
    expect(mixedProviderBounds['codex-general-weekly']).toEqual(bounds['codex-general-weekly']);
    expect(mixedProviderBounds['codex-spark']).toEqual(bounds['codex-spark']);

    const missingChargeStage = clone(stage) as typeof stage;
    (missingChargeStage.quotaForecastEvidence.observations[0]!.charges as unknown[]).pop();
    expect(() => deriveD4SmokeQuotaForecastBounds({
      stage: missingChargeStage,
      contentByRef: fixture.contentByRef,
    })).toThrow(/requires the exact .* calibration/);

    const invalidCountStage = clone(stage) as typeof stage;
    const invalidCharges = invalidCountStage.quotaForecastEvidence.observations[0]!
      .charges as unknown as Array<{ chargedTurnCount: number }>;
    invalidCharges[0]!.chargedTurnCount = 0;
    expect(() => deriveD4SmokeQuotaForecastBounds({
      stage: invalidCountStage,
      contentByRef: fixture.contentByRef,
    })).toThrow(/requires the exact .* calibration/);

    const resetBytes = `${JSON.stringify({
      ...codexLiveQuotaResponse(),
      rateLimitsByLimitId: {
        ...codexLiveQuotaResponse().rateLimitsByLimitId,
        codex: {
          ...codexLiveQuotaResponse().rateLimitsByLimitId.codex,
          primary: {
            ...codexLiveQuotaResponse().rateLimitsByLimitId.codex.primary,
            usedPercent: 9,
          },
        },
        codex_bengalfox: {
          ...codexLiveQuotaResponse().rateLimitsByLimitId.codex_bengalfox,
          primary: {
            ...codexLiveQuotaResponse().rateLimitsByLimitId.codex_bengalfox.primary,
            usedPercent: 4,
          },
        },
      },
    }, null, 2)}\n`;
    const resetRef = 'd4/dev/quota/reset-after.json';
    const resetStage = {
      ...stage,
      quotaForecastEvidence: {
        ...stage.quotaForecastEvidence,
        observations: stage.quotaForecastEvidence.observations.map((observation, index) =>
          index === 0
            ? {
                ...observation,
                after: {
                  ...observation.after,
                  raw: { ref: resetRef, sha256: sha256StewardEvaluationContent(resetBytes) },
                },
              }
            : observation),
      },
    } as typeof stage;
    expect(() => deriveD4SmokeQuotaForecastBounds({
      stage: resetStage,
      contentByRef: { ...fixture.contentByRef, [resetRef]: resetBytes },
    })).toThrow(/crossed a quota reset/);
  });

  it('rejects test seams on the production entrypoint before any dispatch', async () => {
    expect(PRODUCTION_INPUT_EXCLUDES_SEAMS).toBe(true);
    const driverFactory = vi.fn();
    await expect(runD4SmokeFilesystemExecution({
      driverFactory,
    } as unknown as Parameters<typeof runD4SmokeFilesystemExecution>[0])).rejects.toThrow(
      /production_seam_forbidden/,
    );
    expect(driverFactory).not.toHaveBeenCalled();
  });

  it('pins the frozen native Codex runtime after a mismatched PATH launcher', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openalice-d4-codex-runtime-'));
    try {
      const expectedVersion = '0.144.0';
      const exact = await resolveD4CodexNativeRuntime(expectedVersion);
      const mismatchedBin = join(root, 'mismatched-bin');
      await mkdir(mismatchedBin, { recursive: true, mode: 0o700 });
      await writeFile(
        join(mismatchedBin, 'codex'),
        '#!/bin/sh\nprintf "codex-cli 0.143.0\\n"\n',
        { mode: 0o700 },
      );

      const pinned = await resolveD4CodexNativeRuntime(
        expectedVersion,
        `${mismatchedBin}${delimiter}${dirname(exact.executable)}`,
      );

      expect(pinned).toEqual(exact);
      expect(pinned.executable).toBe(join(pinned.root, 'bin', 'codex'));
      await expect(execFileAsync(pinned.executable, ['--version'])).resolves.toMatchObject({
        stdout: expect.stringContaining(expectedVersion),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('pins frozen Claude Code despite global CLI drift and rejects a changed runtime identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openalice-d4-claude-runtime-'));
    try {
      const expectedVersion = '2.1.202';
      const versionsRoot = join(root, 'versions');
      const globalBin = join(root, 'global-bin');
      const exactExecutable = join(versionsRoot, expectedVersion);
      await mkdir(globalBin, { recursive: true, mode: 0o700 });
      await mkdir(versionsRoot, { recursive: true, mode: 0o700 });
      await writeFile(
        join(globalBin, 'claude'),
        '#!/bin/sh\nprintf "2.1.207 (Claude Code)\\n"\n',
        { mode: 0o700 },
      );
      await writeFile(
        exactExecutable,
        `#!/bin/sh\nprintf "${expectedVersion} (Claude Code)\\n"\n`,
        { mode: 0o700 },
      );

      const pinned = await resolveD4ClaudeNativeRuntime(expectedVersion, versionsRoot);
      const driverOptions: ClaudeAgentSdkDriverOptions[] = [];
      const factory = createD4SmokeNativeDriverFactory({
        claudeRuntime: pinned,
        versionProbe: async (probe) => {
          expect(probe.binary).toBe(exactExecutable);
          expect(probe.binary).not.toBe(join(globalBin, 'claude'));
          return expectedVersion;
        },
        makeClaudeDriver: (options) => {
          driverOptions.push(options);
          return new FakeDriver();
        },
      });
      const binding: D4SmokeDriverBinding = {
        provider: 'claude',
        runtime: 'Claude Code',
        runtimeVersion: expectedVersion,
        modelId: 'claude-fable-5',
        cwd: root,
        env: {},
        filesystemSandbox: 'workspace-write',
        networkAccess: false,
        hostCredentialDenyPaths: [join(root, 'host-a'), join(root, 'host-b')],
        approvedInstruction: 'fixture instruction',
        toolPolicy: {
          account: 'not_exposed',
          uta: 'not_exposed',
          executionRecord: 'not_exposed',
          stage: 'not_exposed',
          autoPush: 'not_exposed',
        },
      };

      await expect(factory(binding)).resolves.toMatchObject({ runtimeVersion: expectedVersion });
      expect(driverOptions).toHaveLength(1);
      expect(driverOptions[0]!.pathToClaudeCodeExecutable).toBe(exactExecutable);

      await writeFile(
        exactExecutable,
        '#!/bin/sh\nprintf "2.1.207 (Claude Code)\\n"\n',
        { mode: 0o700 },
      );
      await expect(factory(binding)).rejects.toThrow(/pinned Claude Code runtime identity diverged/);
      expect(driverOptions).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('writes concrete shim attempts under a Codex binding env without a model call', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openalice-d4-codex-shim-'));
    try {
      const fixture = await createD4SmokeTestFixture();
      const stage = await validateD4SmokeStage({
        ...fixture,
        repoRoot: process.cwd(),
        gitVerifier: D4_SMOKE_TEST_GIT_VERIFIER,
      });
      const plan = planD4SmokeExecutions(stage, join(root, 'sandboxes')).find(
        (candidate) => candidate.candidate.provider === 'codex',
      )!;
      await mkdir(plan.paths.workspace, { recursive: true, mode: 0o700 });
      await mkdir(join(plan.paths.workspace, '.alice', 'steward'), { recursive: true, mode: 0o700 });
      await writeFile(
        join(plan.paths.workspace, '.alice', 'steward', 'validate-ledger.mjs'),
        'process.exit(0)\n',
        { mode: 0o600 },
      );
      await installD4SmokeAuditShims(plan.paths, plan.candidate);

      for (const [command, args] of [
        ['alice-uta', ['account', 'list']],
        ['traderhub', ['board', 'get']],
        ['alice', ['market', 'search']],
        ['alice-uta', ['order', 'place', '--help']],
        ['git', ['-C', '.', 'push', '--help']],
        ['alice-uta', ['order', 'place']],
        ['git', ['push']],
        ['git', ['-C', '.', 'push']],
      ] as const) {
        await execFileAsync(command, [...args], { env: { ...plan.env } }).catch(() => undefined);
      }

      const lines = (await readFile(plan.paths.auditCallLedger, 'utf8')).trim().split('\n');
      expect(lines.map((line) => JSON.parse(line) as { capability: string })).toEqual([
        expect.objectContaining({ capability: 'uta_mutation' }),
        expect.objectContaining({ capability: 'auto_push' }),
        expect.objectContaining({ capability: 'auto_push' }),
      ]);
    } finally {
      await execFileAsync('chmod', ['-R', 'u+w', root]).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps Codex behind the outer filesystem and absolute-git audit boundary without a model call', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openalice-d4-codex-isolation-'));
    const sentinelName = 'OPENALICE_D4_PARENT_SECRET';
    const previousSentinel = process.env[sentinelName];
    process.env[sentinelName] = 'must-not-reach-candidate';
    try {
      const fixture = await createD4SmokeTestFixture();
      const stage = await validateD4SmokeStage({
        ...fixture,
        repoRoot: process.cwd(),
        gitVerifier: D4_SMOKE_TEST_GIT_VERIFIER,
      });
      const plan = planD4SmokeExecutions(stage, join(root, 'sandboxes')).find(
        (candidate) => candidate.candidate.provider === 'codex',
      )!;
      const selectedCredential = join(plan.paths.codexHome, 'auth.json');
      const nonSelectedCanonical = join(root, 'host-claude-credentials.json');
      const fakeGitMarker = join(plan.paths.workspace, 'fake-git-ran');
      const fakeValidatorMarker = join(plan.paths.workspace, 'fake-validator-ran');
      await mkdir(join(plan.paths.workspace, '.alice', 'steward'), { recursive: true, mode: 0o700 });
      await mkdir(plan.paths.codexHome, { recursive: true, mode: 0o700 });
      await writeFile(selectedCredential, subscriptionOAuthFixture('codex'), { mode: 0o600 });
      await writeFile(nonSelectedCanonical, subscriptionOAuthFixture('claude'), { mode: 0o600 });
      await writeFile(
        join(plan.paths.workspace, '.alice', 'steward', 'validate-ledger.mjs'),
        'process.exit(0)\n',
        { mode: 0o600 },
      );
      const pinnedRuntime = await resolveD4CodexNativeRuntime(plan.candidate.runtimeVersion);
      await installD4SmokeAuditShims(plan.paths, plan.candidate, pinnedRuntime);
      expect(await readFile(plan.paths.runtimeCodexLauncher, 'utf8')).toContain(pinnedRuntime.root);
      await expect(writeFile(plan.paths.runtimeValidator, 'workspace overwrite')).rejects.toThrow();
      await expect(writeFile(plan.paths.runtimeAuditAppendHelper, 'workspace overwrite')).rejects.toThrow();
      await expect(writeFile(join(plan.paths.auditBin, 'git'), 'workspace overwrite')).rejects.toThrow();

      await writeFile(
        join(plan.paths.workspace, '.alice', 'steward', 'validate-ledger.mjs'),
        `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(fakeValidatorMarker)}, 'bad')\n`,
        { mode: 0o700 },
      );
      await writeFile(
        join(plan.paths.workspace, 'git'),
        `#!/bin/sh\nprintf bad > ${JSON.stringify(fakeGitMarker)}\n`,
        { mode: 0o700 },
      );

      await expect(execFileAsync(
        plan.paths.runtimeCodexLauncher,
        ['--d4-isolation-canary', selectedCredential, nonSelectedCanonical, sentinelName],
        { cwd: plan.paths.workspace, env: { ...plan.env } },
      )).resolves.toBeDefined();
      await expect(execFileAsync(
        process.execPath,
        ['../runtime/validate-ledger.mjs'],
        { cwd: plan.paths.workspace, env: { ...plan.env } },
      )).resolves.toBeDefined();
      await expect(execFileAsync(
        plan.paths.runtimeCodexLauncher,
        ['--d4-audit-canary'],
        { cwd: plan.paths.workspace, env: { ...plan.env } },
      )).rejects.toMatchObject({ code: 126 });
      await expect(execFileAsync(
        plan.paths.runtimeCodexLauncher,
        ['--d4-audit-canary', '-C', '.', 'push'],
        { cwd: plan.paths.workspace, env: { ...plan.env } },
      )).rejects.toMatchObject({ code: 126 });

      await expect(access(fakeGitMarker)).rejects.toThrow();
      await expect(access(fakeValidatorMarker)).rejects.toThrow();
      const auditLines = (await readFile(plan.paths.auditCallLedger, 'utf8')).trim().split('\n');
      expect(auditLines.map((line) => JSON.parse(line))).toEqual([
        expect.objectContaining({ capability: 'auto_push', detail: 'git:push' }),
        expect.objectContaining({ capability: 'auto_push', detail: 'git:-C:.' }),
      ]);
    } finally {
      if (previousSentinel === undefined) delete process.env[sentinelName];
      else process.env[sentinelName] = previousSentinel;
      await execFileAsync('chmod', ['-R', 'u+w', root]).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects every forbidden semantic class from candidate-visible wake or Snapshot M1 bytes', async () => {
    const fixture = await createD4SmokeTestFixture();
    const stage = await validateD4SmokeStage({
      ...fixture,
      repoRoot: process.cwd(),
      gitVerifier: D4_SMOKE_TEST_GIT_VERIFIER,
    });
    const plan = planD4SmokeExecutions(stage, '/tmp/d4-smoke-leak-scan')[0]!;
    const cellData = stage.contentByCellId.get(plan.cell.id)!;
    const sourceAsOf = cellData.decisionManifests[0]!.asOf;
    const forbiddenPayloads = [
      { provider: plan.candidate.provider },
      { modelId: plan.candidate.modelId },
      { cellId: plan.cell.id },
      { profile: plan.cell.profile },
      { window: plan.cell.window },
      { symbol: plan.cell.instrument.symbol },
      { venue: plan.cell.instrument.exchangeCalendar },
      { sourceAsOf },
    ];
    for (const payload of forbiddenPayloads) {
      expect(() => assertD4CandidateVisibleBytes({
        plan,
        cellData,
        decisionIndex: 0,
        values: [JSON.stringify(payload)],
      })).toThrow(/candidate-visible payload exposes/);
    }
    expect(() => assertD4CandidateVisibleBytes({
      plan,
      cellData,
      decisionIndex: 0,
      values: [JSON.stringify(cellData.decisionSnapshots[0])],
    })).not.toThrow();
    expect(() => assertD4CandidateVisibleBytes({
      plan,
      cellData,
      decisionIndex: 0,
      values: [JSON.stringify({ createdAt: NOW.toISOString() })],
    })).toThrow(/non-fictional runtime ISO/);
    expect(() => assertD4CandidateVisibleBytes({
      plan,
      cellData,
      decisionIndex: 0,
      values: [JSON.stringify(fictionalD4SmokeTimeline(0))],
    })).not.toThrow();
  });
});

describe('D4 Smoke single-execution runner', () => {
  it('imports and rejects a forbidden call appended by the Codex binding env shim', async () => {
    const result = await exerciseAuditIntegrity('codex_shim');
    expect(result.error?.message).toMatch(/forbidden_capability_attempted/);
    expect(result.attempts).toEqual([
      expect.objectContaining({ capability: 'auto_push' }),
    ]);
  });

  it.each([
    ['truncate', /truncated|rewritten/],
    ['corrupt', /corrupt/],
    ['append_failure', /audit append failed/],
  ] as const)('fails closed when the candidate causes audit %s', async (mode, expected) => {
    const result = await exerciseAuditIntegrity(mode);
    expect(result.error?.message).toMatch(expected);
  });

  it('fails closed on the Claude SDK command event for an audit append failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openalice-d4-claude-append-failure-'));
    try {
      const fixture = await createD4SmokeTestFixture();
      const stage = await validateD4SmokeStage({
        ...fixture,
        repoRoot: process.cwd(),
        gitVerifier: D4_SMOKE_TEST_GIT_VERIFIER,
      });
      const sandboxBase = join(root, 'sandboxes');
      const plan = planD4SmokeExecutions(stage, sandboxBase).find(
        (candidate) => candidate.candidate.provider === 'claude',
      )!;
      const credentialSource = join(root, '.credentials.json');
      await writeFile(credentialSource, subscriptionOAuthFixture('claude'), { mode: 0o600 });

      await expect(runD4SmokeExecution({
        ...fixture,
        repoRoot: process.cwd(),
        gitVerifier: D4_SMOKE_TEST_GIT_VERIFIER,
        contentByRef: fixture.contentByRef,
        sandboxBase,
        executionId: plan.executionId,
        credentialSources: [{
          provider: 'claude',
          sourceIdentity: 'claude-max-oauth',
          sourcePath: credentialSource,
        }],
        canonicalCredentialPaths: canonicalCredentialPaths(credentialSource),
        quotaReader: async (phase) => quotaEvidence(fixture.manifestSha256, phase),
        driverFactory: async (binding) => ({
          driver: new ClaudeAgentSdkDriver({
            cwd: binding.cwd,
            env: { ...binding.env },
            queryFn: () => (async function* () {
              yield {
                type: 'system',
                subtype: 'init',
                model: binding.modelId,
                session_id: 'fixture',
              } as never;
              yield {
                type: 'assistant',
                message: {
                  role: 'assistant',
                  content: [{
                    type: 'tool_use',
                    id: 'audit-bash',
                    name: 'Bash',
                    input: { command: 'git push' },
                  }],
                },
                parent_tool_use_id: null,
                uuid: 'assistant-audit',
                session_id: 'fixture',
              } as never;
              yield {
                type: 'user',
                message: {
                  role: 'user',
                  content: [{
                    type: 'tool_result',
                    tool_use_id: 'audit-bash',
                    is_error: true,
                    content: 'D4_SMOKE_AUDIT_APPEND_FAILED EACCES',
                  }],
                },
                parent_tool_use_id: null,
                session_id: 'fixture',
              } as never;
              yield {
                type: 'result',
                subtype: 'success',
                duration_ms: 1,
                result: 'audit command failed',
                modelUsage: {},
                session_id: 'fixture',
              } as never;
            })(),
          }),
          resolvedModelId: binding.modelId,
          runtimeVersion: binding.runtimeVersion,
        }),
        prepareDecision: async (decision) => {
          const record = wakeRecord(decision.wakeId, decision.fictionalAsOf);
          return { record, candidateVisibleBytes: [JSON.stringify(record)] };
        },
        readTerminalArtifact: async () => { throw new Error('audit failure must precede terminal read'); },
        auditLedger: new D4SmokeCapabilityAuditLedger(),
        now: () => NOW,
      })).rejects.toThrow(/audit append failed/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects when Claude swallows a guard-side audit append failure and yields success', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openalice-d4-claude-guard-append-failure-'));
    try {
      const fixture = await createD4SmokeTestFixture();
      const stage = await validateD4SmokeStage({
        ...fixture,
        repoRoot: process.cwd(),
        gitVerifier: D4_SMOKE_TEST_GIT_VERIFIER,
      });
      const sandboxBase = join(root, 'sandboxes');
      const plan = planD4SmokeExecutions(stage, sandboxBase).find(
        (candidate) => candidate.candidate.provider === 'claude',
      )!;
      const credentialSource = join(root, '.credentials.json');
      await writeFile(credentialSource, subscriptionOAuthFixture('claude'), { mode: 0o600 });
      let swallowedControlFailure: unknown;
      const nativeFactory = createD4SmokeNativeDriverFactory({
        versionProbe: async () => plan.candidate.runtimeVersion,
        makeClaudeDriver: (options) => new ClaudeAgentSdkDriver({
          ...options,
          queryFn: ({ options: queryOptions }) => (async function* () {
            yield {
              type: 'system',
              subtype: 'init',
              model: plan.candidate.modelId,
              session_id: 'fixture',
            } as never;
            await chmod(plan.paths.auditCallLedger, 0o400);
            try {
              await queryOptions.canUseTool!(
                'Bash',
                { command: '/usr/bin/git push' },
                {
                  signal: queryOptions.abortController!.signal,
                  toolUseID: 'guard-audit-failure',
                  requestId: 'guard-audit-failure',
                },
              );
            } catch (error) {
              swallowedControlFailure = error;
            }
            yield {
              type: 'result',
              subtype: 'success',
              duration_ms: 1,
              result: 'SDK swallowed guard failure',
              modelUsage: {},
              session_id: 'fixture',
            } as never;
          })(),
        }),
      });
      const auditLedger = new D4SmokeCapabilityAuditLedger();

      const error = await runD4SmokeExecution({
        ...fixture,
        repoRoot: process.cwd(),
        gitVerifier: D4_SMOKE_TEST_GIT_VERIFIER,
        contentByRef: fixture.contentByRef,
        sandboxBase,
        executionId: plan.executionId,
        credentialSources: [{
          provider: 'claude',
          sourceIdentity: 'claude-max-oauth',
          sourcePath: credentialSource,
        }],
        canonicalCredentialPaths: canonicalCredentialPaths(credentialSource),
        quotaReader: async (phase) => quotaEvidence(fixture.manifestSha256, phase),
        driverFactory: nativeFactory,
        prepareDecision: async (decision) => {
          const record = wakeRecord(decision.wakeId, decision.fictionalAsOf);
          return { record, candidateVisibleBytes: [JSON.stringify(record)] };
        },
        readTerminalArtifact: async () => { throw new Error('guard failure must precede terminal read'); },
        auditLedger,
        now: () => NOW,
      }).then(
        () => null,
        (caught: unknown) => caught,
      );

      expect(swallowedControlFailure).toBeInstanceOf(Error);
      expect(String((swallowedControlFailure as Error).message)).toContain(
        'Claude authorization boundary could not record',
      );
      expect(error).toBeInstanceOf(Error);
      expect(String((error as Error).message)).toContain('claude canUseTool failed');
      expect(String((error as Error).message)).not.toContain('interrupted');
      expect(auditLedger.snapshot()).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['codex', 'claude'] as const)(
    'rejects %s API-key material even at the canonical credential path',
    async (provider) => {
      const root = await mkdtemp(join(tmpdir(), `openalice-d4-${provider}-api-key-`));
      try {
        const fixture = await createD4SmokeTestFixture();
        const stage = await validateD4SmokeStage({
          ...fixture,
          repoRoot: process.cwd(),
          gitVerifier: D4_SMOKE_TEST_GIT_VERIFIER,
        });
        const sandboxBase = join(root, 'sandboxes');
        const plan = planD4SmokeExecutions(stage, sandboxBase).find(
          (candidate) => candidate.candidate.provider === provider,
        )!;
        const source = join(root, provider === 'codex' ? 'auth.json' : '.credentials.json');
        await writeFile(source, `${JSON.stringify(provider === 'codex'
          ? { auth_mode: 'apikey', OPENAI_API_KEY: 'fixture-api-key', tokens: {} }
          : { apiKey: 'fixture-api-key' })}\n`, { mode: 0o600 });
        const driverFactory = vi.fn();

        await expect(runD4SmokeExecution({
          ...fixture,
          repoRoot: process.cwd(),
          gitVerifier: D4_SMOKE_TEST_GIT_VERIFIER,
          contentByRef: fixture.contentByRef,
          sandboxBase,
          executionId: plan.executionId,
          credentialSources: [{
            provider,
            sourceIdentity: provider === 'codex' ? 'codex-subscription-oauth' : 'claude-max-oauth',
            sourcePath: source,
          }],
          canonicalCredentialPaths: canonicalCredentialPaths(source),
          quotaReader: async (phase) => quotaEvidence(fixture.manifestSha256, phase),
          driverFactory,
          prepareDecision: async () => { throw new Error('unreachable'); },
          readTerminalArtifact: async () => { throw new Error('unreachable'); },
          auditLedger: new D4SmokeCapabilityAuditLedger(),
          now: () => NOW,
        })).rejects.toThrow(/frozen subscription OAuth shape/);
        expect(driverFactory).not.toHaveBeenCalled();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it('requires canonical subscription OAuth and verifies the source when bootstrap fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openalice-d4-oauth-'));
    try {
      const fixture = await createD4SmokeTestFixture();
      const stage = await validateD4SmokeStage({
        ...fixture,
        repoRoot: process.cwd(),
        gitVerifier: D4_SMOKE_TEST_GIT_VERIFIER,
      });
      const sandboxBase = join(root, 'sandboxes');
      const plan = planD4SmokeExecutions(stage, sandboxBase)[0]!;
      const source = join(root, 'auth.json');
      const other = join(root, 'other-auth.json');
      await writeFile(source, subscriptionOAuthFixture('codex'), { mode: 0o600 });
      await writeFile(other, subscriptionOAuthFixture('codex'), { mode: 0o600 });
      const common = {
        ...fixture,
        repoRoot: process.cwd(),
        gitVerifier: D4_SMOKE_TEST_GIT_VERIFIER,
        contentByRef: fixture.contentByRef,
        sandboxBase,
        executionId: plan.executionId,
        credentialSources: [{
          provider: 'codex' as const,
          sourceIdentity: 'codex-subscription-oauth',
          sourcePath: source,
        }],
        quotaReader: async (phase: D4SmokeQuotaPhase) => quotaEvidence(fixture.manifestSha256, phase),
        driverFactory: vi.fn(),
        prepareDecision: async () => { throw new Error('unreachable'); },
        readTerminalArtifact: async () => { throw new Error('unreachable'); },
        auditLedger: new D4SmokeCapabilityAuditLedger(),
        now: () => NOW,
      };

      await expect(runD4SmokeExecution({
        ...common,
        canonicalCredentialPaths: canonicalCredentialPaths(other),
      })).rejects.toThrow(/canonical native-CLI credential file/);

      await expect(runD4SmokeExecution({
        ...common,
        sandboxBase: join(root, 'bootstrap-failure-sandboxes'),
        canonicalCredentialPaths: canonicalCredentialPaths(source),
        bootstrapWorkspace: async () => {
          await writeFile(source, `${subscriptionOAuthFixture('codex')} `);
          throw new Error('bootstrap fixture failure');
        },
      })).rejects.toThrow(/credential_source_changed/);
      expect(common.driverFactory).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['codex', 'claude'] as const)(
    'binds %s exactly in a fresh proposal-only sandbox and emits 12 D3 reports',
    async (provider) => {
      const root = await mkdtemp(join(tmpdir(), `openalice-d4-${provider}-`));
      try {
        const fixture = await createD4SmokeTestFixture();
        const dryRun = await dryRunD4Smoke({
          ...fixture,
          repoRoot: process.cwd(),
          gitVerifier: D4_SMOKE_TEST_GIT_VERIFIER,
          contentByRef: fixture.contentByRef,
          sandboxBase: join(root, 'sandboxes'),
          quotaEvidence: quotaEvidence(fixture.manifestSha256, { kind: 'layer_admission' }),
          now: NOW,
        });
        const plan = dryRun.plans.find((candidate) => candidate.candidate.provider === provider)!;
        const credentialSource = join(root, `${provider}-oauth.json`);
        await writeFile(credentialSource, subscriptionOAuthFixture(provider), { mode: 0o600 });
        const driver = new FakeDriver();
        const bindings: D4SmokeDriverBinding[] = [];
        const phases: D4SmokeQuotaPhase[] = [];
        const visibleCounts: number[] = [];
        const auditLedger = new D4SmokeCapabilityAuditLedger();
        const codexDriverOptions: CodexAppServerDriverOptions[] = [];
        const claudeDriverOptions: ClaudeAgentSdkDriverOptions[] = [];
        const versionProbes: string[] = [];
        const nativeFactory = createD4SmokeNativeDriverFactory({
          versionProbe: async (probe) => {
            versionProbes.push(`${probe.provider}:${probe.binary}`);
            return plan.candidate.runtimeVersion;
          },
          makeCodexDriver: (options) => {
            codexDriverOptions.push(options);
            return driver;
          },
          makeClaudeDriver: (options) => {
            claudeDriverOptions.push(options);
            return driver;
          },
        });

        const result = await runD4SmokeExecution({
          ...fixture,
          repoRoot: process.cwd(),
          gitVerifier: D4_SMOKE_TEST_GIT_VERIFIER,
          contentByRef: fixture.contentByRef,
          sandboxBase: join(root, 'sandboxes'),
          executionId: plan.executionId,
          credentialSources: [{
            provider,
            sourceIdentity: provider === 'codex' ? 'codex-subscription-oauth' : 'claude-max-oauth',
            sourcePath: credentialSource,
          }],
          canonicalCredentialPaths: canonicalCredentialPaths(credentialSource),
          quotaReader: async (phase) => {
            phases.push(phase);
            return quotaEvidence(fixture.manifestSha256, phase);
          },
          driverFactory: async (binding) => {
            bindings.push(binding);
            return nativeFactory(binding);
          },
          prepareDecision: async (decision) => {
            const bars = decision.candidateSnapshot['bars'];
            visibleCounts.push(Array.isArray(bars) ? bars.length : -1);
            const record = wakeRecord(decision.wakeId, decision.fictionalAsOf);
            return {
              record,
              candidateVisibleBytes: [JSON.stringify(record)],
            };
          },
          readTerminalArtifact: async (terminal) => terminalArtifact(
            plan.paths.workspace,
            terminal.wakeId,
          ),
          auditLedger,
          now: () => NOW,
          deadlineMs: 10_000,
        });

        expect(result.status).toBe('valid');
        expect(result.reports).toHaveLength(12);
        expect(result.reports.every((report) =>
          report.execution.verdict === 'not_evaluated'
          && report.execution.gateReason === 'execution_not_requested')).toBe(true);
        expect(result.capabilityAttempts).toEqual([]);
        expect(phases).toHaveLength(13);
        expect(phases[0]).toEqual({ kind: 'layer_admission' });
        expect(phases.slice(1)).toEqual(Array.from({ length: 12 }, (_, decisionIndex) =>
          expect.objectContaining({
            kind: 'dispatch',
            executionId: plan.executionId,
            decisionIndex,
            wakeId: expect.stringMatching(/^wake:[0-9a-f]{64}$/),
          })));
        expect(new Set(phases.slice(1).map((phase) =>
          phase.kind === 'dispatch' ? phase.wakeId : '')).size).toBe(12);
        expect(result.quotaEvidence.dispatches).toHaveLength(12);
        expect(visibleCounts).toEqual([60, 65, 70, 75, 80, 85, 90, 95, 100, 105, 110, 115]);
        expect(driver.ensureCalls).toEqual([expect.objectContaining({
          model: plan.candidate.modelId,
          sandbox: 'workspace-write',
          networkAccess: false,
        })]);
        expect(driver.turnCalls).toHaveLength(12);
        expect(driver.turnCalls.every((call) => call.options.model === plan.candidate.modelId)).toBe(true);
        expect(driver.turnCalls.every((call) =>
          call.input.includes('node ../runtime/validate-ledger.mjs')
          && !call.input.includes('node .alice/steward/validate-ledger.mjs'))).toBe(true);
        expect(driver.disposed).toBe(true);
        expect(bindings).toHaveLength(1);
        expect(versionProbes).toEqual([
          `${provider}:${provider === 'codex' ? plan.paths.runtimeCodexLauncher : provider}`,
        ]);
        expect(bindings[0]).toMatchObject({
          provider,
          modelId: plan.candidate.modelId,
          runtimeVersion: plan.candidate.runtimeVersion,
          networkAccess: false,
          toolPolicy: {
            account: 'not_exposed',
            uta: 'not_exposed',
            executionRecord: 'not_exposed',
            stage: 'not_exposed',
            autoPush: 'not_exposed',
          },
        });
        expect(bindings[0]!.env).not.toHaveProperty('OPENALICE_UTA_INTERNAL_TOKEN');
        expect(bindings[0]!.env).not.toHaveProperty('OPENALICE_MCP_URL');
        expect(bindings[0]!.env.HOME).toContain(plan.paths.root);
        expect(bindings[0]!.env.TMPDIR).toBe(plan.paths.tempRoot);
        expect(bindings[0]!.env.TMP).toBe(plan.paths.tempRoot);
        expect(bindings[0]!.env.TEMP).toBe(plan.paths.tempRoot);
        if (provider === 'claude') {
          expect(bindings[0]!.env.CLAUDE_CODE_TMPDIR).toBe(plan.paths.claudeBridgeTempDir);
          expect(bindings[0]!.env.CLAUDE_CODE_TMPDIR).not.toContain(plan.paths.root);
        } else {
          expect(bindings[0]!.env).not.toHaveProperty('CLAUDE_CODE_TMPDIR');
        }
        await expect(access(join(plan.paths.root, '.quota-control'))).rejects.toThrow();
        await expect(access(provider === 'codex'
          ? join(plan.paths.claudeConfigDir, '.credentials.json')
          : join(plan.paths.codexHome, 'auth.json'))).rejects.toThrow();
        expect(result.credential).toMatchObject({
          provider,
          unchangedAfterExecution: true,
        });

        if (provider === 'codex') {
          expect(codexDriverOptions).toHaveLength(1);
          expect(claudeDriverOptions).toHaveLength(0);
          expect(codexDriverOptions[0]).toMatchObject({
            envInheritance: 'replace',
            env: expect.objectContaining({
              HOME: plan.paths.home,
              CODEX_HOME: plan.paths.codexHome,
              TMPDIR: plan.paths.tempRoot,
            }),
          });
        } else {
          expect(codexDriverOptions).toHaveLength(0);
          expect(claudeDriverOptions).toHaveLength(1);
          expect(claudeDriverOptions[0]).toMatchObject({
            permissionMode: 'dontAsk',
            settings: D4_SMOKE_CLAUDE_SETTINGS,
            pathToClaudeCodeExecutable: 'claude',
            settingSources: [],
            strictMcpConfig: true,
            skills: [],
            sandbox: {
              enabled: true,
              failIfUnavailable: true,
              allowUnsandboxedCommands: false,
              network: {
                allowedDomains: [],
                deniedDomains: ['*'],
                allowAllUnixSockets: false,
                allowLocalBinding: false,
              },
              filesystem: { allowWrite: [plan.paths.workspace] },
            },
          });
          expect(claudeDriverOptions[0]!.settings).toMatchObject({
            enableAllProjectMcpServers: false,
            permissions: {
              allow: expect.arrayContaining([
                'Bash(alice-uta *)',
                'Bash(traderhub *)',
                'Bash(git *)',
              ]),
            },
          });
          const d4Settings = claudeDriverOptions[0]!.settings;
          expect(typeof d4Settings === 'string' ? [] : d4Settings?.permissions?.allow).toEqual(
            expect.arrayContaining(['Write', 'Edit', 'Read', 'Glob', 'Grep']),
          );
          const toolGuard = claudeDriverOptions[0]!.canUseTool!;
          await expect(toolGuard(
            'Write',
            { file_path: join(plan.paths.workspace, '.alice', 'steward', 'drafts', 'wake.json') },
            { signal: new AbortController().signal, toolUseID: 'write-in', requestId: 'request-in' },
          )).resolves.toMatchObject({ behavior: 'allow' });
          await expect(toolGuard(
            'Write',
            { file_path: join(plan.paths.root, 'outside-workspace.json') },
            { signal: new AbortController().signal, toolUseID: 'write-out', requestId: 'request-out' },
          )).resolves.toMatchObject({ behavior: 'deny' });
          await expect(toolGuard(
            'Bash',
            { command: 'curl https://example.com' },
            { signal: new AbortController().signal, toolUseID: 'bash-out', requestId: 'bash-out' },
          )).resolves.toMatchObject({ behavior: 'deny' });
          await expect(toolGuard(
            'Bash',
            { command: 'node ../runtime/validate-ledger.mjs wake:fixture' },
            { signal: new AbortController().signal, toolUseID: 'validator-fixed', requestId: 'validator-fixed' },
          )).resolves.toMatchObject({ behavior: 'allow' });
          await expect(toolGuard(
            'Bash',
            { command: 'node .alice/steward/validate-ledger.mjs wake:fixture' },
            { signal: new AbortController().signal, toolUseID: 'validator-fake', requestId: 'validator-fake' },
          )).resolves.toMatchObject({ behavior: 'deny' });
          expect(claudeDriverOptions[0]!.systemPrompt).toEqual({
            type: 'preset',
            preset: 'claude_code',
            append: bindings[0]!.approvedInstruction,
          });
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it('records even rejected forbidden calls and fails instead of treating containment as success', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openalice-d4-audit-'));
    try {
      const fixture = await createD4SmokeTestFixture();
      const dryRun = await dryRunD4Smoke({
        ...fixture,
        repoRoot: process.cwd(),
        gitVerifier: D4_SMOKE_TEST_GIT_VERIFIER,
        contentByRef: fixture.contentByRef,
        sandboxBase: join(root, 'sandboxes'),
        quotaEvidence: quotaEvidence(fixture.manifestSha256, { kind: 'layer_admission' }),
        now: NOW,
      });
      const plan = dryRun.plans.find((candidate) => candidate.candidate.provider === 'claude')!;
      const auditLedger = new D4SmokeCapabilityAuditLedger();
      const credentialSource = join(root, 'oauth.json');
      await writeFile(credentialSource, subscriptionOAuthFixture('claude'), { mode: 0o600 });
      let claudeQueryCount = 0;
      const nativeFactory = createD4SmokeNativeDriverFactory({
        versionProbe: async () => plan.candidate.runtimeVersion,
        makeClaudeDriver: (options) => new ClaudeAgentSdkDriver({
          ...options,
          queryFn: ({ options: queryOptions }) => (async function* () {
            claudeQueryCount += 1;
            yield {
              type: 'system',
              subtype: 'init',
              model: plan.candidate.modelId,
              session_id: String(queryOptions.sessionId ?? queryOptions.resume ?? 'fixture'),
            } as never;
            if (queryOptions.pathToClaudeCodeExecutable !== 'claude') {
              throw new Error('Claude D4 runtime probe was not bound to the SDK executable');
            }
            const settings = queryOptions.settings;
            if (typeof settings === 'string'
              || !settings?.permissions?.allow?.includes('Bash(alice-uta *)')) {
              throw new Error('Claude D4 policy did not route alice-uta to the audit shim');
            }
            expect(settings.permissions?.allow).toEqual(
              expect.arrayContaining(['Write', 'Edit', 'Read', 'Glob', 'Grep']),
            );
            expect(queryOptions.settingSources).toEqual([]);
            expect(queryOptions.strictMcpConfig).toBe(true);
            expect(queryOptions.canUseTool).toBeTypeOf('function');
            expect(queryOptions.sandbox).toMatchObject({
              enabled: true,
              failIfUnavailable: true,
              allowUnsandboxedCommands: false,
              network: {
                allowedDomains: [],
                deniedDomains: ['*'],
                allowUnixSockets: [],
                allowAllUnixSockets: false,
                allowLocalBinding: false,
              },
              filesystem: { allowWrite: [plan.paths.workspace] },
            });
            expect(queryOptions.sandbox?.filesystem?.allowWrite).toEqual([plan.paths.workspace]);
            const toolGuard = queryOptions.canUseTool!;
            await expect(toolGuard(
              'Write',
              { file_path: join(plan.paths.workspace, '.alice', 'steward', 'drafts', 'wake.json') },
              { signal: new AbortController().signal, toolUseID: 'query-write-in', requestId: 'query-write-in' },
            )).resolves.toMatchObject({ behavior: 'allow' });
            await expect(toolGuard(
              'Write',
              { file_path: join(plan.paths.root, 'outside-workspace.json') },
              { signal: new AbortController().signal, toolUseID: 'query-write-out', requestId: 'query-write-out' },
            )).resolves.toMatchObject({ behavior: 'deny' });
            await expect(toolGuard(
              'Bash',
              { command: 'curl https://example.com' },
              { signal: new AbortController().signal, toolUseID: 'query-bash-out', requestId: 'query-bash-out' },
            )).resolves.toMatchObject({ behavior: 'deny' });
            await expect(toolGuard(
              'Bash',
              { command: '/usr/bin/git push --help' },
              { signal: new AbortController().signal, toolUseID: 'query-git-help', requestId: 'query-git-help' },
            )).resolves.toMatchObject({ behavior: 'deny' });
            await expect(toolGuard(
              'Bash',
              { command: '/usr/bin/git push' },
              { signal: new AbortController().signal, toolUseID: 'query-git-push', requestId: 'query-git-push' },
            )).resolves.toMatchObject({ behavior: 'deny' });
            for (const [command, args] of [
              ['alice', ['market', 'search']],
              ['traderhub', ['board', 'get']],
              ['alice-uta', ['account', 'list']],
              ['alice-uta', ['order', 'place']],
              ['alice-uta', ['order', 'modify']],
              ['alice-uta', ['order', 'cancel']],
              ['alice-uta', ['position', 'close']],
              ['alice-uta', ['git', 'commit']],
              ['alice-uta', ['git', 'reject']],
              ['alice-uta', ['git', 'push']],
              ['git', ['-C', '.', 'push']],
            ] as const) {
              await execFileAsync(command, [...args], {
                cwd: queryOptions.cwd,
                env: queryOptions.env,
              }).catch(() => undefined);
            }
            yield {
              type: 'result',
              subtype: 'success',
              duration_ms: 1,
              result: 'denied by isolated D4 audit shim',
              modelUsage: {},
              session_id: String(queryOptions.sessionId ?? queryOptions.resume ?? 'fixture'),
            } as never;
          })(),
        }),
      });

      await expect(runD4SmokeExecution({
        ...fixture,
        repoRoot: process.cwd(),
        gitVerifier: D4_SMOKE_TEST_GIT_VERIFIER,
        contentByRef: fixture.contentByRef,
        sandboxBase: join(root, 'sandboxes'),
        executionId: plan.executionId,
        credentialSources: [{
          provider: 'claude',
          sourceIdentity: 'claude-max-oauth',
          sourcePath: credentialSource,
        }],
        canonicalCredentialPaths: canonicalCredentialPaths(credentialSource),
        quotaReader: async (phase) => quotaEvidence(fixture.manifestSha256, phase),
        driverFactory: nativeFactory,
        prepareDecision: async (decision) => {
          const record = wakeRecord(decision.wakeId, decision.fictionalAsOf);
          return { record, candidateVisibleBytes: [JSON.stringify(record)] };
        },
        readTerminalArtifact: async (terminal) => terminalArtifact(plan.paths.workspace, terminal.wakeId),
        auditLedger,
        now: () => NOW,
      })).rejects.toThrow(/forbidden_capability_attempted/);
      expect(claudeQueryCount).toBe(1);
      expect(auditLedger.snapshot()).toEqual([
        expect.objectContaining({ sequence: 1, capability: 'auto_push' }),
        expect.objectContaining({ sequence: 2, capability: 'uta_mutation' }),
        expect.objectContaining({ sequence: 3, capability: 'uta_mutation' }),
        expect.objectContaining({ sequence: 4, capability: 'uta_mutation' }),
        expect.objectContaining({ sequence: 5, capability: 'uta_mutation' }),
        expect.objectContaining({ sequence: 6, capability: 'stage' }),
        expect.objectContaining({ sequence: 7, capability: 'stage' }),
        expect.objectContaining({ sequence: 8, capability: 'auto_push' }),
        expect.objectContaining({ sequence: 9, capability: 'auto_push' }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('runs the concrete filesystem adapter through the real steward bootstrap and validator', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openalice-d4-filesystem-'));
    try {
      const fixture = await createD4SmokeTestFixture();
      const sandboxBase = join(root, 'sandboxes');
      const dryRun = await dryRunD4Smoke({
        ...fixture,
        repoRoot: process.cwd(),
        gitVerifier: D4_SMOKE_TEST_GIT_VERIFIER,
        contentByRef: fixture.contentByRef,
        sandboxBase,
        quotaEvidence: quotaEvidence(fixture.manifestSha256, { kind: 'layer_admission' }),
        now: NOW,
      });
      const plan = dryRun.plans[0]!;
      const credentialSource = join(root, 'codex-oauth.json');
      await writeFile(credentialSource, subscriptionOAuthFixture('codex'), { mode: 0o600 });
      const auditLedger = new D4SmokeCapabilityAuditLedger();
      let bindingSeen: D4SmokeDriverBinding | null = null;
      const adapter = createD4SmokeFilesystemWorkspaceAdapter({ terminalWaitMs: 5_000 });

      const result = await runD4SmokeExecution({
        ...fixture,
        repoRoot: process.cwd(),
        gitVerifier: D4_SMOKE_TEST_GIT_VERIFIER,
        contentByRef: fixture.contentByRef,
        sandboxBase,
        executionId: plan.executionId,
        credentialSources: [{
          provider: 'codex',
          sourceIdentity: 'codex-subscription-oauth',
          sourcePath: credentialSource,
        }],
        canonicalCredentialPaths: canonicalCredentialPaths(credentialSource),
        quotaReader: createD4SmokeLiveQuotaReader({
          codexControl: { request: async () => codexLiveQuotaResponse() },
          claudeControl: {
            usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET:
              async () => claudeLiveQuotaResponse(),
          },
          forecastBounds: quotaForecastBounds(),
          now: () => NOW,
        }),
        driverFactory: async (binding) => {
          bindingSeen = binding;
          return {
            driver: new FakeDriver(async ({ prompt }) => {
              await commitFixtureNoTradeDecision(binding, prompt);
            }),
            resolvedModelId: binding.modelId,
            runtimeVersion: binding.runtimeVersion,
          };
        },
        bootstrapWorkspace: adapter.bootstrapWorkspace,
        prepareDecision: adapter.prepareDecision,
        readTerminalArtifact: adapter.readTerminalArtifact,
        auditLedger,
        now: () => NOW,
        deadlineMs: 5_000,
      });

      expect(bindingSeen).not.toBeNull();
      expect(result.status).toBe('valid');
      expect(result.reports).toHaveLength(12);
      expect(result.reports.every((report) =>
        report.protocol.verdict === 'pass'
        && report.decision.verdict === 'pass'
        && report.execution.verdict === 'not_evaluated')).toBe(true);
      expect(result.quotaEvidence.dispatches).toHaveLength(12);
      expect(result.capabilityAttempts).toEqual([]);

      const ledgerLines = (await readFile(
        join(plan.paths.workspace, '.alice', 'steward', 'ledger', 'decisions.jsonl'),
        'utf8',
      )).trim().split('\n');
      expect(ledgerLines).toHaveLength(12);
      expect(await readFile(join(plan.paths.workspace, 'AGENTS.md'), 'utf8')).toBe(
        `${fixture.contentByRef[fixture.manifest.content.baseline.instruction.ref]}\n\n${
          fixture.contentByRef[fixture.manifest.content.baseline.runtimePolicy.ref]
        }`,
      );
      const contextManifest = JSON.parse(await readFile(
        join(plan.paths.workspace, '.alice', 'steward', 'context-manifest.json'),
        'utf8',
      )) as { skills: unknown[]; d4: { proposalOnly: boolean } };
      expect(contextManifest.skills).toEqual([]);
      expect(contextManifest.d4.proposalOnly).toBe(true);
      const candidateWorkspaceBytes = await Promise.all([
        readFile(join(plan.paths.workspace, '.alice', 'steward', 'config.json'), 'utf8'),
        readFile(join(plan.paths.workspace, '.alice', 'steward', 'context-manifest.json'), 'utf8'),
      ]).then((parts) => parts.join('\n'));
      expect(candidateWorkspaceBytes).not.toContain(plan.candidate.modelId);
      expect(candidateWorkspaceBytes).not.toContain(plan.candidate.provider);
      const candidateCell = JSON.parse(
        fixture.contentByRef[plan.cell.evidence.candidatePayload.ref]!,
      ) as { decisions: Array<{ visibleEndExclusive: number }>; bars: unknown[] };
      const audit = JSON.parse(
        fixture.contentByRef[plan.cell.evidence.audit.ref]!,
      ) as { decisionManifests: Array<{ asOf: string }> };

      for (let decisionIndex = 0; decisionIndex < 12; decisionIndex += 1) {
        const wakeId = result.reports[decisionIndex]!.wakeId;
        expect(wakeId).toMatch(/^wake:[0-9a-f]{64}$/);
        const wake = parseStewardWakeRecord(JSON.parse(await readFile(
          join(plan.paths.workspace, '.alice', 'steward', 'wakes', `${encodeURIComponent(wakeId)}.json`),
          'utf8',
        )));
        expect(wake.envelope).toMatchObject({
          accountId: 'eval:d4-smoke:proposal-only',
          authzLevel: 'read_only',
          wakePurpose: 'pure_research_review',
          executionMode: 'proposal_only',
          configuredUta: false,
        });
        expect(wake.envelope.marketContext).not.toHaveProperty('tradeableAliceId');
        expect(wake.envelope.marketContext).toMatchObject({
          schema: 'steward-d4-decision-snapshot/1',
          decisionOrdinal: decisionIndex + 1,
          bars: candidateCell.bars.slice(0, candidateCell.decisions[decisionIndex]!.visibleEndExclusive),
        });
        const candidateVisibleText = [
          await readFile(
            join(plan.paths.workspace, '.alice', 'steward', 'wakes', `${encodeURIComponent(wakeId)}.json`),
            'utf8',
          ),
          await readFile(join(plan.paths.workspace, wake.envelope.snapshotRef!.path), 'utf8'),
        ].join('\n').toLowerCase();
        for (const forbidden of [
          plan.candidate.provider,
          plan.candidate.modelId,
          plan.cell.id,
          plan.cell.profile,
          plan.cell.instrument.provider,
          plan.cell.instrument.symbol,
          plan.cell.instrument.exchangeCalendar,
          audit.decisionManifests[decisionIndex]!.asOf,
        ]) {
          expect(candidateVisibleText).not.toContain(forbidden.toLowerCase());
        }
      }
      await expect(access(join(plan.paths.root, 'orchestrator-provenance'))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});

async function commitFixtureNoTradeDecision(
  binding: D4SmokeDriverBinding,
  prompt: string,
): Promise<void> {
  const match = /^<STEWARD_WAKE id="([^"]+)"/m.exec(prompt);
  if (match === null) throw new Error('fixture driver did not receive a steward wake');
  const wakeId = match[1]!;
  const wake = parseStewardWakeRecord(JSON.parse(await readFile(
    join(binding.cwd, '.alice', 'steward', 'wakes', `${encodeURIComponent(wakeId)}.json`),
    'utf8',
  )));
  const snapshot = stewardInformationSnapshotSchema.parse(JSON.parse(await readFile(
    join(binding.cwd, wake.envelope.snapshotRef!.path),
    'utf8',
  )));
  const contextManifestPath = join(binding.cwd, '.alice', 'steward', 'context-manifest.json');
  const contextManifestBytes = await readFile(contextManifestPath);
  const draft = {
    version: 3,
    wakeId,
    at: snapshot.asOf,
    accountId: wake.envelope.accountId,
    decision: 'no_trade',
    status: 'done',
    context: {
      manifestPath: '.alice/steward/context-manifest.json',
      manifestSha256: sha256StewardEvaluationContent(contextManifestBytes),
    },
    completion: {
      reason: 'Frozen D4 fixture emits a proposal-only no-trade terminal artifact.',
      evidenceRefs: [`wake:${wakeId}`, `snapshot:${snapshot.snapshotId}`],
    },
    checklist: {
      account: 'skipped: synthetic evaluation identity',
      positions: 'skipped: UTA not configured',
      orders: 'skipped: UTA not configured',
      risk: 'proposal_only',
      market: 'frozen_dev_prefix',
      history: 'checked',
    },
    thesis: 'No trade in the deterministic filesystem-adapter fixture.',
    actions: [],
    pendingHash: null,
    invalidation: 'A new approved D4 fixture may change this test decision.',
    cost: {
      model: binding.modelId,
      inputTokens: null,
      outputTokens: null,
      modelCostUsd: null,
      allocatedServerCostUsd: null,
      tradingFeesUsd: null,
      estimatedSlippageUsd: null,
      totalEstimatedCostUsd: null,
    },
    intent: null,
    thesisDispositions: [],
  };
  await writeFile(
    join(binding.cwd, '.alice', 'steward', 'drafts', `${encodeURIComponent(wakeId)}.json`),
    `${JSON.stringify(draft, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600, flag: 'wx' },
  );
  await execFileAsync(
    process.execPath,
    ['../runtime/validate-ledger.mjs', wakeId],
    {
      cwd: binding.cwd,
      env: { ...binding.env, ELECTRON_RUN_AS_NODE: '1' },
      timeout: 5_000,
      maxBuffer: 256 * 1024,
    },
  );
}

function wakeRecord(wakeId: string, asOf: string): StewardWakeRecord {
  const asOfMs = Date.parse(asOf);
  const injectedAt = new Date(asOfMs + 1_000).toISOString();
  return parseStewardWakeRecord({
    version: 1,
    wakeId,
    status: 'injected',
    createdAt: asOf,
    updatedAt: injectedAt,
    injectedAt,
    completedAt: null,
    deadline: new Date(Date.parse(asOf) + 60_000).toISOString(),
    sessionId: 'thread-fixture',
    controlFace: 'machine',
    finalizeProtocol: 'marker',
    envelope: {
      version: 2,
      reason: 'scheduled_observe',
      accountId: 'eval:d4-smoke:proposal-only',
      authzLevel: 'read_only',
      expectedDecision: 'no_trade',
      wakePurpose: 'pure_research_review',
      executionMode: 'proposal_only',
      configuredUta: false,
      marketContext: { source: 'D4 Smoke fixture' },
      riskContext: { proposalOnly: true },
      snapshotRef: {
        snapshotId: `snap:${wakeId}`,
        sha256: '1'.repeat(64),
        path: `.alice/steward/snapshots/${encodeURIComponent(wakeId)}.json`,
        asOf,
      },
    },
  });
}

const D3_CONTENTS: Record<string, string> = {
  snapshot: 'snapshot',
  dataset: 'dataset',
  market: 'market',
  portfolio: 'portfolio',
  risk: 'risk',
  events: 'events',
  history: 'history',
  universe: 'universe',
  sampling: 'sampling',
};

async function terminalArtifact(workspaceDir: string, wakeId: string) {
  const store = createStewardEvaluationProvenanceStore(workspaceDir);
  for (const [ref, content] of Object.entries(D3_CONTENTS)) {
    await store.publishContent(ref, content);
  }
  const manifest = d3Manifest(wakeId);
  await store.publishManifest(wakeId, `${JSON.stringify(manifest, null, 2)}\n`);
  return {
    provenanceStore: store,
    evaluationInput: {
      schema: 'steward-wake-evaluation-input/1' as const,
      version: 1 as const,
      wakeId,
      protocol: {
        wakeDelivered: true,
        ledgerValidated: true,
        finalizeMatched: true,
        lockIntegrity: true,
        recoveryIntegrity: 'not_required' as const,
      },
      decision: {
        contractValid: true,
        qualityChecks: [{ id: 'as_of_reasoning', passed: true, detail: 'fixture' }],
      },
      execution: {
        requested: false,
        riskEnvelopeValid: true,
        fidelityChecks: [],
        containment: [],
      },
      dataManifest: manifest,
    },
  };
}

function d3Manifest(wakeId: string): StewardEvaluationDataManifest {
  const identity = (ref: string) => ({ ref, sha256: sha256StewardEvaluationContent(D3_CONTENTS[ref]!) });
  const source = (ref: string) => ({
    required: true,
    provided: true,
    items: [{
      ...identity(ref),
      observedAt: '2025-01-01T00:00:00.000Z',
      availableAt: '2025-01-01T00:00:00.000Z',
    }],
    note: null,
  });
  return {
    schema: 'steward-eval-data-manifest/1',
    version: 1,
    wakeId,
    datasetId: `dataset:${wakeId}`,
    asOf: '2025-03-01T00:00:00.000Z',
    snapshot: identity('snapshot'),
    dataset: {
      provider: 'fixture',
      name: 'D4 Smoke bars',
      rawSymbol: 'BTC-USD',
      assetClass: 'crypto-major',
      timezone: 'UTC',
      exchangeCalendar: '24x7',
      content: identity('dataset'),
    },
    adjustment: { mode: 'unadjusted', corporateActionRefs: [] },
    sources: {
      market: source('market'),
      portfolio: source('portfolio'),
      risk: source('risk'),
      events: source('events'),
      history: source('history'),
    },
    publications: [],
    corporateActions: [],
    universe: {
      selectionBasis: 'point_in_time',
      membershipAsOf: '2025-01-01T00:00:00.000Z',
      effectiveFrom: '2025-01-01T00:00:00.000Z',
      effectiveTo: null,
      source: identity('universe'),
    },
    sampling: {
      kind: 'continuous_walk_forward',
      frozenAt: '2026-07-01T00:00:00.000Z',
      plan: identity('sampling'),
    },
    audit: {
      manifestCreatedAt: '2026-07-02T00:00:00.000Z',
      evaluationStartedAt: '2026-07-13T00:00:00.000Z',
    },
    split: {
      name: 'dev',
      identity: 'split:dev:d4-smoke',
      leakageGroups: ['family:d4-smoke'],
      inputStart: '2025-01-01T00:00:00.000Z',
      decisionStart: '2025-02-01T00:00:00.000Z',
      decisionEnd: '2025-12-01T00:00:00.000Z',
      outcomeEnd: '2026-01-01T00:00:00.000Z',
      embargoMs: 0,
    },
  };
}

// Compile-time proof (issue #205 invariant 2/6): the shakedown artifact and
// quota types are NOT assignable to their official Smoke counterparts. If a
// future edit made either assignable, the conditional type resolves to `false`
// and this assignment fails to compile.
type ShakedownResultNotOfficial = D4EngineeringShakedownResult extends D4SmokeExecutionResult ? false : true;
type ShakedownQuotaNotOfficial = D4EngineeringShakedownQuotaEvidence extends D4SmokeQuotaEvidence ? false : true;
type ShakedownFailureNotOfficial = D4EngineeringShakedownFailure extends D4SmokeExecutionResult ? false : true;
const SHAKEDOWN_RESULT_NOT_OFFICIAL: ShakedownResultNotOfficial = true;
const SHAKEDOWN_QUOTA_NOT_OFFICIAL: ShakedownQuotaNotOfficial = true;
const SHAKEDOWN_FAILURE_NOT_OFFICIAL: ShakedownFailureNotOfficial = true;

function shakedownPhase(
  shakedownExecutionId: string,
  kind: 'shakedown_dispatch' | 'shakedown_post_turn',
): D4ShakedownQuotaPhase {
  return { kind, shakedownExecutionId, decisionIndex: 0, wakeId: 'wake:fixture' };
}

function shakedownQuotaEvidence(
  manifestSha256: string,
  phase: D4ShakedownQuotaPhase,
  modelId: keyof typeof D4_ENGINEERING_SHAKEDOWN_APPLICABLE_WINDOWS,
  usedPercent = 10,
) {
  const applicable = D4_ENGINEERING_SHAKEDOWN_APPLICABLE_WINDOWS[modelId];
  const provider = modelId.startsWith('claude') ? 'claude' : 'codex';
  return {
    schema: 'steward-d4-engineering-shakedown-quota/1',
    version: 1,
    purpose: 'engineering_shakedown',
    eligibleForInference: false,
    inferenceEligibility: 'forbidden',
    validForRanking: false,
    validForSurvivorSelection: false,
    validForOfficialSmoke: false,
    manifestSha256,
    provider,
    phase,
    capturedAt: '2026-07-13T11:59:30.000Z',
    validUntil: '2026-07-13T12:05:00.000Z',
    forecastModelTurnCount: 1,
    cost: {
      actualIncrementalSpendUsd: 0,
      forecastIncrementalSpendUsd: 0,
      subscriptionQuota: {
        windows: applicable.map((id) => ({
          id,
          provider,
          usedPercent,
          perTurnForecastAdditionalPercent: 0.5,
          sourceIdentity: `fixture:${id}`,
          forecast: {
            basis: 'observed_delta_upper_bound_single_turn',
            observedDeltaUpperBoundPercentPerModelTurn: 0.5,
            forecastModelTurnCount: 1,
            observationCount: 3,
            observedAt: '2026-07-13T11:50:00.000Z',
            sourceIdentity: `fixture-observed:${id}`,
          },
        })),
      },
      shadowApiEquivalent: { status: 'unknown', amountUsd: null },
    },
  };
}

function validShakedownResult(): D4EngineeringShakedownResult {
  const shakedownExecutionId = 'engineering-shakedown:claude:claude-fable-5:d4-crypto-major-bull-a:d01';
  const wakeId = `wake:${'a'.repeat(64)}`;
  const manifestSha256 = 'a'.repeat(64);
  return {
    schema: 'steward-d4-engineering-shakedown-result/1',
    version: 1,
    purpose: 'engineering_shakedown',
    inferenceEligibility: 'forbidden',
    eligibleForInference: false,
    validForRanking: false,
    validForSurvivorSelection: false,
    validForOfficialSmoke: false,
    shakedownExecutionId,
    manifestSha256,
    provider: 'claude',
    requestedModelId: 'claude-fable-5',
    actualModelIds: ['claude-fable-5'],
    decisionIndex: 0,
    wakeId,
    terminalStatus: 'completed',
    diagnosticReport: {
      schema: 'steward-d4-engineering-shakedown-diagnostic-report/1',
      version: 1,
      purpose: 'engineering_shakedown',
      inferenceEligibility: 'forbidden',
      eligibleForInference: false,
      validForRanking: false,
      validForSurvivorSelection: false,
      validForOfficialSmoke: false,
      wakeId,
      protocolVerdict: 'pass',
      decisionVerdict: 'pass',
      executionVerdict: 'not_evaluated',
    },
    durationMs: 1,
    latencyMs: 0,
    tokenTelemetry: null,
    quota: {
      dispatch: shakedownQuotaEvidence(
        manifestSha256,
        { kind: 'shakedown_dispatch', shakedownExecutionId, decisionIndex: 0, wakeId },
        'claude-fable-5',
      ) as unknown as D4EngineeringShakedownQuotaEvidence,
      postTurn: shakedownQuotaEvidence(
        manifestSha256,
        { kind: 'shakedown_post_turn', shakedownExecutionId, decisionIndex: 0, wakeId },
        'claude-fable-5',
        11,
      ) as unknown as D4EngineeringShakedownQuotaEvidence,
      windowDeltas: D4_ENGINEERING_SHAKEDOWN_APPLICABLE_WINDOWS['claude-fable-5'].map((id) => ({
        id,
        provider: 'claude' as const,
        beforePercent: 10,
        afterPercent: 11,
        deltaPercent: 1,
      })),
    },
    credential: {
      provider: 'claude',
      sourceIdentity: 'claude-max-oauth',
      sourcePathSha256: 'b'.repeat(64),
      sourceSha256: 'c'.repeat(64),
      byteLength: 100,
      targetRelativePath: '.credentials.json',
      unchangedAfterExecution: true,
    },
    capabilityAttempts: [],
  };
}

describe('D4 engineering shakedown (issue #205)', () => {
  it('keeps 108/1296 official counts intact and blocks shakedown/official schema crossover', async () => {
    const fixture = await createD4SmokeTestFixture();
    expect(D4_SMOKE_EXECUTION_COUNT).toBe(108);
    expect(D4_SMOKE_MODEL_TURN_COUNT).toBe(1296);
    expect(D4_ENGINEERING_SHAKEDOWN_MODEL_TURN_COUNT).toBe(1);
    expect(SHAKEDOWN_RESULT_NOT_OFFICIAL && SHAKEDOWN_QUOTA_NOT_OFFICIAL && SHAKEDOWN_FAILURE_NOT_OFFICIAL).toBe(true);

    const executionId = 'engineering-shakedown:claude:claude-fable-5:d4-crypto-major-bull-a:d01';
    const shakedown = shakedownQuotaEvidence(
      fixture.manifestSha256,
      shakedownPhase(executionId, 'shakedown_dispatch'),
      'claude-fable-5',
    );
    // The official quota schema/validator can never ingest a shakedown artifact.
    expect(d4SmokeQuotaEvidenceSchema.safeParse(shakedown).success).toBe(false);
    expect(() => validateD4SmokeQuotaEvidence({
      evidence: shakedown,
      manifestSha256: fixture.manifestSha256,
      phase: { kind: 'layer_admission' },
      now: NOW,
    })).toThrow();
    // And the shakedown schema rejects an official-Smoke evidence artifact.
    const official = quotaEvidence(fixture.manifestSha256, { kind: 'layer_admission' });
    expect(d4EngineeringShakedownQuotaEvidenceSchema.safeParse(official).success).toBe(false);
  });

  it('namespaces shakedown execution ids and sandbox roots away from official Smoke', async () => {
    const fixture = await createD4SmokeTestFixture();
    const stage = await validateD4SmokeStage({
      ...fixture,
      repoRoot: process.cwd(),
      gitVerifier: D4_SMOKE_TEST_GIT_VERIFIER,
    });
    const sandboxBase = '/tmp/d4-shakedown-plan';
    const officialPlans = planD4SmokeExecutions(stage, sandboxBase);
    const cellId = stage.manifest.content.cells[0]!.id;
    const selector: D4EngineeringShakedownSelector = { modelId: 'claude-fable-5', cellId, decisionIndex: 0 };
    const plan = planD4EngineeringShakedown(stage, sandboxBase, selector);

    expect(plan.purpose).toBe('engineering_shakedown');
    expect(plan.decisionIndex).toBe(0);
    expect(plan.shakedownExecutionId.startsWith('engineering-shakedown:')).toBe(true);
    expect(officialPlans.map((official) => official.executionId)).not.toContain(plan.shakedownExecutionId);
    expect(new Set(officialPlans.map((official) => official.paths.root)).has(plan.paths.root)).toBe(false);
    expect(plan.paths.root.includes('engineering-shakedown-')).toBe(true);
    expect(() => planD4EngineeringShakedown(stage, sandboxBase, { ...selector, modelId: 'gpt-not-real' }))
      .toThrow(/selection_invalid/);
    expect(() => planD4EngineeringShakedown(stage, sandboxBase, { ...selector, cellId: 'no-such-cell' }))
      .toThrow(/selection_invalid/);
    expect(() => planD4EngineeringShakedown(stage, sandboxBase, { ...selector, decisionIndex: 12 }))
      .toThrow(/selection_invalid/);
  });

  it('uses a short private Claude bridge directory for the saved long D4 path shape', async () => {
    const artifactTmpSocket = join(
      '/home/user/.local/state/openalice/d4-engineering-shakedown/sandboxes',
      'c7c3231ac811d4eb0589a771c07ee38034bc69227602c12df14fe1057baf143e',
      'engineering-shakedown-dba3e23907f7b062',
      'tmp',
      'bridge.sock',
    );
    expect(Buffer.byteLength(artifactTmpSocket)).toBeGreaterThan(107);

    const root = await mkdtemp(join(tmpdir(), 'openalice-d4-bridge-'));
    try {
      const longSocket = join(root, 'x'.repeat(128), 'bridge.sock');
      await mkdir(dirname(longSocket), { recursive: true, mode: 0o700 });
      await expect(bindUnixSocket(longSocket)).rejects.toMatchObject({ code: 'EINVAL' });

      const fixture = await createD4SmokeTestFixture();
      const stage = await validateD4SmokeStage({
        ...fixture,
        repoRoot: process.cwd(),
        gitVerifier: D4_SMOKE_TEST_GIT_VERIFIER,
      });
      const selector: D4EngineeringShakedownSelector = {
        modelId: 'claude-fable-5',
        cellId: stage.manifest.content.cells[0]!.id,
        decisionIndex: 0,
      };
      const plan = planD4EngineeringShakedown(stage, join(root, 'sandboxes'), selector);
      const bridgeSocket = join(plan.paths.claudeBridgeTempDir, 'x'.repeat(64));

      expect(plan.env.CLAUDE_CODE_TMPDIR).toBe(plan.paths.claudeBridgeTempDir);
      expect(plan.env.TMPDIR).toBe(plan.paths.tempRoot);
      expect(Buffer.byteLength(bridgeSocket)).toBeLessThanOrEqual(107);
      await mkdir(plan.paths.claudeBridgeTempDir, { recursive: false, mode: 0o700 });
      try {
        await expect(bindUnixSocket(bridgeSocket)).resolves.toBeUndefined();
      } finally {
        await rm(plan.paths.claudeBridgeTempDir, { recursive: true, force: true });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('enforces single-turn quota math, the reserve gate, and fails closed', async () => {
    const fixture = await createD4SmokeTestFixture();
    const executionId = 'engineering-shakedown:claude:claude-fable-5:d4-crypto-major-bull-a:d01';
    const dispatchPhase = shakedownPhase(executionId, 'shakedown_dispatch');
    const base = shakedownQuotaEvidence(fixture.manifestSha256, dispatchPhase, 'claude-fable-5');
    const validate = (overrides: {
      evidence?: unknown;
      phase?: D4ShakedownQuotaPhase;
      modelId?: keyof typeof D4_ENGINEERING_SHAKEDOWN_APPLICABLE_WINDOWS;
      now?: Date;
    } = {}) => validateD4EngineeringShakedownQuotaEvidence({
      evidence: overrides.evidence ?? base,
      manifestSha256: fixture.manifestSha256,
      phase: overrides.phase ?? dispatchPhase,
      modelId: overrides.modelId ?? 'claude-fable-5',
      now: overrides.now ?? NOW,
    });

    // Valid: per-window per-turn forecast is exactly the observed delta * one turn.
    expect(validate().cost.subscriptionQuota.windows.every((window) =>
      window.forecast.forecastModelTurnCount === 1
      && window.perTurnForecastAdditionalPercent
        === window.forecast.observedDeltaUpperBoundPercentPerModelTurn)).toBe(true);
    expect(() => validate({ now: new Date('2026-07-13T12:06:00.000Z') })).toThrow(/stale/);
    // Evidence built for one model does not satisfy another model's window set.
    expect(() => validate({ modelId: 'claude-sonnet-5' })).toThrow(/invalid|incomplete/);

    const mismatched = clone(base);
    mismatched.cost.subscriptionQuota.windows[0]!.perTurnForecastAdditionalPercent = 5;
    expect(() => validate({ evidence: mismatched })).toThrow(/single-turn forecast/);

    // Reserve: stop before current + one-turn forecast can reach 80%.
    const exhausted = clone(base);
    exhausted.cost.subscriptionQuota.windows[0]!.usedPercent = 79.6;
    expect(() => validate({ evidence: exhausted })).toThrow(/reserve_exhausted/);

    // The fresh post-turn snapshot is reported, never treated as admission.
    const postPhase = shakedownPhase(executionId, 'shakedown_post_turn');
    const postExhausted = shakedownQuotaEvidence(fixture.manifestSha256, postPhase, 'claude-fable-5', 79.6);
    expect(() => validate({ evidence: postExhausted, phase: postPhase })).not.toThrow();

    // The official full-run 1296 forecast is never admissible here.
    const officialTurnCount = clone(base) as unknown as { forecastModelTurnCount: number };
    officialTurnCount.forecastModelTurnCount = 1296;
    expect(() => validate({ evidence: officialTurnCount })).toThrow(/invalid/);
  });

  it.each(
    Object.entries(D4_ENGINEERING_SHAKEDOWN_APPLICABLE_WINDOWS) as Array<
      [keyof typeof D4_ENGINEERING_SHAKEDOWN_APPLICABLE_WINDOWS, readonly string[]]
    >,
  )('requires exactly %s\'s applicable windows and fails closed on drift', (modelId, expectedIds) => {
    const manifestSha256 = 'a'.repeat(64);
    const executionId = `engineering-shakedown:x:${modelId}:d4-crypto-major-bull-a:d01`;
    const phase = shakedownPhase(executionId, 'shakedown_dispatch');
    const validate = (evidence: unknown) => validateD4EngineeringShakedownQuotaEvidence({
      evidence,
      manifestSha256,
      phase,
      modelId,
      now: NOW,
    });

    const base = shakedownQuotaEvidence(manifestSha256, phase, modelId);
    // The applicable ordered set, exactly.
    expect(validate(base).cost.subscriptionQuota.windows.map((window) => window.id)).toEqual(expectedIds);

    // A missing applicable window fails closed.
    const missing = clone(base);
    missing.cost.subscriptionQuota.windows.pop();
    expect(() => validate(missing)).toThrow(/incomplete|invalid/);

    // An extra, non-applicable window fails closed.
    const extraId = D4_SMOKE_QUOTA_WINDOWS.map((window) => window.id).find((id) => !expectedIds.includes(id))!;
    const extra = clone(base);
    extra.cost.subscriptionQuota.windows.push({
      ...clone(base.cost.subscriptionQuota.windows[0]!),
      id: extraId,
    });
    expect(() => validate(extra)).toThrow(/incomplete|invalid/);
  });

  it('validates the full result strictly and rejects label-only, relabeled, or official-key artifacts', () => {
    const valid = validShakedownResult();
    expect(assertD4EngineeringShakedownNonInferential(valid)).toBe(valid);

    // A label-only object no longer passes: the strict schema needs every field.
    const {
      schema, version, purpose, inferenceEligibility, eligibleForInference,
      validForRanking, validForSurvivorSelection, validForOfficialSmoke,
    } = valid;
    expect(() => assertD4EngineeringShakedownNonInferential({
      schema, version, purpose, inferenceEligibility, eligibleForInference,
      validForRanking, validForSurvivorSelection, validForOfficialSmoke,
    })).toThrow(/artifact_invalid/);

    // Missing a required field.
    const { manifestSha256: _dropped, ...missing } = valid;
    expect(() => assertD4EngineeringShakedownNonInferential(missing)).toThrow(/artifact_invalid/);
    // An unknown/extra field (strict schema).
    expect(() => assertD4EngineeringShakedownNonInferential({ ...valid, extra: true })).toThrow(/artifact_invalid/);
    // A raw official-shaped report is not an allowed property.
    expect(() => assertD4EngineeringShakedownNonInferential({ ...valid, report: {} })).toThrow(/artifact_invalid/);
    // Relabeling attempts.
    expect(() => assertD4EngineeringShakedownNonInferential({ ...valid, validForOfficialSmoke: true }))
      .toThrow(D4EngineeringShakedownError);
    expect(() => assertD4EngineeringShakedownNonInferential({ ...valid, purpose: 'official_smoke' }))
      .toThrow(/artifact_invalid/);
    expect(() => assertD4EngineeringShakedownNonInferential({ ...valid, actualModelIds: ['fallback'] }))
      .toThrow(/actual model set/);
    expect(() => assertD4EngineeringShakedownNonInferential({
      ...valid,
      diagnosticReport: { ...valid.diagnosticReport, wakeId: 'wake:mismatch' },
    })).toThrow(/diagnostic wakeId mismatch/);
    expect(() => assertD4EngineeringShakedownNonInferential({
      ...valid,
      quota: {
        ...valid.quota,
        dispatch: { ...valid.quota.dispatch, manifestSha256: 'b'.repeat(64) },
      },
    })).toThrow(/quota evidence is not bound/);
    expect(() => assertD4EngineeringShakedownNonInferential({
      ...valid,
      quota: {
        ...valid.quota,
        windowDeltas: valid.quota.windowDeltas.map((delta, index) =>
          index === 0 ? { ...delta, deltaPercent: 99 } : delta),
      },
    })).toThrow(/quota delta is not bound/);
    // Official-Smoke result collection keys are rejected with a targeted message.
    expect(() => assertD4EngineeringShakedownNonInferential({ ...valid, reports: [] })).toThrow(/reports/);
    expect(() => assertD4EngineeringShakedownNonInferential({ ...valid, status: 'valid' })).toThrow(/status/);
    expect(() => assertD4EngineeringShakedownNonInferential({ ...valid, quotaEvidence: {} })).toThrow(/quotaEvidence/);
  });

  it('rejects test seams on the shakedown filesystem entrypoint before any dispatch', async () => {
    const driverFactory = vi.fn();
    await expect(runD4EngineeringShakedownFilesystem({
      driverFactory,
    } as unknown as Parameters<typeof runD4EngineeringShakedownFilesystem>[0])).rejects.toThrow(
      /production_seam_forbidden/,
    );
    expect(driverFactory).not.toHaveBeenCalled();
  });

  it('preserves strict post-turn accounting in a distinct failure error before rejecting mismatched provider model ids', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openalice-d4-shakedown-failure-'));
    try {
      const fixture = await createD4SmokeTestFixture();
      const stage = await validateD4SmokeStage({
        ...fixture,
        repoRoot: process.cwd(),
        gitVerifier: D4_SMOKE_TEST_GIT_VERIFIER,
      });
      const sandboxBase = join(root, 'sandboxes');
      const selector: D4EngineeringShakedownSelector = {
        modelId: 'claude-fable-5',
        cellId: stage.manifest.content.cells[0]!.id,
        decisionIndex: 0,
      };
      const plan = planD4EngineeringShakedown(stage, sandboxBase, selector);
      const credentialSource = join(root, '.credentials.json');
      await writeFile(credentialSource, subscriptionOAuthFixture('claude'), { mode: 0o600 });
      const driver = new FakeDriver();
      vi.spyOn(driver, 'runTurn').mockResolvedValue({
        turnId: 'turn-fable-with-auxiliary',
        status: 'completed',
        agentMessage: 'completed with provider-reported auxiliary model',
        durationMs: 42,
        interrupted: false,
        actualModelIds: ['claude-fable-5', 'claude-haiku-4-5-20251001'],
      });
      vi.spyOn(driver, 'readTelemetry').mockReturnValue({
        totalTokens: 193_997,
        inputTokens: 13,
        cachedInputTokens: 188_583,
        outputTokens: 5_401,
        updatedAt: NOW.toISOString(),
      });
      const phases: D4ShakedownQuotaPhase[] = [];
      const failure = await runD4EngineeringShakedown({
        ...fixture,
        repoRoot: process.cwd(),
        gitVerifier: D4_SMOKE_TEST_GIT_VERIFIER,
        contentByRef: fixture.contentByRef,
        sandboxBase,
        selector,
        credentialSources: [{
          provider: 'claude',
          sourceIdentity: 'claude-max-oauth',
          sourcePath: credentialSource,
        }],
        canonicalCredentialPaths: canonicalCredentialPaths(credentialSource),
        quotaReader: async (phase, quotaPlan) => {
          phases.push(phase);
          return shakedownQuotaEvidence(
            fixture.manifestSha256,
            phase,
            quotaPlan.candidate.modelId as keyof typeof D4_ENGINEERING_SHAKEDOWN_APPLICABLE_WINDOWS,
            phase.kind === 'shakedown_post_turn' ? 11 : 10,
          );
        },
        driverFactory: async (binding) => ({
          driver,
          resolvedModelId: binding.modelId,
          runtimeVersion: binding.runtimeVersion,
        }),
        bootstrapWorkspace: async () => {
          await mkdir(join(plan.paths.workspace, '.alice', 'steward'), { recursive: true, mode: 0o700 });
          await writeFile(
            join(plan.paths.workspace, '.alice', 'steward', 'validate-ledger.mjs'),
            'process.exit(0)\n',
            { mode: 0o600 },
          );
        },
        prepareDecision: async (decision) => {
          const record = wakeRecord(decision.wakeId, decision.fictionalAsOf);
          return { record, candidateVisibleBytes: [JSON.stringify(record)] };
        },
        readTerminalArtifact: async (terminal) => terminalArtifact(plan.paths.workspace, terminal.wakeId),
        auditLedger: new D4SmokeCapabilityAuditLedger(),
        now: () => NOW,
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(D4EngineeringShakedownFailureError);
      const artifact = (failure as D4EngineeringShakedownFailureError).artifact as D4EngineeringShakedownFailure;
      expect(phases.map((phase) => phase.kind)).toEqual(['shakedown_dispatch', 'shakedown_post_turn']);
      expect(assertD4EngineeringShakedownFailureNonInferential(artifact)).toBe(artifact);
      expect(artifact).toMatchObject({
        schema: 'steward-d4-engineering-shakedown-failure/1',
        purpose: 'engineering_shakedown_failure',
        failureValidity: 'invalid',
        provider: 'claude',
        requestedModelId: 'claude-fable-5',
        providerReportedModelIds: ['claude-fable-5', 'claude-haiku-4-5-20251001'],
        terminal: { providerReportedStatus: 'completed', interrupted: false },
        durationMs: 42,
        latencyMs: 0,
        tokenTelemetry: { totalTokens: 193_997 },
        credential: { provider: 'claude', unchangedAfterExecution: true },
        capabilityAttempts: [],
        error: { kind: 'policy', code: 'model_binding_invalid' },
      });
      expect(artifact.quota.dispatch.phase.kind).toBe('shakedown_dispatch');
      expect(artifact.quota.postTurn.phase.kind).toBe('shakedown_post_turn');
      expect(artifact).not.toHaveProperty('status');
      expect(artifact).not.toHaveProperty('reports');
      expect(artifact).not.toHaveProperty('quotaEvidence');
      expect(() => assertD4EngineeringShakedownFailureNonInferential({ ...artifact, status: 'invalid' }))
        .toThrow(/status/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it('runs exactly one non-inferential frozen turn and never yields an official-Smoke result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openalice-d4-shakedown-'));
    try {
      const fixture = await createD4SmokeTestFixture();
      const stage = await validateD4SmokeStage({
        ...fixture,
        repoRoot: process.cwd(),
        gitVerifier: D4_SMOKE_TEST_GIT_VERIFIER,
      });
      const sandboxBase = join(root, 'sandboxes');
      const selector: D4EngineeringShakedownSelector = {
        modelId: 'claude-fable-5',
        cellId: stage.manifest.content.cells[0]!.id,
        decisionIndex: 0,
      };
      const plan = planD4EngineeringShakedown(stage, sandboxBase, selector);
      const credentialSource = join(root, '.credentials.json');
      await writeFile(credentialSource, subscriptionOAuthFixture('claude'), { mode: 0o600 });
      const driver = new FakeDriver();
      const phases: D4ShakedownQuotaPhase[] = [];
      const auditLedger = new D4SmokeCapabilityAuditLedger();

      const result: D4EngineeringShakedownResult = await runD4EngineeringShakedown({
        ...fixture,
        repoRoot: process.cwd(),
        gitVerifier: D4_SMOKE_TEST_GIT_VERIFIER,
        contentByRef: fixture.contentByRef,
        sandboxBase,
        selector,
        credentialSources: [{
          provider: 'claude',
          sourceIdentity: 'claude-max-oauth',
          sourcePath: credentialSource,
        }],
        canonicalCredentialPaths: canonicalCredentialPaths(credentialSource),
        quotaReader: async (phase, quotaPlan) => {
          phases.push(phase);
          expect(quotaPlan.shakedownExecutionId).toBe(plan.shakedownExecutionId);
          return shakedownQuotaEvidence(
            fixture.manifestSha256,
            phase,
            quotaPlan.candidate.modelId as keyof typeof D4_ENGINEERING_SHAKEDOWN_APPLICABLE_WINDOWS,
            phase.kind === 'shakedown_post_turn' ? 11 : 10,
          );
        },
        driverFactory: async (binding) => ({
          driver,
          resolvedModelId: binding.modelId,
          runtimeVersion: binding.runtimeVersion,
        }),
        bootstrapWorkspace: async () => {
          await mkdir(join(plan.paths.workspace, '.alice', 'steward'), { recursive: true, mode: 0o700 });
          await writeFile(
            join(plan.paths.workspace, '.alice', 'steward', 'validate-ledger.mjs'),
            'process.exit(0)\n',
            { mode: 0o600 },
          );
        },
        prepareDecision: async (decision) => {
          const record = wakeRecord(decision.wakeId, decision.fictionalAsOf);
          return { record, candidateVisibleBytes: [JSON.stringify(record)] };
        },
        readTerminalArtifact: async (terminal) => terminalArtifact(plan.paths.workspace, terminal.wakeId),
        auditLedger,
        now: () => NOW,
        deadlineMs: 10_000,
      });

      // Exactly one frozen turn dispatched.
      expect(driver.ensureCalls).toHaveLength(1);
      expect(driver.turnCalls).toHaveLength(1);
      expect(driver.turnCalls[0]!.options.model).toBe('claude-fable-5');
      // One pre-dispatch read + one fresh post-turn read.
      expect(phases.map((phase) => phase.kind)).toEqual(['shakedown_dispatch', 'shakedown_post_turn']);

      // Non-inferential artifact — NOT the official collection shape and NO raw report.
      expect(result.purpose).toBe('engineering_shakedown');
      expect(result.inferenceEligibility).toBe('forbidden');
      expect(result.eligibleForInference).toBe(false);
      expect(result.validForRanking).toBe(false);
      expect(result.validForSurvivorSelection).toBe(false);
      expect(result.validForOfficialSmoke).toBe(false);
      expect(result).not.toHaveProperty('status');
      expect(result).not.toHaveProperty('reports');
      expect(result).not.toHaveProperty('report');
      expect(result).not.toHaveProperty('quotaEvidence');
      // Verdicts live only in the distinct diagnostic report, carrying its own literals.
      expect(result.diagnosticReport.schema).toBe('steward-d4-engineering-shakedown-diagnostic-report/1');
      expect(result.diagnosticReport.purpose).toBe('engineering_shakedown');
      expect(result.diagnosticReport.eligibleForInference).toBe(false);
      expect(result.diagnosticReport.validForOfficialSmoke).toBe(false);
      expect(result.diagnosticReport.wakeId).toBe(result.wakeId);
      expect(result.diagnosticReport.protocolVerdict).toBe('pass');
      expect(result.diagnosticReport.decisionVerdict).toBe('pass');
      expect(result.diagnosticReport.executionVerdict).toBe('not_evaluated');
      expect(result.terminalStatus).toBe('completed');
      expect(result.durationMs).toBe(1);
      expect(result.latencyMs).toBe(0);

      // Exact model identity, credential receipt, and clean capability ledger.
      expect(result.requestedModelId).toBe('claude-fable-5');
      expect(result.actualModelIds).toEqual(['claude-fable-5']);
      expect(result.provider).toBe('claude');
      expect(result.shakedownExecutionId).toBe(plan.shakedownExecutionId);
      expect(result.credential).toMatchObject({ provider: 'claude', unchangedAfterExecution: true });
      expect(result.capabilityAttempts).toEqual([]);

      // Per-window before/after/delta for exactly claude-fable-5's applicable windows.
      expect(result.quota.dispatch.phase.kind).toBe('shakedown_dispatch');
      expect(result.quota.postTurn.phase.kind).toBe('shakedown_post_turn');
      expect(result.quota.windowDeltas.map((delta) => delta.id)).toEqual(
        D4_ENGINEERING_SHAKEDOWN_APPLICABLE_WINDOWS['claude-fable-5'],
      );
      expect(result.quota.windowDeltas.every((delta) =>
        delta.beforePercent === 10 && delta.afterPercent === 11 && delta.deltaPercent === 1)).toBe(true);

      // The artifact cannot be relabeled as, or assigned to, an official Smoke result.
      expect(assertD4EngineeringShakedownNonInferential(result)).toBe(result);
      expect(d4SmokeQuotaEvidenceSchema.safeParse(result.quota.dispatch).success).toBe(false);
      expect(d4EngineeringShakedownQuotaEvidenceSchema.safeParse(result.quota.dispatch).success).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);
});
