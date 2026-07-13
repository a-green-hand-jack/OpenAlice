import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdtemp,
  mkdir,
  open,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { query as sdkQuery, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import {
  stewardEvaluationManifestContentIdentities,
} from './evaluation-data-manifest.js';
import { evaluateStewardWake, type StewardWakeEvaluationInput, type StewardWakeEvaluationReport } from './evaluation-harness.js';
import {
  createStewardEvaluationProvenanceStore,
  type StewardEvaluationProvenanceStore,
} from './evaluation-provenance-store.js';
import { createStewardFinalizeStore } from './finalize-store.js';
import { formatStewardWakeMessage } from './injector.js';
import { canonicalDecisionFingerprint } from './ledger-receipt.js';
import { createStewardLedgerStore } from './ledger-store.js';
import {
  publishStewardInformationSnapshot,
  validateStewardDecisionSnapshotBinding,
  validateStewardSnapshotTemporalIntegrity,
  validateStewardThesisDispositionCoverage,
} from './snapshot.js';
import {
  type StewardDecisionLedgerEntry,
  type StewardFinalizeMarker,
  type StewardInformationSnapshot,
  type StewardWakeRecord,
} from './types.js';
import { createStewardWakeStore } from './wake-store.js';
import {
  D4_SMOKE_CANDIDATES,
  D4_SMOKE_CREDENTIAL_SOURCES,
  D4_SMOKE_DECISION_COUNT,
  D4_SMOKE_EXECUTION_COUNT,
  D4_SMOKE_FORBIDDEN_CAPABILITIES,
  D4_SMOKE_QUOTA_WINDOWS,
  D4_SMOKE_REPETITIONS,
  D4_SMOKE_SYNTHETIC_ACCOUNT_ID,
  d4SmokeDecisionWindow,
  expectedD4SmokeCellIds,
  materializeD4SmokeEvaluationManifest,
  validateD4SmokeStage,
  type D4SmokeCandidate,
  type D4SmokeCell,
  type D4SmokeCriticReceipt,
  type D4SmokeForbiddenCapability,
  type D4SmokeGitVerifier,
  type D4SmokeQuotaForecastEvidence,
  type ValidatedD4SmokeCellData,
  type ValidatedD4SmokeStage,
} from './d4-smoke-stage-manifest.js';
export { D4_SMOKE_QUOTA_WINDOWS } from './d4-smoke-stage-manifest.js';
import { JsonRpcStdioClient } from './machine-driver/jsonrpc-stdio.js';
import type { MachineTransport, StewardMachineDriver } from './machine-driver/types.js';
import {
  ClaudeAgentSdkDriver,
  type ClaudeAgentSdkDriverOptions,
} from './machine-driver/claude-agent-sdk-driver.js';
import {
  CodexAppServerDriver,
  type CodexAppServerDriverOptions,
} from './machine-driver/codex-app-server-driver.js';

export const D4_SMOKE_QUOTA_EVIDENCE_SCHEMA = 'steward-d4-quota-evidence/1' as const;
export const D4_SMOKE_QUOTA_EVIDENCE_VERSION = 1 as const;
export const D4_SMOKE_AUDIT_SCHEMA = 'steward-d4-capability-audit/1' as const;
export const D4_SMOKE_AUDIT_VERSION = 1 as const;
export const D4_SMOKE_MODEL_TURN_COUNT = 1296 as const;
export const D4_SMOKE_WAKE_PURPOSE = 'pure_research_review' as const;
export const D4_SMOKE_FORECAST_BASIS = 'observed_delta_upper_bound' as const;
export const D4_SMOKE_FICTIONAL_INJECT_OFFSET_MS = 1_000 as const;
export const D4_SMOKE_FICTIONAL_DEADLINE_OFFSET_MS = 60_000 as const;

const execFileAsync = promisify(execFile);

export const D4_SMOKE_CLAUDE_SETTINGS: Exclude<
  ClaudeAgentSdkDriverOptions['settings'],
  string | undefined
> = {
  enableAllProjectMcpServers: false,
  permissions: {
    allow: [
      'Write',
      'Edit',
      'Read',
      'Glob',
      'Grep',
      'Bash(node ../runtime/validate-ledger.mjs *)',
      'Bash(alice *)',
      'Bash(alice-uta *)',
      'Bash(traderhub *)',
      'Bash(git *)',
    ],
    deny: [
      'WebFetch',
      'WebSearch',
    ],
  },
};

const D4_STEWARD_TEMPLATE_ROOT = fileURLToPath(new URL('../templates/steward/', import.meta.url));
const D4_STEWARD_BOOTSTRAP = join(D4_STEWARD_TEMPLATE_ROOT, 'bootstrap.mjs');
const D4_REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const nonEmptyStringSchema = z.string().trim().min(1);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const isoTimestampSchema = z.iso.datetime({ offset: true });
const percentageSchema = z.number().finite().min(0).max(100);

const codexSubscriptionOAuthSchema = z.object({
  auth_mode: z.literal('chatgpt'),
  OPENAI_API_KEY: z.null(),
  tokens: z.object({
    access_token: nonEmptyStringSchema,
    refresh_token: nonEmptyStringSchema,
    id_token: nonEmptyStringSchema,
    account_id: nonEmptyStringSchema,
  }).passthrough(),
}).passthrough();

const claudeMaxSubscriptionOAuthSchema = z.object({
  claudeAiOauth: z.object({
    accessToken: nonEmptyStringSchema,
    refreshToken: nonEmptyStringSchema,
    subscriptionType: z.literal('max'),
  }).passthrough(),
}).strict();

const quotaWindowSchema = z.object({
  id: nonEmptyStringSchema,
  provider: z.enum(['codex', 'claude']),
  usedPercent: percentageSchema,
  forecastAdditionalPercent: percentageSchema,
  sourceIdentity: nonEmptyStringSchema,
  forecast: z.object({
    basis: z.literal(D4_SMOKE_FORECAST_BASIS),
    observedDeltaUpperBoundPercentPerModelTurn: z.number().finite().positive().max(100),
    applicableModelTurnCount: z.number().int().positive(),
    observationCount: z.number().int().positive(),
    observedAt: isoTimestampSchema,
    sourceIdentity: nonEmptyStringSchema,
  }).strict(),
}).strict();

const codexRateLimitWindowSchema = z.object({
  usedPercent: percentageSchema,
  windowDurationMins: z.literal(10_080),
  resetsAt: z.number().int().positive().nullable(),
}).passthrough();

const codexRateLimitSnapshotSchema = z.object({
  limitId: nonEmptyStringSchema,
  primary: codexRateLimitWindowSchema,
  secondary: z.null(),
  credits: z.object({
    hasCredits: z.literal(false),
    unlimited: z.literal(false),
    balance: z.union([z.literal('0'), z.null()]),
  }).passthrough().nullable(),
  individualLimit: z.null(),
  planType: z.enum(['go', 'plus', 'pro', 'prolite', 'team', 'business', 'enterprise', 'edu']),
}).passthrough();

const codexRateLimitsResponseSchema = z.object({
  rateLimitsByLimitId: z.record(z.string(), codexRateLimitSnapshotSchema),
  rateLimitResetCredits: z.object({
    availableCount: z.literal(0),
    credits: z.array(z.never()).length(0),
  }).strict(),
}).passthrough();

const claudeUsageWindowSchema = z.object({
  utilization: percentageSchema,
  resets_at: nonEmptyStringSchema.nullable(),
}).passthrough();

const claudeUsageResponseSchema = z.object({
  session: z.object({
    total_cost_usd: z.literal(0),
    total_api_duration_ms: z.literal(0),
    model_usage: z.record(z.string(), z.unknown()).refine(
      (value) => Object.keys(value).length === 0,
      'quota control must not perform a model call',
    ),
  }).passthrough(),
  subscription_type: z.literal('max'),
  rate_limits_available: z.literal(true),
  rate_limits: z.object({
    five_hour: claudeUsageWindowSchema,
    seven_day: claudeUsageWindowSchema,
    model_scoped: z.array(z.object({
      display_name: nonEmptyStringSchema,
      utilization: percentageSchema,
      resets_at: nonEmptyStringSchema.nullable(),
    }).passthrough()),
    extra_usage: z.object({
      is_enabled: z.literal(false),
      monthly_limit: z.union([z.literal(0), z.null()]),
      used_credits: z.union([z.literal(0), z.null()]),
      utilization: z.union([z.literal(0), z.null()]),
    }).passthrough(),
    spend: z.object({
      enabled: z.literal(false),
      used: z.object({ amount_minor: z.literal(0) }).passthrough(),
      can_purchase_credits: z.literal(false),
    }).passthrough(),
  }).passthrough(),
}).passthrough();

const externalAuditAttemptSchema = z.object({
  schema: z.literal(D4_SMOKE_AUDIT_SCHEMA),
  version: z.literal(D4_SMOKE_AUDIT_VERSION),
  capability: z.enum(D4_SMOKE_FORBIDDEN_CAPABILITIES),
  at: isoTimestampSchema,
  detail: nonEmptyStringSchema.nullable(),
}).strict();

export const d4SmokeQuotaEvidenceSchema = z.object({
  schema: z.literal(D4_SMOKE_QUOTA_EVIDENCE_SCHEMA),
  version: z.literal(D4_SMOKE_QUOTA_EVIDENCE_VERSION),
  manifestSha256: sha256Schema,
  phase: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('layer_admission') }).strict(),
    z.object({
      kind: z.literal('dispatch'),
      executionId: nonEmptyStringSchema,
      decisionIndex: z.number().int().min(0).max(D4_SMOKE_DECISION_COUNT - 1),
      wakeId: nonEmptyStringSchema,
    }).strict(),
  ]),
  capturedAt: isoTimestampSchema,
  validUntil: isoTimestampSchema,
  forecastExecutionCount: z.literal(D4_SMOKE_EXECUTION_COUNT),
  forecastModelTurnCount: z.literal(D4_SMOKE_MODEL_TURN_COUNT),
  cost: z.object({
    actualIncrementalSpendUsd: z.literal(0),
    forecastIncrementalSpendUsd: z.literal(0),
    subscriptionQuota: z.object({
      windows: z.array(quotaWindowSchema),
    }).strict(),
    shadowApiEquivalent: z.discriminatedUnion('status', [
      z.object({ status: z.literal('unknown'), amountUsd: z.null() }).strict(),
      z.object({ status: z.literal('estimated'), amountUsd: z.number().finite().nonnegative() }).strict(),
    ]),
  }).strict(),
}).strict();

export type D4SmokeQuotaEvidence = z.infer<typeof d4SmokeQuotaEvidenceSchema>;
export type D4SmokeQuotaPhase = D4SmokeQuotaEvidence['phase'];
export type D4SmokeQuotaWindowId = typeof D4_SMOKE_QUOTA_WINDOWS[number]['id'];

export interface D4SmokeQuotaForecastBound {
  readonly observedDeltaUpperBoundPercentPerModelTurn: number;
  readonly applicableModelTurnCount: number;
  readonly observationCount: number;
  readonly observedAt: string;
  readonly sourceIdentity: string;
}

export type D4SmokeQuotaForecastBounds = Readonly<Record<
  D4SmokeQuotaWindowId,
  D4SmokeQuotaForecastBound
>>;

export interface D4SmokeCodexQuotaControl {
  request(method: 'account/rateLimits/read', params: null): Promise<unknown>;
}

export interface D4SmokeClaudeQuotaControl {
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(): Promise<unknown>;
}

export interface D4SmokeLiveQuotaReader {
  (
    phase: D4SmokeQuotaPhase,
    plan: D4SmokeExecutionPlan,
  ): Promise<D4SmokeQuotaEvidence>;
  readonly kind: 'live_subscription_controls';
}

export function createD4SmokeLiveQuotaReader(options: {
  readonly codexControl: D4SmokeCodexQuotaControl;
  readonly claudeControl: D4SmokeClaudeQuotaControl;
  readonly forecastBounds: D4SmokeQuotaForecastBounds;
  readonly now?: () => Date;
  readonly validityMs?: number;
}): D4SmokeLiveQuotaReader {
  const now = options.now ?? (() => new Date());
  const validityMs = options.validityMs ?? 60_000;
  if (!Number.isInteger(validityMs) || validityMs <= 0) {
    throw new D4SmokeQuotaError('invalid', 'live quota validityMs must be a positive integer');
  }
  const reader = async (phase: D4SmokeQuotaPhase, plan: D4SmokeExecutionPlan) => {
    const captured = now();
    let liveUsed: Readonly<Partial<Record<D4SmokeQuotaWindowId, number>>>;
    if (phase.kind === 'layer_admission') {
      const codexRaw = await options.codexControl.request('account/rateLimits/read', null);
      const claudeRaw = await options.claudeControl
        .usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
      liveUsed = readD4SmokeLiveQuotaWindows(codexRaw, claudeRaw);
    } else if (plan.candidate.provider === 'codex') {
      liveUsed = readD4SmokeCodexQuotaWindows(
        await options.codexControl.request('account/rateLimits/read', null),
      );
    } else {
      liveUsed = readD4SmokeClaudeQuotaWindows(
        await options.claudeControl.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(),
      );
    }
    return buildD4SmokeQuotaEvidenceFromUsed({
      phase,
      plan,
      liveUsed,
      forecastBounds: options.forecastBounds,
      captured,
      validityMs,
    });
  };
  const liveReader = Object.assign(reader, { kind: 'live_subscription_controls' as const });
  return liveReader;
}

function buildD4SmokeQuotaEvidenceFromUsed(input: {
  readonly phase: D4SmokeQuotaPhase;
  readonly plan: D4SmokeExecutionPlan;
  readonly liveUsed: Readonly<Partial<Record<D4SmokeQuotaWindowId, number>>>;
  readonly forecastBounds: D4SmokeQuotaForecastBounds;
  readonly captured: Date;
  readonly validityMs: number;
}): D4SmokeQuotaEvidence {
  const expectedWindows = D4_SMOKE_QUOTA_WINDOWS.filter(({ provider }) =>
    input.phase.kind === 'layer_admission' || provider === input.plan.candidate.provider);
  const windows = expectedWindows.map(({ id, provider }) => {
      const bound = input.forecastBounds[id];
      if (bound === undefined) {
        throw new D4SmokeQuotaError('incomplete', `${id} has no observed delta upper bound`);
      }
      const usedPercent = input.liveUsed[id];
      if (usedPercent === undefined) {
        throw new D4SmokeQuotaError('incomplete', `${id} live quota value is missing`);
      }
      return {
        id,
        provider,
        usedPercent,
        forecastAdditionalPercent: forecastD4SmokeLayerPercent(bound),
        sourceIdentity: provider === 'codex'
          ? `codex:account/rateLimits/read:${id === 'codex-spark' ? 'codex_bengalfox' : 'codex'}`
          : `claude:usage-control:${id}`,
        forecast: {
          basis: D4_SMOKE_FORECAST_BASIS,
          ...bound,
        },
      };
    });
    const evidence = {
      schema: D4_SMOKE_QUOTA_EVIDENCE_SCHEMA,
      version: D4_SMOKE_QUOTA_EVIDENCE_VERSION,
      manifestSha256: input.plan.manifestSha256,
      phase: input.phase,
      capturedAt: input.captured.toISOString(),
      validUntil: new Date(input.captured.getTime() + input.validityMs).toISOString(),
      forecastExecutionCount: D4_SMOKE_EXECUTION_COUNT,
      forecastModelTurnCount: D4_SMOKE_MODEL_TURN_COUNT,
      cost: {
        actualIncrementalSpendUsd: 0,
        forecastIncrementalSpendUsd: 0,
        subscriptionQuota: { windows },
        shadowApiEquivalent: { status: 'unknown' as const, amountUsd: null },
      },
    };
    return validateD4SmokeQuotaEvidence({
      evidence,
      manifestSha256: input.plan.manifestSha256,
      phase: input.phase,
      ...(input.phase.kind === 'dispatch' ? { provider: input.plan.candidate.provider } : {}),
      now: input.captured,
    });
}

export interface D4SmokeNativeQuotaControlContext {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface D4SmokePreflightQuotaSnapshot {
  readonly capturedAt: Date;
  readonly codexRaw: unknown;
  readonly claudeRaw: unknown;
  readonly codexRuntime: D4SmokeCodexNativeRuntime | null;
}

export type D4SmokeNativeQuotaProbe = (
  context: D4SmokeNativeQuotaControlContext,
) => Promise<unknown>;

export type D4SmokeCodexQuotaProbe = (
  context: D4SmokeNativeQuotaControlContext,
  runtime: D4SmokeCodexNativeRuntime | null,
) => Promise<unknown>;

export async function captureD4SmokeIsolatedPreflightQuota(input: {
  readonly canonical: D4SmokeCanonicalCredentialPaths;
  readonly expectedCodexRuntimeVersion?: string;
  readonly resolveCodexRuntime?: (expectedVersion: string) => Promise<D4SmokeCodexNativeRuntime>;
  readonly readCodex?: D4SmokeCodexQuotaProbe;
  readonly readClaude?: D4SmokeNativeQuotaProbe;
  readonly now?: () => Date;
}): Promise<D4SmokePreflightQuotaSnapshot> {
  const codexRuntime = input.expectedCodexRuntimeVersion === undefined
    ? null
    : await (input.resolveCodexRuntime ?? resolveD4CodexNativeRuntime)(
        input.expectedCodexRuntimeVersion,
      );
  if (codexRuntime !== null) {
    await assertD4CodexNativeRuntimeIdentity(codexRuntime, input.expectedCodexRuntimeVersion!);
  } else if (input.readCodex === undefined) {
    throw new D4SmokePolicyError(
      'model_binding_invalid',
      'Codex quota preflight requires the frozen native runtime',
    );
  }
  const codexRaw = await withD4SmokeEphemeralQuotaCredential(
    'codex',
    input.canonical.codex,
    async (context) => {
      if (codexRuntime !== null) {
        await assertD4CodexNativeRuntimeIdentity(codexRuntime, codexRuntime.version);
      }
      return input.readCodex !== undefined
        ? input.readCodex(context, codexRuntime)
        : readNativeCodexQuota(
            codexRuntime!.executable,
            'account/rateLimits/read',
            null,
            context,
          );
    },
  );
  const claudeRaw = await withD4SmokeEphemeralQuotaCredential(
    'claude',
    input.canonical.claude,
    input.readClaude ?? readNativeClaudeQuota,
  );
  readD4SmokeLiveQuotaWindows(codexRaw, claudeRaw);
  return {
    capturedAt: (input.now ?? (() => new Date()))(),
    codexRaw,
    claudeRaw,
    codexRuntime,
  };
}

function createD4SmokeNativeExecutionQuotaReader(
  snapshot: D4SmokePreflightQuotaSnapshot,
  forecastBounds: D4SmokeQuotaForecastBounds,
): D4SmokeLiveQuotaReader {
  const reader = async (phase: D4SmokeQuotaPhase, plan: D4SmokeExecutionPlan) => {
    if (phase.kind === 'layer_admission') {
      return buildD4SmokeQuotaEvidenceFromUsed({
        phase,
        plan,
        liveUsed: readD4SmokeLiveQuotaWindows(snapshot.codexRaw, snapshot.claudeRaw),
        forecastBounds,
        captured: snapshot.capturedAt,
        validityMs: 60_000,
      });
    }
    const captured = new Date();
    const context = { cwd: plan.paths.workspace, env: plan.env };
    let liveUsed: Readonly<Record<string, number>>;
    if (plan.candidate.provider === 'codex') {
      if (snapshot.codexRuntime === null) {
        throw new D4SmokePolicyError(
          'model_binding_invalid',
          'Codex dispatch quota reader is missing the preflight runtime attestation',
        );
      }
      await assertD4CodexNativeRuntimeIdentity(
        snapshot.codexRuntime,
        plan.candidate.runtimeVersion,
      );
      liveUsed = readD4SmokeCodexQuotaWindows(await readNativeCodexQuota(
        snapshot.codexRuntime.executable,
        'account/rateLimits/read',
        null,
        context,
      ));
    } else {
      liveUsed = readD4SmokeClaudeQuotaWindows(await readNativeClaudeQuota(context));
    }
    return buildD4SmokeQuotaEvidenceFromUsed({
      phase,
      plan,
      liveUsed,
      forecastBounds,
      captured,
      validityMs: 60_000,
    });
  };
  return Object.assign(reader, { kind: 'live_subscription_controls' as const });
}

async function readNativeCodexQuota(
  executable: string,
  method: 'account/rateLimits/read',
  params: null,
  control: D4SmokeNativeQuotaControlContext,
): Promise<unknown> {
  const child = spawn(executable, ['app-server'], {
    cwd: control.cwd,
    env: { ...control.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (!child.stdin || !child.stdout) {
    child.kill('SIGTERM');
    throw new D4SmokeQuotaError('invalid', 'Codex quota control did not expose stdio');
  }
  const childFailure = new Promise<never>((_resolve, reject) => {
    child.once('error', (error) => reject(new D4SmokeQuotaError(
      'invalid',
      `Codex quota control failed to start: ${error.message}`,
    )));
  });
  child.stderr?.resume();
  const client = new JsonRpcStdioClient(child as unknown as MachineTransport);
  try {
    await withD4ControlTimeout(Promise.race([
      client.request('initialize', {
        clientInfo: {
          name: 'openalice-d4-quota-reader',
          title: 'OpenAlice D4 quota reader',
          version: '1',
        },
      }),
      childFailure,
    ]), 'Codex initialize');
    client.notify('initialized');
    return await withD4ControlTimeout(
      Promise.race([client.request(method, params), childFailure]),
      'Codex quota read',
    );
  } finally {
    try { child.kill('SIGTERM'); } catch { /* already exited */ }
  }
}

async function readNativeClaudeQuota(controlContext: D4SmokeNativeQuotaControlContext): Promise<unknown> {
  let releasePrompt!: () => void;
  const promptGate = new Promise<void>((resolvePrompt) => { releasePrompt = resolvePrompt; });
  const prompt = (async function* (): AsyncGenerator<SDKUserMessage> {
    await promptGate;
  })();
  const control = sdkQuery({
    prompt,
    options: {
      cwd: controlContext.cwd,
      env: { ...controlContext.env },
      permissionMode: 'dontAsk',
      settingSources: [],
      strictMcpConfig: true,
      tools: [],
      skills: [],
    },
  });
  try {
    return await withD4ControlTimeout(
      control.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(),
      'Claude quota read',
    );
  } finally {
    releasePrompt();
    control.close();
  }
}

async function withD4ControlTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new D4SmokeQuotaError('invalid', `${label} timed out`)), 15_000);
    timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export class D4SmokeQuotaError extends Error {
  constructor(readonly code: 'invalid' | 'stale' | 'incomplete' | 'reserve_exhausted', detail: string) {
    super(`D4 Smoke quota ${code}: ${detail}`);
    this.name = 'D4SmokeQuotaError';
  }
}

export function validateD4SmokeQuotaEvidence(input: {
  readonly evidence: unknown;
  readonly manifestSha256: string;
  readonly phase: D4SmokeQuotaPhase;
  readonly provider?: 'codex' | 'claude';
  readonly now: Date;
}): D4SmokeQuotaEvidence {
  const parsed = d4SmokeQuotaEvidenceSchema.safeParse(input.evidence);
  if (!parsed.success) {
    throw new D4SmokeQuotaError(
      'invalid',
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
    );
  }
  const evidence = parsed.data;
  if (evidence.manifestSha256 !== input.manifestSha256) {
    throw new D4SmokeQuotaError(
      'invalid',
      `evidence binds ${evidence.manifestSha256}, manifest is ${input.manifestSha256}`,
    );
  }
  if (JSON.stringify(evidence.phase) !== JSON.stringify(input.phase)) {
    throw new D4SmokeQuotaError(
      'invalid',
      `expected phase ${JSON.stringify(input.phase)}, received ${JSON.stringify(evidence.phase)}`,
    );
  }
  const nowMs = input.now.getTime();
  if (!Number.isFinite(nowMs)
    || nowMs < Date.parse(evidence.capturedAt)
    || nowMs > Date.parse(evidence.validUntil)) {
    throw new D4SmokeQuotaError(
      'stale',
      `${input.now.toISOString()} is outside ${evidence.capturedAt}..${evidence.validUntil}`,
    );
  }
  if (input.phase.kind === 'dispatch' && input.provider === undefined) {
    throw new D4SmokeQuotaError('invalid', 'dispatch quota validation requires the selected provider');
  }
  const expectedWindows = D4_SMOKE_QUOTA_WINDOWS.filter(({ provider }) =>
    input.phase.kind === 'layer_admission' || provider === input.provider);
  const identities = evidence.cost.subscriptionQuota.windows.map(({ id, provider }) => ({ id, provider }));
  const expectedIdentities = expectedWindows.map(({ id, provider }) => ({ id, provider }));
  if (JSON.stringify(identities) !== JSON.stringify(expectedIdentities)) {
    throw new D4SmokeQuotaError(
      'incomplete',
      input.phase.kind === 'layer_admission'
        ? 'all five frozen quota windows are required in canonical order'
        : `dispatch requires exactly the selected ${input.provider} quota windows`,
    );
  }
  for (const window of evidence.cost.subscriptionQuota.windows) {
    const frozenWindow = D4_SMOKE_QUOTA_WINDOWS.find(({ id }) => id === window.id)!;
    if (window.forecast.applicableModelTurnCount !== frozenWindow.applicableModelTurnCount) {
      throw new D4SmokeQuotaError(
        'invalid',
        `${window.id} forecast turn count must equal ${frozenWindow.applicableModelTurnCount}`,
      );
    }
    if (Date.parse(window.forecast.observedAt) > Date.parse(evidence.capturedAt)) {
      throw new D4SmokeQuotaError('invalid', `${window.id} observed upper bound is from the future`);
    }
    const expectedForecast = forecastD4SmokeLayerPercent(window.forecast);
    if (Math.abs(window.forecastAdditionalPercent - expectedForecast) > 1e-12) {
      throw new D4SmokeQuotaError(
        'invalid',
        `${window.id} full-layer forecast must derive from its observed delta upper bound`,
      );
    }
    const projected = window.usedPercent + window.forecastAdditionalPercent;
    if (projected >= 80) {
      throw new D4SmokeQuotaError(
        'reserve_exhausted',
        `${window.id} projects ${projected}% used; 20% reserve requires less than 80%`,
      );
    }
  }
  return evidence;
}

function forecastD4SmokeLayerPercent(bound: Pick<
  D4SmokeQuotaForecastBound,
  'observedDeltaUpperBoundPercentPerModelTurn' | 'applicableModelTurnCount'
>): number {
  const value = bound.observedDeltaUpperBoundPercentPerModelTurn;
  if (
    !Number.isFinite(value)
    || value <= 0
    || !Number.isInteger(bound.applicableModelTurnCount)
    || bound.applicableModelTurnCount <= 0
  ) {
    throw new D4SmokeQuotaError(
      'incomplete',
      'reliable observed delta upper bound per model turn is required; zero or guessed deltas are not admissible',
    );
  }
  return Math.min(100, value * bound.applicableModelTurnCount);
}

function readD4SmokeLiveQuotaWindows(
  codexRaw: unknown,
  claudeRaw: unknown,
): Readonly<Record<D4SmokeQuotaWindowId, number>> {
  return {
    ...readD4SmokeCodexQuotaWindows(codexRaw),
    ...readD4SmokeClaudeQuotaWindows(claudeRaw),
  };
}

function readD4SmokeCodexQuotaWindows(
  codexRaw: unknown,
): Readonly<Record<'codex-general-weekly' | 'codex-spark', number>> {
  const codex = codexRateLimitsResponseSchema.safeParse(codexRaw);
  if (!codex.success) {
    throw new D4SmokeQuotaError('invalid', `Codex subscription quota response: ${formatZodIssues(codex.error)}`);
  }
  const general = codex.data.rateLimitsByLimitId['codex'];
  const spark = codex.data.rateLimitsByLimitId['codex_bengalfox'];
  if (general?.limitId !== 'codex' || spark?.limitId !== 'codex_bengalfox') {
    throw new D4SmokeQuotaError('incomplete', 'Codex general and Spark limit buckets are required by exact key');
  }
  for (const bucket of [general, spark]) {
    const credits = bucket.credits;
    if (credits !== null && (credits.hasCredits || credits.unlimited || !['0', null].includes(credits.balance))) {
      throw new D4SmokeQuotaError('invalid', `${bucket.limitId} exposes credits/overage`);
    }
    if (bucket.individualLimit !== null) {
      throw new D4SmokeQuotaError('invalid', `${bucket.limitId} exposes metered spend control`);
    }
  }
  return {
    'codex-general-weekly': general.primary.usedPercent,
    'codex-spark': spark.primary.usedPercent,
  };
}

function readD4SmokeClaudeQuotaWindows(
  claudeRaw: unknown,
): Readonly<Record<
  'claude-all-model-weekly' | 'claude-fable-weekly' | 'claude-current-short',
  number
>> {
  const claude = claudeUsageResponseSchema.safeParse(claudeRaw);
  if (!claude.success) {
    throw new D4SmokeQuotaError('invalid', `Claude Max quota response: ${formatZodIssues(claude.error)}`);
  }
  const fable = claude.data.rate_limits.model_scoped.filter(
    (window) => window.display_name.trim().toLowerCase() === 'fable',
  );
  if (fable.length !== 1) {
    throw new D4SmokeQuotaError('incomplete', 'Claude Fable weekly quota window is required exactly once');
  }
  return {
    'claude-all-model-weekly': claude.data.rate_limits.seven_day.utilization,
    'claude-fable-weekly': fable[0]!.utilization,
    'claude-current-short': claude.data.rate_limits.five_hour.utilization,
  };
}

export function deriveD4SmokeQuotaForecastBounds(input: {
  readonly stage: ValidatedD4SmokeStage;
  readonly contentByRef: Readonly<Record<string, string | Uint8Array>>;
}): D4SmokeQuotaForecastBounds {
  const evidence = input.stage.quotaForecastEvidence;
  const deltas = new Map<D4SmokeQuotaWindowId, number[]>();
  const observedAtByWindow = new Map<D4SmokeQuotaWindowId, string[]>();
  for (const { id } of D4_SMOKE_QUOTA_WINDOWS) deltas.set(id, []);
  for (const { id } of D4_SMOKE_QUOTA_WINDOWS) observedAtByWindow.set(id, []);

  for (const observation of evidence.observations) {
    const before = readForecastObservationSnapshot(
      observation.provider,
      observation.before,
      input.contentByRef,
      observation.id,
    );
    const after = readForecastObservationSnapshot(
      observation.provider,
      observation.after,
      input.contentByRef,
      observation.id,
    );
    const charges = new Map(observation.charges.map((charge) => [charge.id, charge]));
    for (const { id, calibrationTurnCount } of D4_SMOKE_QUOTA_WINDOWS.filter(
      (window) => window.provider === observation.provider,
    )) {
      const charge = charges.get(id);
      if (
        charge === undefined
        || !Number.isInteger(charge.chargedTurnCount)
        || charge.chargedTurnCount !== calibrationTurnCount
        || !Number.isFinite(charge.resolutionPercent)
        || charge.resolutionPercent <= 0
      ) {
        throw new D4SmokeQuotaError(
          'incomplete',
          `${observation.id}:${id} requires the exact ${calibrationTurnCount}-turn calibration and positive display resolution`,
        );
      }
      const beforeValue = before[id];
      const afterValue = after[id];
      if (beforeValue === undefined || afterValue === undefined) {
        throw new D4SmokeQuotaError('incomplete', `${observation.id}:${id} raw window is missing`);
      }
      const delta = afterValue - beforeValue;
      if (delta < 0) {
        throw new D4SmokeQuotaError(
          'incomplete',
          `${observation.id}:${id} crossed a quota reset; it cannot prove an upper bound`,
        );
      }
      deltas.get(id)!.push(
        (delta + charge.resolutionPercent) / charge.chargedTurnCount,
      );
      observedAtByWindow.get(id)!.push(observation.after.capturedAt);
    }
  }

  const identity = input.stage.manifest.content.baseline.quotaForecastEvidence;
  return Object.fromEntries(D4_SMOKE_QUOTA_WINDOWS.map(({ id, applicableModelTurnCount }) => {
    const windowDeltas = deltas.get(id)!;
    const upperBound = Math.max(...windowDeltas);
    if (!Number.isFinite(upperBound) || upperBound <= 0) {
      throw new D4SmokeQuotaError(
        'incomplete',
        `${id} has no positive critic-bound resolution-adjusted upper bound`,
      );
    }
    return [id, {
      observedDeltaUpperBoundPercentPerModelTurn: upperBound,
      applicableModelTurnCount,
      observationCount: windowDeltas.length,
      observedAt: observedAtByWindow.get(id)!.sort().at(-1)!,
      sourceIdentity: `critic-bound:${identity.sha256}:${id}`,
    }];
  })) as D4SmokeQuotaForecastBounds;
}

function readForecastObservationSnapshot(
  provider: 'codex' | 'claude',
  snapshot: D4SmokeQuotaForecastEvidence['observations'][number]['before'],
  contentByRef: Readonly<Record<string, string | Uint8Array>>,
  observationId: string,
): Readonly<Partial<Record<D4SmokeQuotaWindowId, number>>> {
  const identity = snapshot.raw;
  const value = contentByRef[identity.ref];
  if (value === undefined) {
    throw new D4SmokeQuotaError('incomplete', `${observationId}:${provider} source is missing`);
  }
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
  if (createHash('sha256').update(bytes).digest('hex') !== identity.sha256) {
    throw new D4SmokeQuotaError('invalid', `${observationId}:${provider} source hash changed`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    throw new D4SmokeQuotaError(
      'invalid',
      `${observationId}:${provider} source is not UTF-8 JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return provider === 'codex'
    ? readD4SmokeCodexQuotaWindows(parsed)
    : readD4SmokeClaudeQuotaWindows(parsed);
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
}

export interface D4SmokeSandboxPaths {
  readonly root: string;
  readonly workspace: string;
  readonly home: string;
  readonly openAliceHome: string;
  readonly launcherRoot: string;
  readonly globalDir: string;
  readonly codexHome: string;
  readonly claudeConfigDir: string;
  readonly configRoot: string;
  readonly sessionRoot: string;
  readonly cacheRoot: string;
  readonly trustRoot: string;
  readonly tempRoot: string;
  readonly runtimeRoot: string;
  readonly runtimeValidator: string;
  readonly runtimeAuditAppendHelper: string;
  readonly runtimeCodexLauncher: string;
  readonly runtimeIsolationCanary: string;
  readonly auditBin: string;
  readonly auditCallLedger: string;
  readonly localStorageFile: string;
}

export interface D4SmokeExecutionPlan {
  readonly ordinal: number;
  readonly executionId: string;
  readonly manifestSha256: string;
  readonly candidate: D4SmokeCandidate;
  readonly cell: D4SmokeCell;
  readonly repetitionId: 'r1';
  readonly paths: D4SmokeSandboxPaths;
  readonly env: Readonly<Record<string, string>>;
}

export class D4SmokePlanError extends Error {
  constructor(readonly code: 'coverage_invalid' | 'model_binding_invalid' | 'shared_writable_root', detail: string) {
    super(`D4 Smoke plan ${code}: ${detail}`);
    this.name = 'D4SmokePlanError';
  }
}

export function planD4SmokeExecutions(
  stage: ValidatedD4SmokeStage,
  sandboxBaseInput: string,
): readonly D4SmokeExecutionPlan[] {
  const sandboxBase = resolve(sandboxBaseInput);
  const plans: D4SmokeExecutionPlan[] = [];
  let ordinal = 0;
  for (const candidate of stage.manifest.content.candidates) {
    for (const cell of stage.manifest.content.cells) {
      for (const repetitionId of stage.manifest.content.repetitions) {
        const executionId = `${candidate.provider}:${candidate.modelId}:${cell.id}:${repetitionId}`;
        const slug = createHash('sha256').update(executionId).digest('hex').slice(0, 16);
        const root = join(sandboxBase, `${String(ordinal).padStart(3, '0')}-${slug}`);
        const paths = sandboxPaths(root);
        plans.push({
          ordinal,
          executionId,
          manifestSha256: stage.manifestSha256,
          candidate,
          cell,
          repetitionId: repetitionId as 'r1',
          paths,
          env: sandboxEnv(paths),
        });
        ordinal += 1;
      }
    }
  }
  validateD4SmokeExecutionPlan(plans, sandboxBase);
  return plans;
}

export function validateD4SmokeExecutionPlan(
  plans: readonly D4SmokeExecutionPlan[],
  sandboxBaseInput: string,
): void {
  const sandboxBase = resolve(sandboxBaseInput);
  if (plans.length !== D4_SMOKE_EXECUTION_COUNT) {
    throw new D4SmokePlanError('coverage_invalid', `expected 108 executions, received ${plans.length}`);
  }
  const expectedCoverage = new Set(D4_SMOKE_CANDIDATES.flatMap((candidate) =>
    expectedD4SmokeCellIds().map((cellId) => `${candidate.modelId}|${cellId}|r1`)));
  const seenCoverage = new Set<string>();
  const seenExecutionIds = new Set<string>();
  const writableRoots = new Set<string>();
  for (const [index, plan] of plans.entries()) {
    const frozenCandidate = D4_SMOKE_CANDIDATES.find((candidate) => candidate.modelId === plan.candidate.modelId);
    if (frozenCandidate === undefined || JSON.stringify(frozenCandidate) !== JSON.stringify(plan.candidate)) {
      throw new D4SmokePlanError('model_binding_invalid', `${plan.executionId}: candidate is not exact frozen G2`);
    }
    if (!D4_SMOKE_REPETITIONS.includes(plan.repetitionId)) {
      throw new D4SmokePlanError('coverage_invalid', `${plan.executionId}: invalid repetition`);
    }
    const coverageKey = `${plan.candidate.modelId}|${plan.cell.id}|${plan.repetitionId}`;
    if (seenCoverage.has(coverageKey)) {
      throw new D4SmokePlanError('coverage_invalid', `duplicate coverage ${coverageKey}`);
    }
    if (!expectedCoverage.has(coverageKey)) {
      throw new D4SmokePlanError('coverage_invalid', `unexpected coverage ${coverageKey}`);
    }
    seenCoverage.add(coverageKey);
    const expectedExecutionId = `${plan.candidate.provider}:${plan.candidate.modelId}:${plan.cell.id}:${plan.repetitionId}`;
    if (plan.executionId !== expectedExecutionId || seenExecutionIds.has(plan.executionId)) {
      throw new D4SmokePlanError('coverage_invalid', `invalid or duplicate execution id ${plan.executionId}`);
    }
    seenExecutionIds.add(plan.executionId);

    const expectedRoot = join(sandboxBase, `${String(index).padStart(3, '0')}-${createHash('sha256')
      .update(plan.executionId).digest('hex').slice(0, 16)}`);
    if (plan.ordinal !== index || resolve(plan.paths.root) !== expectedRoot) {
      throw new D4SmokePlanError('shared_writable_root', `${plan.executionId}: non-canonical execution root`);
    }
    const expectedPaths = sandboxPaths(expectedRoot);
    if (JSON.stringify(expectedPaths) !== JSON.stringify(plan.paths)) {
      throw new D4SmokePlanError('shared_writable_root', `${plan.executionId}: sandbox path drift`);
    }
    for (const path of writablePaths(plan.paths)) {
      if (!isAbsolute(path) || !isStrictDescendant(expectedRoot, path)) {
        throw new D4SmokePlanError('shared_writable_root', `${plan.executionId}: ${path} escapes its root`);
      }
      const canonicalPath = resolve(path);
      if (writableRoots.has(canonicalPath)) {
        throw new D4SmokePlanError('shared_writable_root', `${plan.executionId}: shared ${canonicalPath}`);
      }
      writableRoots.add(canonicalPath);
    }
    if (JSON.stringify(plan.env) !== JSON.stringify(sandboxEnv(expectedPaths))) {
      throw new D4SmokePlanError('shared_writable_root', `${plan.executionId}: sandbox environment drift`);
    }
  }
  if (seenCoverage.size !== D4_SMOKE_EXECUTION_COUNT
    || [...expectedCoverage].some((coverage) => !seenCoverage.has(coverage))) {
    throw new D4SmokePlanError('coverage_invalid', `expected 108 unique coverage keys, got ${seenCoverage.size}`);
  }
}

export interface D4SmokeDryRunResult {
  readonly manifestSha256: string;
  readonly executionCount: typeof D4_SMOKE_EXECUTION_COUNT;
  readonly plans: readonly D4SmokeExecutionPlan[];
  readonly quota: D4SmokeQuotaEvidence;
}

/** Pure planning surface. It accepts already-read evidence and has no driver,
 * provider, credential, or callback dependency, so a dry run cannot make a
 * model/provider call by construction. */
export async function dryRunD4Smoke(input: {
  readonly manifestBytes: string | Uint8Array;
  readonly receipt: unknown;
  readonly repoRoot: string;
  readonly gitVerifier?: D4SmokeGitVerifier;
  readonly contentByRef: Readonly<Record<string, string | Uint8Array>>;
  readonly sandboxBase: string;
  readonly quotaEvidence: unknown;
  readonly now: Date;
}): Promise<D4SmokeDryRunResult> {
  const stage = await validateD4SmokeStage(input);
  const plans = planD4SmokeExecutions(stage, input.sandboxBase);
  const quota = validateD4SmokeQuotaEvidence({
    evidence: input.quotaEvidence,
    manifestSha256: stage.manifestSha256,
    phase: { kind: 'layer_admission' },
    now: input.now,
  });
  return {
    manifestSha256: stage.manifestSha256,
    executionCount: D4_SMOKE_EXECUTION_COUNT,
    plans,
    quota,
  };
}

export interface D4SmokeCapabilityAttempt {
  readonly sequence: number;
  readonly capability: D4SmokeForbiddenCapability;
  readonly at: string;
  readonly detail: string | null;
}

/** In-process view of the isolated command-shim ledger at the actual account,
 * UTA, Execution Record, stage, and push names. A shim appends before exiting
 * 126, so rejected calls remain attempts rather than disappearing as success. */
export class D4SmokeCapabilityAuditLedger {
  private readonly attempts: D4SmokeCapabilityAttempt[] = [];

  ingestAttempt(capability: D4SmokeForbiddenCapability, at: string, detail: string | null): void {
    this.attempts.push({
      sequence: this.attempts.length + 1,
      capability,
      at,
      detail,
    });
  }

  snapshot(): readonly D4SmokeCapabilityAttempt[] {
    return this.attempts.map((attempt) => ({ ...attempt }));
  }

  assertZero(): void {
    if (this.attempts.length !== 0) {
      throw new D4SmokePolicyError(
        'forbidden_capability_attempted',
        this.attempts.map((attempt) => attempt.capability).join(','),
      );
    }
  }
}

export interface D4SmokeForbiddenCapabilityBoundaries {
  readonly account: {
    readonly create: (detail?: string) => never;
    readonly edit: (detail?: string) => never;
    readonly elevate: (detail?: string) => never;
  };
  readonly uta: { readonly mutate: (detail?: string) => never };
  readonly executionRecord: { readonly publish: (detail?: string) => never };
  readonly stage: { readonly proposal: (detail?: string) => never };
  readonly autoPush: { readonly execute: (detail?: string) => never };
}

export function createD4SmokeForbiddenCapabilityBoundaries(
  ledger: D4SmokeCapabilityAuditLedger,
  now: () => Date = () => new Date(),
): D4SmokeForbiddenCapabilityBoundaries {
  const deny = (capability: D4SmokeForbiddenCapability) => (detail?: string): never => {
    ledger.ingestAttempt(capability, now().toISOString(), detail?.trim() || null);
    throw new D4SmokePolicyError('forbidden_capability_attempted', capability);
  };
  return Object.freeze({
    account: Object.freeze({
      create: deny('account_create'),
      edit: deny('account_edit'),
      elevate: deny('account_elevate'),
    }),
    uta: Object.freeze({ mutate: deny('uta_mutation') }),
    executionRecord: Object.freeze({ publish: deny('execution_record_publish') }),
    stage: Object.freeze({ proposal: deny('stage') }),
    autoPush: Object.freeze({ execute: deny('auto_push') }),
  });
}

export class D4SmokePolicyError extends Error {
  constructor(
    readonly code:
      | 'forbidden_capability_attempted'
      | 'proposal_boundary_invalid'
      | 'model_binding_invalid'
      | 'credential_source_invalid'
      | 'credential_source_changed'
      | 'sandbox_not_fresh'
      | 'production_seam_forbidden'
      | 'terminal_artifact_invalid',
    detail: string,
    options?: { cause?: unknown },
  ) {
    super(`D4 Smoke policy ${code}: ${detail}`, options);
    this.name = 'D4SmokePolicyError';
  }
}

export interface D4SmokeCredentialSource {
  readonly provider: 'codex' | 'claude';
  readonly sourceIdentity: string;
  readonly sourcePath: string;
}

export interface D4SmokeCanonicalCredentialPaths {
  readonly codex: string;
  readonly claude: string;
}

export interface D4SmokeCredentialReceipt {
  readonly provider: 'codex' | 'claude';
  readonly sourceIdentity: string;
  readonly sourcePathSha256: string;
  readonly sourceSha256: string;
  readonly byteLength: number;
  readonly targetRelativePath: 'auth.json' | '.credentials.json';
  readonly unchangedAfterExecution: true;
}

export interface D4SmokeDriverBinding {
  readonly provider: 'codex' | 'claude';
  readonly runtime: 'Codex CLI' | 'Claude Code';
  readonly runtimeVersion: string;
  readonly modelId: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly filesystemSandbox: 'workspace-write';
  readonly networkAccess: false;
  /** Host credential paths are deny-only inputs for the provider sandbox and
   * are never surfaced in the candidate prompt. */
  readonly hostCredentialDenyPaths: readonly string[];
  /** Exact critic-approved instruction bytes, decoded only after the manifest
   * hash is verified. D4 passes them directly because filesystem settings are
   * disabled for containment. */
  readonly approvedInstruction: string;
  readonly toolPolicy: {
    readonly account: 'not_exposed';
    readonly uta: 'not_exposed';
    readonly executionRecord: 'not_exposed';
    readonly stage: 'not_exposed';
    readonly autoPush: 'not_exposed';
  };
}

export interface D4SmokeBoundDriver {
  readonly driver: StewardMachineDriver;
  readonly resolvedModelId: string;
  readonly runtimeVersion: string;
}

export type D4SmokeDriverFactory = (binding: D4SmokeDriverBinding) => Promise<D4SmokeBoundDriver>;

export interface D4SmokeNativeDriverFactoryOptions {
  readonly claudeBin?: string;
  readonly versionProbe?: (input: {
    readonly provider: 'codex' | 'claude';
    readonly binary: string;
    readonly env: Readonly<Record<string, string>>;
  }) => Promise<string>;
  /** Constructor seams keep tests from starting a native CLI. */
  readonly makeCodexDriver?: (options: CodexAppServerDriverOptions) => StewardMachineDriver;
  readonly makeClaudeDriver?: (options: ClaudeAgentSdkDriverOptions) => StewardMachineDriver;
}

/** Production-capable factory with strict runtime-version and policy checks.
 * Constructing it or a driver makes no model call; the first model call remains
 * the runner's post-manifest/post-receipt `runTurn`. */
export function createD4SmokeNativeDriverFactory(
  options: D4SmokeNativeDriverFactoryOptions = {},
): D4SmokeDriverFactory {
  const versionProbe = options.versionProbe ?? probeNativeCliVersion;
  const makeCodexDriver = options.makeCodexDriver
    ?? ((driverOptions: CodexAppServerDriverOptions) => new CodexAppServerDriver(driverOptions));
  const makeClaudeDriver = options.makeClaudeDriver
    ?? ((driverOptions: ClaudeAgentSdkDriverOptions) => new ClaudeAgentSdkDriver(driverOptions));
  return async (binding) => {
    assertNativeBindingPolicy(binding);
    const binary = binding.provider === 'codex'
      ? resolve(binding.cwd, '..', 'runtime', 'codex-launch.mjs')
      : options.claudeBin ?? 'claude';
    const runtimeVersion = await versionProbe({
      provider: binding.provider,
      binary,
      env: binding.env,
    });
    if (runtimeVersion !== binding.runtimeVersion) {
      throw new D4SmokePolicyError(
        'model_binding_invalid',
        `${binding.runtime} must be ${binding.runtimeVersion}, found ${runtimeVersion}`,
      );
    }

    let driver: StewardMachineDriver;
    if (binding.provider === 'codex') {
      driver = makeCodexDriver({
        cwd: binding.cwd,
        env: { ...binding.env },
        envInheritance: 'replace',
        codexBin: binary,
      });
    } else {
      driver = makeClaudeDriver({
        cwd: binding.cwd,
        env: { ...binding.env },
        permissionMode: 'dontAsk',
        settings: D4_SMOKE_CLAUDE_SETTINGS,
        pathToClaudeCodeExecutable: binary,
        settingSources: [],
        strictMcpConfig: true,
        tools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
        skills: [],
        canUseTool: createD4ClaudeToolGuard(binding),
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: binding.approvedInstruction,
        },
        sandbox: {
          enabled: true,
          failIfUnavailable: true,
          autoAllowBashIfSandboxed: true,
          allowUnsandboxedCommands: false,
          network: {
            allowedDomains: [],
            deniedDomains: ['*'],
            allowUnixSockets: [],
            allowAllUnixSockets: false,
            allowLocalBinding: false,
            allowMachLookup: [],
          },
          filesystem: {
            // Claude's sandbox grants the cwd by default. This explicit path
            // is the only additional write root D4 contributes.
            allowWrite: [binding.cwd],
          },
          credentials: {
            files: [...new Set([
              ...binding.hostCredentialDenyPaths,
              join(binding.env.CLAUDE_CONFIG_DIR ?? binding.cwd, '.credentials.json'),
            ])].map((path) => ({ path, mode: 'deny' as const })),
          },
          enableWeakerNestedSandbox: false,
          enableWeakerNetworkIsolation: false,
          allowAppleEvents: false,
        },
      });
    }
    return {
      driver,
      resolvedModelId: binding.modelId,
      runtimeVersion,
    };
  };
}

function createD4ClaudeToolGuard(binding: D4SmokeDriverBinding): NonNullable<ClaudeAgentSdkDriverOptions['canUseTool']> {
  return async (toolName, input) => {
    if (toolName === 'Write' || toolName === 'Edit') {
      const rawPath = input['file_path'];
      if (typeof rawPath === 'string' && await isD4WorkspacePath(binding.cwd, rawPath)) {
        return { behavior: 'allow', updatedInput: input };
      }
      return { behavior: 'deny', message: `${toolName} is restricted to the D4 workspace` };
    }
    if (toolName === 'Read' || toolName === 'Glob' || toolName === 'Grep') {
      const rawPath = input['file_path'] ?? input['path'] ?? '.';
      if (typeof rawPath === 'string' && await isD4WorkspacePath(binding.cwd, rawPath)) {
        return { behavior: 'allow', updatedInput: input };
      }
      return { behavior: 'deny', message: `${toolName} is restricted to the D4 workspace` };
    }
    if (toolName === 'Bash') {
      const command = input['command'];
      const parsed = typeof command === 'string' ? parseD4ShimShellCommand(command) : null;
      if (parsed !== null && classifyD4SmokeShimAttempt(parsed.command, parsed.args) !== null) {
        await recordD4ClaudeGuardAttempt(binding, parsed);
        return { behavior: 'deny', message: 'Bash command attempted a forbidden D4 capability' };
      }
      if (typeof command === 'string' && isD4AllowedBashCommand(command)) {
        return { behavior: 'allow', updatedInput: input };
      }
      return { behavior: 'deny', message: 'Bash command is outside the D4 command policy' };
    }
    return { behavior: 'deny', message: `${toolName} is not pre-approved by the D4 policy` };
  };
}

function isD4AllowedBashCommand(command: string): boolean {
  const normalized = command.trim();
  if (/^node \.\.\/runtime\/validate-ledger\.mjs [A-Za-z0-9:._%+-]+$/.test(normalized)) return true;
  const parsed = parseD4ShimShellCommand(normalized);
  return parsed !== null && !normalized.startsWith('/usr/bin/');
}

interface D4SmokeParsedShimCommand {
  readonly command: 'alice' | 'alice-uta' | 'traderhub' | 'git';
  readonly args: readonly string[];
}

function parseD4ShimShellCommand(command: string): D4SmokeParsedShimCommand | null {
  const normalized = command.trim();
  if (!/^[A-Za-z0-9_./:=@%+,-]+(?: [A-Za-z0-9_./:=@%+,-]+)*$/.test(normalized)) return null;
  const [rawCommand, ...args] = normalized.split(' ');
  const shimCommand = rawCommand === '/usr/bin/git' ? 'git' : rawCommand;
  if (!['alice', 'alice-uta', 'traderhub', 'git'].includes(shimCommand)) return null;
  return {
    command: shimCommand as D4SmokeParsedShimCommand['command'],
    args,
  };
}

async function recordD4ClaudeGuardAttempt(
  binding: D4SmokeDriverBinding,
  parsed: D4SmokeParsedShimCommand,
): Promise<void> {
  const shim = resolve(binding.cwd, '..', 'runtime', 'bin', parsed.command);
  try {
    await execFileAsync(shim, [...parsed.args], {
      cwd: binding.cwd,
      env: { ...binding.env },
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });
  } catch (error) {
    const code = typeof error === 'object' && error !== null
      ? (error as { code?: string | number }).code
      : undefined;
    if (code === 126 || code === '126') return;
    throw new D4SmokePolicyError(
      'terminal_artifact_invalid',
      'Claude authorization boundary could not record a forbidden command',
      { cause: error },
    );
  }
  throw new D4SmokePolicyError(
    'terminal_artifact_invalid',
    'Claude authorization boundary unexpectedly allowed a forbidden command',
  );
}

async function isD4WorkspacePath(cwd: string, candidate: string): Promise<boolean> {
  const workspace = await realpath(cwd);
  const target = resolve(cwd, candidate);
  if (!isWithin(workspace, target)) return false;
  let existing = target;
  while (!await pathExists(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return false;
    existing = parent;
  }
  return isWithin(workspace, await realpath(existing));
}

export interface D4SmokePrepareDecisionInput {
  readonly executionId: string;
  readonly wakeId: string;
  readonly decisionIndex: number;
  readonly threadId: string;
  readonly workspaceDir: string;
  readonly accountId: typeof D4_SMOKE_SYNTHETIC_ACCOUNT_ID;
  readonly authzLevel: 'read_only';
  readonly fictionalAsOf: string;
  readonly candidateSnapshot: Readonly<Record<string, unknown>>;
  readonly forbiddenBoundaries: D4SmokeForbiddenCapabilityBoundaries;
}

export type D4SmokePrepareDecision = (
  input: D4SmokePrepareDecisionInput,
) => Promise<{
  readonly record: StewardWakeRecord;
  readonly candidateVisibleBytes: readonly (string | Uint8Array)[];
}>;

export type D4SmokeBootstrapWorkspace = (input: {
  readonly plan: D4SmokeExecutionPlan;
  readonly stage: ValidatedD4SmokeStage;
  readonly instructionBytes: Uint8Array;
  readonly runtimePolicyBytes: Uint8Array;
  readonly forbiddenBoundaries: D4SmokeForbiddenCapabilityBoundaries;
}) => Promise<void>;

export type D4SmokeReadTerminalArtifact = (input: {
  readonly executionId: string;
  readonly wakeId: string;
  readonly decisionIndex: number;
  readonly workspaceDir: string;
  readonly forbiddenBoundaries: D4SmokeForbiddenCapabilityBoundaries;
}) => Promise<{
  readonly evaluationInput: StewardWakeEvaluationInput;
  readonly provenanceStore: StewardEvaluationProvenanceStore;
  readonly cleanup?: () => Promise<void>;
}>;

export type D4SmokeQuotaReader = (
  phase: D4SmokeQuotaPhase,
  plan: D4SmokeExecutionPlan,
) => Promise<unknown>;

export interface D4SmokeWorkspaceAdapter {
  readonly bootstrapWorkspace: D4SmokeBootstrapWorkspace;
  readonly prepareDecision: D4SmokePrepareDecision;
  readonly readTerminalArtifact: D4SmokeReadTerminalArtifact;
}

interface D4SmokePreparedFilesystemDecision {
  readonly input: D4SmokePrepareDecisionInput;
  readonly record: StewardWakeRecord;
  readonly snapshot: StewardInformationSnapshot;
}

function combineD4SmokeInstructionBytes(
  instructionBytes: Uint8Array,
  runtimePolicyBytes: Uint8Array,
): Buffer {
  return Buffer.concat([
    Buffer.from(instructionBytes),
    Buffer.from('\n\n', 'utf8'),
    Buffer.from(runtimePolicyBytes),
  ]);
}

/** Concrete proposal-only workspace adapter. It deliberately bypasses generic
 * context injection because that path installs the normal `alice*` skills and
 * may compose a live persona. D4 writes only the approved instruction bytes,
 * no MCP config, and no mutation-capable skill. */
export function createD4SmokeFilesystemWorkspaceAdapter(options: {
  readonly terminalWaitMs?: number;
} = {}): D4SmokeWorkspaceAdapter {
  const terminalWaitMs = options.terminalWaitMs ?? 5_000;
  let bound: { readonly plan: D4SmokeExecutionPlan; readonly stage: ValidatedD4SmokeStage } | null = null;
  const prepared = new Map<string, D4SmokePreparedFilesystemDecision>();

  const bootstrapWorkspace: D4SmokeBootstrapWorkspace = async ({
    plan,
    stage,
    instructionBytes,
    runtimePolicyBytes,
  }) => {
    if (bound !== null) throw new D4SmokePolicyError('sandbox_not_fresh', 'workspace adapter already bound');
    try {
      await execFileAsync(process.execPath, [D4_STEWARD_BOOTSTRAP, 'd4-smoke', plan.paths.workspace], {
        env: {
          ...process.env,
          ...plan.env,
          ELECTRON_RUN_AS_NODE: '1',
          AQ_TEMPLATE_ROOT: D4_STEWARD_TEMPLATE_ROOT,
          AQ_TEMPLATE_FILES_DIR: join(D4_STEWARD_TEMPLATE_ROOT, 'files'),
          AQ_LAUNCHER_REPO_ROOT: D4_REPO_ROOT,
        },
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
    } catch (error) {
      throw new D4SmokePolicyError(
        'sandbox_not_fresh',
        `steward bootstrap failed: ${error instanceof Error ? error.message.slice(-500) : String(error)}`,
        { cause: error },
      );
    }
    const instructionHash = createHash('sha256').update(instructionBytes).digest('hex');
    if (instructionHash !== stage.manifest.content.baseline.instruction.sha256) {
      throw new D4SmokePolicyError('proposal_boundary_invalid', 'approved instruction bytes changed before bootstrap');
    }
    const runtimePolicyHash = createHash('sha256').update(runtimePolicyBytes).digest('hex');
    if (runtimePolicyHash !== stage.manifest.content.baseline.runtimePolicy.sha256) {
      throw new D4SmokePolicyError('proposal_boundary_invalid', 'approved runtime policy changed before bootstrap');
    }
    const approvedInstructionBytes = combineD4SmokeInstructionBytes(instructionBytes, runtimePolicyBytes);
    const approvedInstructionHash = createHash('sha256').update(approvedInstructionBytes).digest('hex');
    await writeFile(
      join(plan.paths.workspace, 'AGENTS.md'),
      approvedInstructionBytes,
      { mode: 0o600, flag: 'wx' },
    );
    await writeFile(
      join(plan.paths.workspace, 'CLAUDE.md'),
      approvedInstructionBytes,
      { mode: 0o600, flag: 'wx' },
    );
    const config = {
      version: 1,
      agent: 'steward',
      sessionId: null,
      controlFace: 'machine',
      accountId: D4_SMOKE_SYNTHETIC_ACCOUNT_ID,
      authzLevel: 'read_only',
      proposalOnly: true,
      configuredUta: false,
    };
    await writeFile(
      join(plan.paths.workspace, '.alice', 'steward', 'config.json'),
      `${JSON.stringify(config, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    const wrapperBytes = await readFile(join(plan.paths.workspace, '.alice', 'steward', 'README.md'));
    const contextManifest = {
      version: 1,
      template: { name: 'steward', version: 'd4-smoke-v1' },
      coreAgent: { id: 'steward', model: 'runtime-bound' },
      wrapperPrompt: {
        path: '.alice/steward/README.md',
        sha256: createHash('sha256').update(wrapperBytes).digest('hex'),
      },
      instructions: ['AGENTS.md', 'CLAUDE.md'].map((path) => ({ path, sha256: approvedInstructionHash })),
      skills: [],
      schemas: {
        wake: 1,
        decisionLedger: 3,
        decisionLedgerArtifact: {
          path: '.alice/steward/schemas/decision-ledger.v3.json',
          sha256: createHash('sha256').update(
            await readFile(join(plan.paths.workspace, '.alice', 'steward', 'schemas', 'decision-ledger.v3.json')),
          ).digest('hex'),
        },
      },
      d4: {
        manifestSha256: stage.manifestSha256,
        behaviorVersion: stage.manifest.content.baseline.behaviorVersion,
        proposalOnly: true,
      },
    };
    await writeFile(
      join(plan.paths.workspace, '.alice', 'steward', 'context-manifest.json'),
      `${JSON.stringify(contextManifest, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600, flag: 'wx' },
    );
    for (const forbiddenPath of ['.mcp.json', '.agents/skills/alice-uta', '.claude/skills/alice-uta']) {
      if (await pathExists(join(plan.paths.workspace, forbiddenPath))) {
        throw new D4SmokePolicyError('proposal_boundary_invalid', `forbidden candidate surface: ${forbiddenPath}`);
      }
    }
    bound = { plan, stage };
  };

  const prepareDecision: D4SmokePrepareDecision = async (input) => {
    if (bound === null || input.workspaceDir !== bound.plan.paths.workspace) {
      throw new D4SmokePolicyError('proposal_boundary_invalid', 'filesystem adapter is not bound to this execution');
    }
    const published = await publishStewardInformationSnapshot(input.workspaceDir, {
      wakeId: input.wakeId,
      asOf: input.fictionalAsOf,
      envelope: {
        reason: 'scheduled_observe',
        accountId: input.accountId,
        authzLevel: input.authzLevel,
        expectedDecision: 'no_trade',
        wakePurpose: D4_SMOKE_WAKE_PURPOSE,
        executionMode: 'proposal_only',
        configuredUta: false,
        marketContext: input.candidateSnapshot,
        riskContext: {
          proposalOnly: true,
          configuredUta: false,
          accountIdentity: 'synthetic-evaluation',
        },
      },
    });
    const wakeStore = createStewardWakeStore(input.workspaceDir);
    const timeline = fictionalD4SmokeTimeline(input.decisionIndex);
    if (timeline.asOf !== input.fictionalAsOf) {
      throw new D4SmokePolicyError('proposal_boundary_invalid', `${input.wakeId}: fictional clock drift`);
    }
    await wakeStore.create({
      wakeId: input.wakeId,
      deadline: timeline.deadline,
      envelope: published.envelope,
      now: timeline.createdAt,
      sessionId: input.threadId,
      controlFace: 'machine',
    });
    const record = await wakeStore.updateStatus(input.wakeId, 'injected', {
      now: timeline.injectedAt,
      injectedAt: timeline.injectedAt,
      sessionId: input.threadId,
    });
    prepared.set(input.wakeId, {
      input,
      record,
      snapshot: published.snapshot,
    });
    const wakeBytes = await readFile(
      join(input.workspaceDir, '.alice', 'steward', 'wakes', `${encodeURIComponent(input.wakeId)}.json`),
    );
    const snapshotBytes = await readFile(join(input.workspaceDir, published.binding.path));
    return { record, candidateVisibleBytes: [wakeBytes, snapshotBytes] };
  };

  const readTerminalArtifact: D4SmokeReadTerminalArtifact = async (input) => {
    if (bound === null || input.workspaceDir !== bound.plan.paths.workspace) {
      throw new D4SmokePolicyError('terminal_artifact_invalid', 'filesystem adapter binding mismatch');
    }
    const state = prepared.get(input.wakeId);
    if (state === undefined) {
      throw new D4SmokePolicyError('terminal_artifact_invalid', `${input.wakeId}: wake was not prepared`);
    }
    const { entry, marker } = await waitForD4LedgerFinalization(
      input.workspaceDir,
      input.wakeId,
      terminalWaitMs,
    );
    const contractErrors = [
      ...validateStewardSnapshotTemporalIntegrity(state.snapshot),
      ...(entry.version === 3
        ? validateStewardDecisionSnapshotBinding(entry, state.snapshot)
        : ['decision_version_not_v3']),
      ...(entry.version === 3
        ? validateStewardThesisDispositionCoverage(entry, state.snapshot)
        : []),
      ...(entry.version === 3 && entry.actions.length === 0 && entry.pendingHash === null
        ? []
        : ['proposal_only_ledger_shape_invalid']),
    ];
    const cellData = bound.stage.contentByCellId.get(bound.plan.cell.id)!;
    const template = cellData.decisionManifests[input.decisionIndex]!;
    const dataManifest = materializeD4SmokeEvaluationManifest(
      template,
      input.decisionIndex,
      input.wakeId,
    );
    const provenanceRoot = join(bound.plan.paths.root, 'orchestrator-provenance');
    const provenanceWorkspace = join(
      provenanceRoot,
      createHash('sha256').update(input.wakeId).digest('hex'),
    );
    const provenanceStore = createStewardEvaluationProvenanceStore(provenanceWorkspace);
    try {
      const uniqueIdentities = new Map(
        stewardEvaluationManifestContentIdentities(dataManifest)
          .map((identity) => [identity.ref, identity] as const),
      );
      for (const identity of uniqueIdentities.values()) {
        const content = cellData.contentByRef[identity.ref];
        if (content === undefined) {
          throw new D4SmokePolicyError(
            'terminal_artifact_invalid',
            `${input.wakeId}: frozen D3 content missing ${identity.ref}`,
          );
        }
        const published = await provenanceStore.publishContent(identity.ref, content);
        if (published.sha256 !== identity.sha256) {
          throw new D4SmokePolicyError(
            'terminal_artifact_invalid',
            `${input.wakeId}: frozen D3 identity changed for ${identity.ref}`,
          );
        }
      }
      await provenanceStore.publishManifest(
        input.wakeId,
        `${JSON.stringify(dataManifest, null, 2)}\n`,
      );
    } catch (error) {
      await rm(provenanceRoot, { recursive: true, force: true });
      throw error;
    }
    const lockIntegrity = !await pathExists(
      join(input.workspaceDir, '.alice', 'steward', 'ledger', 'decisions.jsonl.lock'),
    );
    return {
      provenanceStore,
      cleanup: async () => {
        await rm(provenanceRoot, { recursive: true, force: true });
      },
      evaluationInput: {
        schema: 'steward-wake-evaluation-input/1',
        version: 1,
        wakeId: input.wakeId,
        protocol: {
          wakeDelivered: state.record.injectedAt !== null,
          ledgerValidated: true,
          finalizeMatched: marker.fingerprint === canonicalDecisionFingerprint(entry),
          lockIntegrity,
          recoveryIntegrity: 'not_required',
        },
        decision: {
          contractValid: contractErrors.length === 0,
          qualityChecks: [{
            id: 'decision_snapshot_contract',
            passed: contractErrors.length === 0,
            detail: contractErrors.length === 0 ? 'v3 Decision Intent and Snapshot M1 bindings valid' : contractErrors.join(','),
          }],
        },
        execution: {
          requested: false,
          riskEnvelopeValid: true,
          fidelityChecks: [],
          containment: [],
        },
        dataManifest,
      },
    };
  };

  return { bootstrapWorkspace, prepareDecision, readTerminalArtifact };
}

export interface D4SmokeExecutionResult {
  readonly executionId: string;
  readonly status: 'valid' | 'invalid';
  readonly reports: readonly StewardWakeEvaluationReport[];
  readonly quotaEvidence: {
    readonly layerAdmission: D4SmokeQuotaEvidence;
    readonly dispatches: readonly D4SmokeQuotaEvidence[];
  };
  readonly credential: D4SmokeCredentialReceipt;
  readonly capabilityAttempts: readonly D4SmokeCapabilityAttempt[];
}

export interface D4SmokeExecutionInput {
  readonly manifestBytes: string | Uint8Array;
  readonly receipt: D4SmokeCriticReceipt | unknown;
  readonly repoRoot: string;
  readonly gitVerifier?: D4SmokeGitVerifier;
  readonly contentByRef: Readonly<Record<string, string | Uint8Array>>;
  readonly sandboxBase: string;
  readonly executionId: string;
  readonly credentialSources: readonly D4SmokeCredentialSource[];
  readonly canonicalCredentialPaths?: D4SmokeCanonicalCredentialPaths;
  readonly quotaReader: D4SmokeQuotaReader;
  readonly driverFactory: D4SmokeDriverFactory;
  /** Production pins this before any OAuth copy; direct test harnesses may
   * omit it and resolve the frozen runtime during audit installation. */
  readonly codexRuntime?: D4SmokeCodexNativeRuntime;
  readonly bootstrapWorkspace?: D4SmokeBootstrapWorkspace;
  readonly prepareDecision: D4SmokePrepareDecision;
  readonly readTerminalArtifact: D4SmokeReadTerminalArtifact;
  readonly auditLedger: D4SmokeCapabilityAuditLedger;
  readonly now?: () => Date;
  readonly deadlineMs?: number;
}

export interface D4SmokeFilesystemExecutionInput {
  readonly manifestBytes: string | Uint8Array;
  readonly receipt: D4SmokeCriticReceipt | unknown;
  readonly contentByRef: Readonly<Record<string, string | Uint8Array>>;
  readonly sandboxBase: string;
  readonly executionId: string;
  readonly deadlineMs?: number;
  readonly filesystemAdapterOptions?: {
    readonly terminalWaitMs?: number;
  };
}

const D4_SMOKE_PRODUCTION_SEAMS = [
  'repoRoot',
  'gitVerifier',
  'credentialSources',
  'canonicalCredentialPaths',
  'quotaReader',
  'codexControl',
  'claudeControl',
  'forecastBounds',
  'driverFactory',
  'codexRuntime',
  'bootstrapWorkspace',
  'prepareDecision',
  'readTerminalArtifact',
  'auditLedger',
  'now',
] as const;

function frozenD4SmokeCodexRuntimeVersion(): string {
  const versions = new Set(
    D4_SMOKE_CANDIDATES
      .filter((candidate) => candidate.provider === 'codex')
      .map((candidate) => candidate.runtimeVersion),
  );
  if (versions.size !== 1) {
    throw new D4SmokePolicyError(
      'model_binding_invalid',
      `D4 Codex matrix must freeze one runtime version, found ${[...versions].join(',')}`,
    );
  }
  return [...versions][0]!;
}

/** Watchdog-facing, single-execution production entrypoint. */
export async function runD4SmokeFilesystemExecution(
  input: D4SmokeFilesystemExecutionInput,
): Promise<D4SmokeExecutionResult> {
  const rawInput = input as unknown as Record<string, unknown>;
  const forbidden = D4_SMOKE_PRODUCTION_SEAMS.filter((key) =>
    Object.prototype.hasOwnProperty.call(rawInput, key));
  if (forbidden.length > 0) {
    throw new D4SmokePolicyError(
      'production_seam_forbidden',
      `watchdog entrypoint does not accept ${forbidden.join(',')}`,
    );
  }
  const stage = await validateD4SmokeStage({
    manifestBytes: input.manifestBytes,
    receipt: input.receipt,
    repoRoot: D4_REPO_ROOT,
    contentByRef: input.contentByRef,
  });
  const plan = planD4SmokeExecutions(stage, input.sandboxBase).find(
    (candidate) => candidate.executionId === input.executionId,
  );
  if (plan === undefined) {
    throw new D4SmokePlanError('coverage_invalid', `unknown execution ${input.executionId}`);
  }
  const forecastBounds = deriveD4SmokeQuotaForecastBounds({ stage, contentByRef: input.contentByRef });
  const canonical = defaultD4SmokeCanonicalCredentialPaths();
  const preflightQuota = await captureD4SmokeIsolatedPreflightQuota({
    canonical,
    expectedCodexRuntimeVersion: frozenD4SmokeCodexRuntimeVersion(),
  });
  if (preflightQuota.codexRuntime === null) {
    throw new D4SmokePolicyError('model_binding_invalid', 'production preflight did not pin Codex');
  }
  const adapter = createD4SmokeFilesystemWorkspaceAdapter(input.filesystemAdapterOptions);
  return runD4SmokeExecution({
    manifestBytes: input.manifestBytes,
    receipt: input.receipt,
    repoRoot: D4_REPO_ROOT,
    contentByRef: input.contentByRef,
    sandboxBase: input.sandboxBase,
    executionId: input.executionId,
    credentialSources: D4_SMOKE_CREDENTIAL_SOURCES.map((source) => ({
      ...source,
      sourcePath: canonical[source.provider],
    })),
    canonicalCredentialPaths: canonical,
    quotaReader: createD4SmokeNativeExecutionQuotaReader(preflightQuota, forecastBounds),
    driverFactory: createD4SmokeNativeDriverFactory(),
    codexRuntime: preflightQuota.codexRuntime,
    bootstrapWorkspace: adapter.bootstrapWorkspace,
    prepareDecision: adapter.prepareDecision,
    readTerminalArtifact: adapter.readTerminalArtifact,
    auditLedger: new D4SmokeCapabilityAuditLedger(),
    deadlineMs: input.deadlineMs,
  });
}

export async function runD4SmokeExecution(input: D4SmokeExecutionInput): Promise<D4SmokeExecutionResult> {
  const now = input.now ?? (() => new Date());
  const stage = await validateD4SmokeStage(input);
  const plans = planD4SmokeExecutions(stage, input.sandboxBase);
  const plan = plans.find((candidate) => candidate.executionId === input.executionId);
  if (plan === undefined) {
    throw new D4SmokePlanError('coverage_invalid', `unknown execution ${input.executionId}`);
  }
  input.auditLedger.assertZero();
  const forbiddenBoundaries = createD4SmokeForbiddenCapabilityBoundaries(input.auditLedger, now);
  const admissionPhase = { kind: 'layer_admission' } as const;
  const admissionQuota = validateD4SmokeQuotaEvidence({
    evidence: await input.quotaReader(admissionPhase, plan),
    manifestSha256: stage.manifestSha256,
    phase: admissionPhase,
    now: now(),
  });

  await createFreshSandbox(plan.paths);
  let auditCursor: D4SmokeAuditCursor | null = null;
  const source = selectCredentialSource(plan.candidate.provider, input.credentialSources);
  const canonicalPaths = input.canonicalCredentialPaths ?? defaultD4SmokeCanonicalCredentialPaths();
  const credential = await copyCredentialIntoSandbox(
    plan,
    source,
    canonicalPaths,
  );

  let driver: StewardMachineDriver | null = null;
  const reports: StewardWakeEvaluationReport[] = [];
  const dispatchQuotaEvidence: D4SmokeQuotaEvidence[] = [];
  let executionError: unknown;
  try {
    const instructionValue = input.contentByRef[stage.manifest.content.baseline.instruction.ref]!;
    const instructionBytes = typeof instructionValue === 'string'
      ? Buffer.from(instructionValue, 'utf8')
      : Buffer.from(instructionValue);
    const runtimePolicyValue = input.contentByRef[stage.manifest.content.baseline.runtimePolicy.ref]!;
    const runtimePolicyBytes = typeof runtimePolicyValue === 'string'
      ? Buffer.from(runtimePolicyValue, 'utf8')
      : Buffer.from(runtimePolicyValue);
    const approvedInstructionBytes = combineD4SmokeInstructionBytes(
      instructionBytes,
      runtimePolicyBytes,
    );
    const bootstrapWorkspace = input.bootstrapWorkspace
      ?? createD4SmokeFilesystemWorkspaceAdapter().bootstrapWorkspace;
    await bootstrapWorkspace({
      plan,
      stage,
      instructionBytes,
      runtimePolicyBytes,
      forbiddenBoundaries,
    });
    auditCursor = await installD4SmokeAuditShims(
      plan.paths,
      plan.candidate,
      input.codexRuntime,
    );
    if (plan.candidate.provider === 'codex') {
      await verifyD4CodexOuterIsolation(plan, canonicalPaths.claude);
    }
    const binding = buildExactModelBinding(plan, approvedInstructionBytes, canonicalPaths);
    input.auditLedger.assertZero();
    const bound = await input.driverFactory(binding);
    if (bound.resolvedModelId !== plan.candidate.modelId || bound.runtimeVersion !== plan.candidate.runtimeVersion) {
      throw new D4SmokePolicyError(
        'model_binding_invalid',
        `requested ${plan.candidate.modelId}@${plan.candidate.runtimeVersion}, resolved ${bound.resolvedModelId}@${bound.runtimeVersion}`,
      );
    }
    driver = bound.driver;
    input.auditLedger.assertZero();
    const thread = await driver.ensureThread({
      cwd: plan.paths.workspace,
      model: plan.candidate.modelId,
      sandbox: 'workspace-write',
      networkAccess: false,
    });
    if (thread.resolvedModelId !== undefined && thread.resolvedModelId !== plan.candidate.modelId) {
      throw new D4SmokePolicyError(
        'model_binding_invalid',
        `thread reported ${thread.resolvedModelId}; frozen model is ${plan.candidate.modelId}`,
      );
    }
    const cellData = stage.contentByCellId.get(plan.cell.id)!;
    for (let decisionIndex = 0; decisionIndex < D4_SMOKE_DECISION_COUNT; decisionIndex += 1) {
      const window = d4SmokeDecisionWindow(plan.cell.profile, decisionIndex);
      const candidateSnapshot = cellData.decisionSnapshots[decisionIndex]!;
      const bars = candidateSnapshot['bars'];
      if (!Array.isArray(bars) || bars.length !== window.visibleEndExclusive) {
        throw new D4SmokePolicyError('proposal_boundary_invalid', `${plan.cell.id}: incomplete visible prefix`);
      }
      const wakeId = opaqueD4SmokeWakeId(stage.manifestSha256, plan.executionId, decisionIndex);
      const fictionalAsOf = fictionalD4SmokeAsOf(decisionIndex);
      const prepared = await input.prepareDecision({
        executionId: plan.executionId,
        wakeId,
        decisionIndex,
        threadId: thread.threadId,
        workspaceDir: plan.paths.workspace,
        accountId: D4_SMOKE_SYNTHETIC_ACCOUNT_ID,
        authzLevel: 'read_only',
        fictionalAsOf,
        candidateSnapshot,
        forbiddenBoundaries,
      });
      assertPreparedWake(prepared.record, wakeId, decisionIndex);
      const prompt = formatStewardWakeMessage(prepared.record, {
        validatorPath: '../runtime/validate-ledger.mjs',
      });
      assertD4CandidateVisibleBytes({
        plan,
        cellData,
        decisionIndex,
        values: [prompt, ...prepared.candidateVisibleBytes],
      });
      const dispatchPhase = {
        kind: 'dispatch',
        executionId: plan.executionId,
        decisionIndex,
        wakeId,
      } as const;
      dispatchQuotaEvidence.push(validateD4SmokeQuotaEvidence({
        evidence: await input.quotaReader(dispatchPhase, plan),
        manifestSha256: stage.manifestSha256,
        phase: dispatchPhase,
        provider: plan.candidate.provider,
        now: now(),
      }));
      auditCursor = await syncD4SmokeAuditLedger(
        plan.paths.auditCallLedger,
        input.auditLedger,
        auditCursor,
      );
      input.auditLedger.assertZero();
      let auditAppendFailure = false;
      const outcome = await driver.runTurn(
        thread.threadId,
        prompt,
        {
          deadlineMs: input.deadlineMs,
          model: plan.candidate.modelId,
          onEvent: (event) => {
            if (
              event.type === 'item-completed'
              && event.exitCode === 125
              && event.aggregatedOutput?.includes('D4_SMOKE_AUDIT_APPEND_FAILED')
            ) {
              auditAppendFailure = true;
            }
          },
        },
      );
      if (outcome.agentMessage?.includes('D4_SMOKE_AUDIT_APPEND_FAILED')) {
        auditAppendFailure = true;
      }
      assertD4ActualModelIds(outcome.actualModelIds, plan.candidate.modelId, wakeId);
      auditCursor = await syncD4SmokeAuditLedger(
        plan.paths.auditCallLedger,
        input.auditLedger,
        auditCursor,
      );
      if (auditAppendFailure) {
        throw new D4SmokePolicyError(
          'terminal_artifact_invalid',
          `${wakeId}: capability audit append failed inside the candidate turn`,
        );
      }
      if (outcome.interrupted || outcome.status !== 'completed') {
        throw new D4SmokePolicyError(
          'terminal_artifact_invalid',
          `${wakeId}: machine turn ${outcome.status}${outcome.interrupted ? ' (interrupted)' : ''}`,
        );
      }
      input.auditLedger.assertZero();
      const terminal = await input.readTerminalArtifact({
        executionId: plan.executionId,
        wakeId,
        decisionIndex,
        workspaceDir: plan.paths.workspace,
        forbiddenBoundaries,
      });
      let report: StewardWakeEvaluationReport;
      try {
        assertProposalOnlyEvaluationInput(terminal.evaluationInput, wakeId);
        report = await evaluateStewardWake(terminal.evaluationInput, terminal.provenanceStore);
      } finally {
        await terminal.cleanup?.();
      }
      if (report.execution.verdict !== 'not_evaluated') {
        throw new D4SmokePolicyError(
          'terminal_artifact_invalid',
          `${wakeId}: proposal-only execution layer must be not_evaluated`,
        );
      }
      reports.push(report);
      input.auditLedger.assertZero();
    }
  } catch (error) {
    executionError = error;
  } finally {
    let cleanupError: unknown;
    let candidateStopped = driver === null;
    try {
      await driver?.dispose();
      candidateStopped = true;
    } catch (error) {
      cleanupError ??= error;
    }
    try {
      if (auditCursor !== null) {
        auditCursor = await syncD4SmokeAuditLedger(
          plan.paths.auditCallLedger,
          input.auditLedger,
          auditCursor,
        );
      }
    } catch (error) {
      cleanupError ??= error;
    }
    try {
      await credential.verifyUnchanged();
    } catch (error) {
      // A changed canonical credential source is the strongest failure: do not
      // let an earlier bootstrap/driver error conceal that the source mutated.
      cleanupError = error;
      executionError = error;
    }
    try {
      input.auditLedger.assertZero();
    } catch (error) {
      cleanupError ??= error;
    }
    if (candidateStopped) {
      try {
        await releaseD4SmokeRuntimeForHost(plan.paths);
      } catch (error) {
        cleanupError ??= error;
      }
    }
    executionError ??= cleanupError;
  }
  if (executionError !== undefined) throw executionError;

  return {
    executionId: plan.executionId,
    status: reports.every((report) => report.protocol.verdict === 'pass' && report.decision.verdict === 'pass')
      ? 'valid'
      : 'invalid',
    reports,
    quotaEvidence: {
      layerAdmission: admissionQuota,
      dispatches: dispatchQuotaEvidence,
    },
    credential: credential.receipt(),
    capabilityAttempts: input.auditLedger.snapshot(),
  };
}

async function releaseD4SmokeRuntimeForHost(paths: D4SmokeSandboxPaths): Promise<void> {
  if (!await pathExists(paths.runtimeRoot)) return;
  await chmod(paths.runtimeRoot, 0o700);
  if (await pathExists(paths.auditBin)) await chmod(paths.auditBin, 0o700);
}

async function verifyD4CodexOuterIsolation(
  plan: D4SmokeExecutionPlan,
  nonSelectedCanonicalCredential: string,
): Promise<void> {
  try {
    await execFileAsync(
      plan.paths.runtimeCodexLauncher,
      [
        '--d4-isolation-canary',
        join(plan.paths.codexHome, 'auth.json'),
        resolve(nonSelectedCanonicalCredential),
      ],
      {
        cwd: plan.paths.workspace,
        env: { ...plan.env },
        timeout: 10_000,
        maxBuffer: 64 * 1024,
      },
    );
  } catch (error) {
    throw new D4SmokePolicyError(
      'model_binding_invalid',
      'Codex outer filesystem isolation canary failed',
      { cause: error },
    );
  }
}

export function assertD4ActualModelIds(
  actualModelIds: readonly string[] | undefined,
  frozenModelId: string,
  turnIdentity: string,
): void {
  const actual = new Set(
    (actualModelIds ?? [])
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter((value) => value !== ''),
  );
  if (actual.size !== 1 || !actual.has(frozenModelId)) {
    throw new D4SmokePolicyError(
      'model_binding_invalid',
      `${turnIdentity}: provider-reported model set [${[...actual].sort().join(',')}] must equal ${frozenModelId}`,
    );
  }
}

async function waitForD4LedgerFinalization(
  workspaceDir: string,
  wakeId: string,
  waitMs: number,
): Promise<{ readonly entry: StewardDecisionLedgerEntry; readonly marker: StewardFinalizeMarker }> {
  const ledger = createStewardLedgerStore(workspaceDir);
  const finalize = createStewardFinalizeStore(workspaceDir);
  const deadline = Date.now() + waitMs;
  do {
    const [entry, marker] = await Promise.all([
      ledger.findByWakeId(wakeId),
      finalize.read(wakeId),
    ]);
    if (entry !== null && marker !== null) {
      return { entry, marker };
    }
    await delay(25);
  } while (Date.now() <= deadline);
  throw new D4SmokePolicyError(
    'terminal_artifact_invalid',
    `${wakeId}: validated ledger entry/finalize marker not published within ${waitMs}ms`,
  );
}

function sandboxPaths(rootInput: string): D4SmokeSandboxPaths {
  const root = resolve(rootInput);
  return {
    root,
    workspace: join(root, 'workspace'),
    home: join(root, 'home'),
    openAliceHome: join(root, 'openalice-home'),
    launcherRoot: join(root, 'launcher'),
    globalDir: join(root, 'global'),
    codexHome: join(root, 'codex'),
    claudeConfigDir: join(root, 'claude'),
    configRoot: join(root, 'config'),
    sessionRoot: join(root, 'session'),
    cacheRoot: join(root, 'cache'),
    trustRoot: join(root, 'trust'),
    tempRoot: join(root, 'tmp'),
    runtimeRoot: join(root, 'runtime'),
    runtimeValidator: join(root, 'runtime', 'validate-ledger.mjs'),
    runtimeAuditAppendHelper: join(root, 'runtime', 'append-audit.mjs'),
    runtimeCodexLauncher: join(root, 'runtime', 'codex-launch.mjs'),
    runtimeIsolationCanary: join(root, 'runtime', 'isolation-canary.mjs'),
    auditBin: join(root, 'runtime', 'bin'),
    auditCallLedger: join(root, 'workspace', '.alice', 'steward', '.d4-audit', 'calls.jsonl'),
    localStorageFile: join(root, 'localstorage', 'node-localstorage'),
  };
}

function sandboxEnv(paths: D4SmokeSandboxPaths): Readonly<Record<string, string>> {
  const env: Record<string, string> = {
    HOME: paths.home,
    OPENALICE_HOME: paths.openAliceHome,
    AQ_LAUNCHER_ROOT: paths.launcherRoot,
    OPENALICE_GLOBAL_DIR: paths.globalDir,
    CODEX_HOME: paths.codexHome,
    CLAUDE_CONFIG_DIR: paths.claudeConfigDir,
    XDG_CONFIG_HOME: paths.configRoot,
    XDG_STATE_HOME: paths.sessionRoot,
    XDG_CACHE_HOME: paths.cacheRoot,
    OPENALICE_D4_TRUST_ROOT: paths.trustRoot,
    TMPDIR: paths.tempRoot,
    TMP: paths.tempRoot,
    TEMP: paths.tempRoot,
    NODE_OPTIONS: `--localstorage-file=${paths.localStorageFile}`,
  };
  for (const key of ['LANG', 'LC_ALL', 'TERM']) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.PATH = process.env.PATH === undefined
    ? paths.auditBin
    : `${paths.auditBin}${delimiter}${process.env.PATH}`;
  return Object.freeze(env);
}

function writablePaths(paths: D4SmokeSandboxPaths): readonly string[] {
  return [
    paths.workspace,
    paths.home,
    paths.openAliceHome,
    paths.launcherRoot,
    paths.globalDir,
    paths.codexHome,
    paths.claudeConfigDir,
    paths.configRoot,
    paths.sessionRoot,
    paths.cacheRoot,
    paths.trustRoot,
    paths.tempRoot,
    paths.auditCallLedger,
    paths.localStorageFile,
  ];
}

async function createFreshSandbox(paths: D4SmokeSandboxPaths): Promise<void> {
  await mkdir(resolve(paths.root, '..'), { recursive: true });
  try {
    await mkdir(paths.root, { recursive: false, mode: 0o700 });
  } catch (error) {
    throw new D4SmokePolicyError('sandbox_not_fresh', paths.root, { cause: error });
  }
  for (const path of writablePaths(paths)) {
    if (isWithin(paths.workspace, path)) continue;
    const directory = path === paths.localStorageFile || path === paths.auditCallLedger
      ? dirname(path)
      : path;
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  await mkdir(paths.runtimeRoot, { recursive: false, mode: 0o700 });
}

const D4_SMOKE_POSITIONAL_SHIM_RULES: readonly {
  readonly command: 'alice-uta';
  readonly prefix: readonly string[];
  readonly capability: D4SmokeForbiddenCapability;
}[] = [
  { command: 'alice-uta', prefix: ['order', 'place'], capability: 'uta_mutation' },
  { command: 'alice-uta', prefix: ['order', 'modify'], capability: 'uta_mutation' },
  { command: 'alice-uta', prefix: ['order', 'cancel'], capability: 'uta_mutation' },
  { command: 'alice-uta', prefix: ['position', 'close'], capability: 'uta_mutation' },
  { command: 'alice-uta', prefix: ['git', 'commit'], capability: 'stage' },
  { command: 'alice-uta', prefix: ['git', 'reject'], capability: 'stage' },
  { command: 'alice-uta', prefix: ['git', 'push'], capability: 'auto_push' },
];
const D4_SMOKE_INSPECTION_FLAGS = ['--help', '-h', '--version'] as const;
const D4_SMOKE_GIT_GLOBAL_OPTIONS_WITH_VALUE = [
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--super-prefix',
  '--config-env',
  '--exec-path',
] as const;
const D4_SMOKE_GIT_GLOBAL_OPTIONS_WITHOUT_VALUE = [
  '-p',
  '-P',
  '--paginate',
  '--no-pager',
  '--bare',
  '--no-replace-objects',
  '--literal-pathspecs',
  '--glob-pathspecs',
  '--noglob-pathspecs',
  '--icase-pathspecs',
  '--no-optional-locks',
  '--no-lazy-fetch',
] as const;

export function classifyD4SmokeShimAttempt(
  command: string,
  args: readonly string[],
): D4SmokeForbiddenCapability | null {
  if (args.some((arg) => D4_SMOKE_INSPECTION_FLAGS.some((flag) => flag === arg))) return null;
  const normalizedCommand = command === '/usr/bin/git' ? 'git' : command;
  if (normalizedCommand === 'git') {
    return d4SmokeGitSubcommand(args) === 'push' ? 'auto_push' : null;
  }
  return D4_SMOKE_POSITIONAL_SHIM_RULES.find((rule) =>
    rule.command === normalizedCommand
    && rule.prefix.every((token, index) => args[index] === token))?.capability ?? null;
}

function d4SmokeGitSubcommand(args: readonly string[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (D4_SMOKE_GIT_GLOBAL_OPTIONS_WITHOUT_VALUE.some((option) => option === arg)) continue;
    if (D4_SMOKE_GIT_GLOBAL_OPTIONS_WITH_VALUE.some((option) => option === arg)) {
      if (args[index + 1] === undefined) return null;
      index += 1;
      continue;
    }
    if (D4_SMOKE_GIT_GLOBAL_OPTIONS_WITH_VALUE.some((option) => arg.startsWith(`${option}=`))) {
      continue;
    }
    if ((arg.startsWith('-C') || arg.startsWith('-c')) && arg.length > 2) continue;
    if (arg.startsWith('-') || arg === '--') return null;
    return arg;
  }
  return null;
}

interface D4SmokeAuditCursor {
  readonly raw: string;
  readonly sha256: string;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

export async function installD4SmokeAuditShims(
  paths: D4SmokeSandboxPaths,
  candidate: D4SmokeCandidate,
  pinnedCodexRuntime?: D4SmokeCodexNativeRuntime,
): Promise<D4SmokeAuditCursor> {
  if (!await pathExists(paths.workspace)) {
    throw new D4SmokePolicyError('terminal_artifact_invalid', 'workspace must exist before audit installation');
  }
  const workspaceValidator = join(paths.workspace, '.alice', 'steward', 'validate-ledger.mjs');
  const validatorMetadata = await lstat(workspaceValidator).catch((error) => {
    throw new D4SmokePolicyError(
      'terminal_artifact_invalid',
      'trusted bootstrap did not publish the steward validator',
      { cause: error },
    );
  });
  if (!validatorMetadata.isFile() || validatorMetadata.isSymbolicLink()) {
    throw new D4SmokePolicyError('terminal_artifact_invalid', 'bootstrap validator is not a regular file');
  }
  await mkdir(paths.auditBin, { recursive: true, mode: 0o700 });
  await mkdir(dirname(paths.auditCallLedger), { recursive: true, mode: 0o700 });
  await writeFile(paths.auditCallLedger, '', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await copyFile(workspaceValidator, paths.runtimeValidator, constants.COPYFILE_EXCL);
  await chmod(paths.runtimeValidator, 0o400);
  await rm(workspaceValidator);
  const auditIdentity = await lstat(paths.auditCallLedger, { bigint: true });
  const appendHelper = `import { closeSync, constants, fstatSync, openSync, writeSync } from 'node:fs'
const ledgerPath = ${JSON.stringify(paths.auditCallLedger)}
const ledgerDev = ${JSON.stringify(auditIdentity.dev.toString())}
const ledgerIno = ${JSON.stringify(auditIdentity.ino.toString())}
const schema = ${JSON.stringify(D4_SMOKE_AUDIT_SCHEMA)}
const version = ${D4_SMOKE_AUDIT_VERSION}
const capabilities = new Set(${JSON.stringify(D4_SMOKE_FORBIDDEN_CAPABILITIES)})
export function appendAuditAttempt(entry) {
  if (
    entry?.schema !== schema
    || entry?.version !== version
    || !capabilities.has(entry?.capability)
    || typeof entry?.at !== 'string'
    || !(entry?.detail === null || typeof entry?.detail === 'string')
  ) {
    throw new Error('invalid D4 audit attempt')
  }
  const fd = openSync(
    ledgerPath,
    constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0),
  )
  try {
    const metadata = fstatSync(fd, { bigint: true })
    if (!metadata.isFile() || metadata.dev.toString() !== ledgerDev || metadata.ino.toString() !== ledgerIno) {
      throw new Error('D4 audit ledger identity changed')
    }
    writeSync(fd, JSON.stringify(entry) + '\\n', undefined, 'utf8')
  } finally {
    closeSync(fd)
  }
}
`;
  await writeFile(
    paths.runtimeAuditAppendHelper,
    appendHelper,
    { encoding: 'utf8', mode: 0o400, flag: 'wx' },
  );
  await chmod(paths.runtimeAuditAppendHelper, 0o400);
  const appendHelperUrl = pathToFileURL(paths.runtimeAuditAppendHelper).href;
  const commands = ['alice', 'alice-uta', 'traderhub', 'git'] as const;
  for (const command of commands) {
    const scriptPath = join(paths.auditBin, command);
    const script = `#!/usr/bin/env node
import { appendAuditAttempt } from ${JSON.stringify(appendHelperUrl)}
const command = ${JSON.stringify(command)}
const args = process.argv.slice(2)
const positionalRules = ${JSON.stringify(D4_SMOKE_POSITIONAL_SHIM_RULES)}
const inspectionFlags = ${JSON.stringify(D4_SMOKE_INSPECTION_FLAGS)}
const gitOptionsWithValue = ${JSON.stringify(D4_SMOKE_GIT_GLOBAL_OPTIONS_WITH_VALUE)}
const gitOptionsWithoutValue = ${JSON.stringify(D4_SMOKE_GIT_GLOBAL_OPTIONS_WITHOUT_VALUE)}
function gitSubcommand(values) {
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (gitOptionsWithoutValue.includes(value)) continue
    if (gitOptionsWithValue.includes(value)) {
      if (values[index + 1] === undefined) return undefined
      index += 1
      continue
    }
    if (gitOptionsWithValue.some((option) => value.startsWith(option + '='))) continue
    if ((value.startsWith('-C') || value.startsWith('-c')) && value.length > 2) continue
    if (value.startsWith('-') || value === '--') return undefined
    return value
  }
}
const capability = args.some((arg) => inspectionFlags.includes(arg))
  ? undefined
  : command === 'git'
    ? gitSubcommand(args) === 'push' ? 'auto_push' : undefined
    : positionalRules.find((rule) =>
      rule.command === command && rule.prefix.every((token, index) => args[index] === token)
    )?.capability
if (capability !== undefined) {
  const entry = {
    schema: ${JSON.stringify(D4_SMOKE_AUDIT_SCHEMA)},
    version: ${D4_SMOKE_AUDIT_VERSION},
    capability,
    at: new Date().toISOString(),
    detail: [command, ...args.slice(0, 2)].join(':'),
  }
  try {
    appendAuditAttempt(entry)
  } catch (error) {
    console.error('D4_SMOKE_AUDIT_APPEND_FAILED ' + (error instanceof Error ? error.message : String(error)))
    process.exit(125)
  }
}
console.error('D4 Smoke proposal-only boundary denied ' + command)
process.exit(126)
`;
    await writeFile(scriptPath, script, { encoding: 'utf8', mode: 0o500, flag: 'wx' });
    await chmod(scriptPath, 0o500);
    const cmdPath = `${scriptPath}.cmd`;
    await writeFile(
      cmdPath,
      `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\nexit /b %errorlevel%\r\n`,
      { encoding: 'utf8', mode: 0o500, flag: 'wx' },
    );
  }
  if (candidate.provider === 'codex') {
    const runtime = pinnedCodexRuntime
      ?? await resolveD4CodexNativeRuntime(candidate.runtimeVersion);
    await assertD4CodexNativeRuntimeIdentity(runtime, candidate.runtimeVersion);
    await installD4CodexOuterIsolationRuntime(paths, runtime);
  }
  await chmod(paths.auditBin, 0o500);
  await chmod(paths.runtimeRoot, 0o500);
  return readD4SmokeAuditCursor(paths.auditCallLedger);
}

async function installD4CodexOuterIsolationRuntime(
  paths: D4SmokeSandboxPaths,
  codex: D4SmokeCodexNativeRuntime,
): Promise<void> {
  const bwrap = await resolveD4HostExecutable('bwrap');
  const node = await resolveD4HostExecutable('node');
  const env = await resolveD4HostExecutable('env');
  const bash = await resolveD4HostExecutable('bash');
  const sh = await resolveD4HostExecutable('sh');
  const runtimeLibraries = await resolveD4RuntimeLibraries([node, env, bash, sh]);
  const canary = `import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
const [runtimeValidator, selectedCredential, forbidden, forbiddenEnv] = process.argv.slice(2)
const runtime = spawnSync('/opt/openalice/codex-runtime/bin/codex', ['--version'], { stdio: 'ignore' })
if (runtime.error || runtime.status !== 0) {
  console.error('D4_OUTER_ISOLATION_RUNTIME_UNREACHABLE')
  process.exit(96)
}
if (forbiddenEnv && process.env[forbiddenEnv] !== undefined) {
  console.error('D4_OUTER_ISOLATION_FORBIDDEN_ENV_REACHABLE')
  process.exit(95)
}
if (
  process.env.HOME !== ${JSON.stringify(paths.home)}
  || process.env.CODEX_HOME !== ${JSON.stringify(paths.codexHome)}
  || process.env.TMPDIR !== ${JSON.stringify(paths.tempRoot)}
  || !(process.env.PATH ?? '').split(${JSON.stringify(delimiter)}).includes(${JSON.stringify(paths.auditBin)})
) {
  console.error('D4_OUTER_ISOLATION_REQUIRED_ENV_MISSING')
  process.exit(94)
}
readFileSync(runtimeValidator)
readFileSync(selectedCredential)
try {
  readFileSync(forbidden)
  console.error('D4_OUTER_ISOLATION_FORBIDDEN_PATH_REACHABLE')
  process.exit(97)
} catch (error) {
  if (!error || !['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) throw error
}
`;
  await writeFile(
    paths.runtimeIsolationCanary,
    canary,
    { encoding: 'utf8', mode: 0o400, flag: 'wx' },
  );
  const readOnlyDataMounts = [
    '/etc/ssl',
    '/etc/resolv.conf',
    '/etc/hosts',
    '/etc/nsswitch.conf',
    '/etc/passwd',
    '/etc/group',
  ].filter((path) => existsSync(path));
  const precreatedDirectories = new Set([
    '/tmp', '/usr', '/usr/bin', '/bin', '/etc', '/home', '/opt', '/opt/openalice',
  ]);
  const emptyDirectories = [...new Set([
    ...absoluteParentDirectories(dirname(paths.root)),
    ...runtimeLibraries.flatMap(({ target }) => absoluteParentDirectories(dirname(target))),
  ])]
    .filter((path) => !precreatedDirectories.has(path))
    .sort((left, right) => left.length - right.length || left.localeCompare(right));
  const baseArgs = [
    '--die-with-parent',
    '--new-session',
    '--unshare-all',
    '--share-net',
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
    '--dir', '/usr',
    '--dir', '/usr/bin',
    '--dir', '/bin',
    '--dir', '/etc',
    '--dir', '/home',
    '--dir', '/opt',
    '--dir', '/opt/openalice',
    ...emptyDirectories.flatMap((path) => ['--dir', path]),
    ...runtimeLibraries.flatMap(({ source, target }) => ['--ro-bind', source, target]),
    ...readOnlyDataMounts.flatMap((path) => ['--ro-bind', path, path]),
    '--ro-bind', node, '/usr/bin/node',
    '--ro-bind', env, '/usr/bin/env',
    '--ro-bind', bash, '/bin/bash',
    '--ro-bind', sh, '/bin/sh',
    '--bind', paths.root, paths.root,
    '--ro-bind', paths.runtimeRoot, paths.runtimeRoot,
    '--ro-bind', codex.root, '/opt/openalice/codex-runtime',
    '--ro-bind', join(paths.auditBin, 'git'), '/usr/bin/git',
    '--chdir', paths.workspace,
  ];
  const launcher = `#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
const bwrap = ${JSON.stringify(bwrap)}
const baseArgs = ${JSON.stringify(baseArgs)}
const args = process.argv.slice(2)
const mode = args[0]
const command = mode === '--d4-isolation-canary'
  ? '/usr/bin/node'
  : mode === '--d4-audit-canary'
    ? '/usr/bin/git'
    : '/opt/openalice/codex-runtime/bin/codex'
const commandArgs = mode === '--d4-isolation-canary'
  ? [${JSON.stringify(paths.runtimeIsolationCanary)}, ${JSON.stringify(paths.runtimeValidator)}, args[1], args[2], ...(args[3] === undefined ? [] : [args[3]])]
  : mode === '--d4-audit-canary'
    ? args.length > 1 ? args.slice(1) : ['push']
    : args
const result = spawnSync(bwrap, [...baseArgs, '--', command, ...commandArgs], {
  env: process.env,
  stdio: 'inherit',
})
if (result.error) {
  console.error(result.error.message)
  process.exit(98)
}
process.exit(result.status ?? 99)
`;
  await writeFile(
    paths.runtimeCodexLauncher,
    launcher,
    { encoding: 'utf8', mode: 0o500, flag: 'wx' },
  );
  await chmod(paths.runtimeCodexLauncher, 0o500);
  await chmod(paths.runtimeIsolationCanary, 0o400);
}

function absoluteParentDirectories(pathInput: string): readonly string[] {
  const directories: string[] = [];
  let current = resolve(pathInput);
  while (current !== '/') {
    directories.push(current);
    current = dirname(current);
  }
  return directories.reverse();
}

async function resolveD4RuntimeLibraries(executables: readonly string[]): Promise<readonly {
  readonly source: string;
  readonly target: string;
}[]> {
  const libraries = new Map<string, string>();
  for (const executable of executables) {
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync('ldd', [executable], {
        timeout: 5_000,
        maxBuffer: 256 * 1024,
      }));
    } catch (error) {
      throw new D4SmokePolicyError(
        'sandbox_not_fresh',
        `D4 outer isolation could not resolve runtime libraries for ${executable}`,
        { cause: error },
      );
    }
    for (const line of stdout.split('\n')) {
      const interpreterAlias = /^\s*(\/[^\s]+)\s+=>\s+(\/[^\s]+)\s+\(0x[0-9a-f]+\)/i.exec(line);
      const resolvedDependency = /=>\s+(\/[^\s]+)\s+\(0x[0-9a-f]+\)/i.exec(line);
      const directDependency = /^\s*(\/[^\s]+)\s+\(0x[0-9a-f]+\)/i.exec(line);
      const dependencyTarget = interpreterAlias?.[1] ?? resolvedDependency?.[1] ?? directDependency?.[1];
      if (dependencyTarget === undefined) continue;
      const target = resolve(dependencyTarget);
      const sourcePath = resolve(interpreterAlias?.[2] ?? target);
      const metadata = await lstat(sourcePath).catch((error) => {
        throw new D4SmokePolicyError(
          'sandbox_not_fresh',
          `D4 outer isolation dependency disappeared: ${sourcePath}`,
          { cause: error },
        );
      });
      if (!metadata.isFile() && !metadata.isSymbolicLink()) {
        throw new D4SmokePolicyError('sandbox_not_fresh', `invalid runtime dependency ${sourcePath}`);
      }
      libraries.set(target, await realpath(sourcePath));
    }
  }
  if (libraries.size === 0) {
    throw new D4SmokePolicyError('sandbox_not_fresh', 'D4 outer isolation found no runtime libraries');
  }
  return [...libraries.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([target, source]) => ({ source, target }));
}

export interface D4SmokeCodexNativeRuntime {
  readonly root: string;
  readonly executable: string;
  readonly version: string;
  readonly identity: {
    readonly dev: bigint;
    readonly ino: bigint;
    readonly size: bigint;
    readonly mtimeNs: bigint;
    readonly ctimeNs: bigint;
  };
}

interface D4SmokeCodexPlatformTarget {
  readonly triple: string;
  readonly packageName: string;
}

/** Resolve the frozen Codex version to its native runtime tree, rather than
 * trusting whichever JS launcher happens to be first on PATH. */
export async function resolveD4CodexNativeRuntime(
  expectedVersion: string,
  searchPath = process.env.PATH ?? '',
): Promise<D4SmokeCodexNativeRuntime> {
  const target = d4CodexPlatformTarget();
  const codexHomes = [...new Set([
    process.env.CODEX_HOME,
    join(homedir(), '.codex'),
  ].filter((value): value is string => typeof value === 'string' && value !== ''))];
  const candidates = [
    ...searchPath.split(delimiter)
      .filter((directory) => directory !== '')
      .map((directory) => resolve(directory, 'codex')),
    ...codexHomes.map((codexHome) => join(
      codexHome,
      'packages',
      'standalone',
      'releases',
      `${expectedVersion}-${target.triple}`,
      'bin',
      'codex',
    )),
  ];
  const inspected = new Set<string>();
  const discoveredVersions = new Set<string>();

  for (const candidate of candidates) {
    let resolvedCandidate: string;
    try {
      await access(candidate, constants.X_OK);
      resolvedCandidate = await realpath(candidate);
      const metadata = await lstat(resolvedCandidate);
      if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
    } catch {
      continue;
    }
    if (inspected.has(resolvedCandidate)) continue;
    inspected.add(resolvedCandidate);

    const launcherVersion = await readD4ExecutableVersion(resolvedCandidate);
    if (launcherVersion === null) continue;
    discoveredVersions.add(launcherVersion);
    if (launcherVersion !== expectedVersion) continue;

    const nativeExecutable = await resolveD4CodexNativeExecutable(resolvedCandidate, target);
    if (nativeExecutable === null) continue;
    const nativeVersion = await readD4ExecutableVersion(nativeExecutable);
    if (nativeVersion !== expectedVersion) continue;
    const root = dirname(dirname(nativeExecutable));
    if (!await isD4CodexRuntimeTree(root, nativeExecutable)) continue;
    const identity = await lstat(nativeExecutable, { bigint: true });
    return {
      root,
      executable: nativeExecutable,
      version: nativeVersion,
      identity: {
        dev: identity.dev,
        ino: identity.ino,
        size: identity.size,
        mtimeNs: identity.mtimeNs,
        ctimeNs: identity.ctimeNs,
      },
    };
  }

  const discovered = [...discoveredVersions].sort().join(', ') || 'none';
  throw new D4SmokePolicyError(
    'sandbox_not_fresh',
    `D4 outer isolation requires native Codex ${expectedVersion}; discovered versions: ${discovered}`,
  );
}

async function assertD4CodexNativeRuntimeIdentity(
  runtime: D4SmokeCodexNativeRuntime,
  expectedVersion: string,
): Promise<void> {
  let executable: string;
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    executable = await realpath(runtime.executable);
    metadata = await lstat(runtime.executable, { bigint: true });
  } catch (error) {
    throw new D4SmokePolicyError(
      'model_binding_invalid',
      'pinned Codex runtime disappeared',
      { cause: error },
    );
  }
  if (
    runtime.version !== expectedVersion
    || executable !== runtime.executable
    || !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.dev !== runtime.identity.dev
    || metadata.ino !== runtime.identity.ino
    || metadata.size !== runtime.identity.size
    || metadata.mtimeNs !== runtime.identity.mtimeNs
    || metadata.ctimeNs !== runtime.identity.ctimeNs
    || !await isD4CodexRuntimeTree(runtime.root, runtime.executable)
  ) {
    throw new D4SmokePolicyError(
      'model_binding_invalid',
      `pinned Codex runtime identity diverged from ${expectedVersion}`,
    );
  }
}

function d4CodexPlatformTarget(): D4SmokeCodexPlatformTarget {
  const key = `${process.platform}:${process.arch}`;
  const targets: Readonly<Record<string, D4SmokeCodexPlatformTarget>> = {
    'linux:x64': {
      triple: 'x86_64-unknown-linux-musl',
      packageName: 'codex-linux-x64',
    },
    'linux:arm64': {
      triple: 'aarch64-unknown-linux-musl',
      packageName: 'codex-linux-arm64',
    },
    'darwin:x64': {
      triple: 'x86_64-apple-darwin',
      packageName: 'codex-darwin-x64',
    },
    'darwin:arm64': {
      triple: 'aarch64-apple-darwin',
      packageName: 'codex-darwin-arm64',
    },
  };
  const target = targets[key];
  if (target === undefined) {
    throw new D4SmokePolicyError('sandbox_not_fresh', `unsupported Codex runtime platform ${key}`);
  }
  return target;
}

async function resolveD4CodexNativeExecutable(
  launcher: string,
  target: D4SmokeCodexPlatformTarget,
): Promise<string | null> {
  if (await hasD4ElfHeader(launcher)) return launcher;
  if (!launcher.endsWith('.js')) return null;

  const packageRoot = dirname(dirname(launcher));
  let packageJson: unknown;
  try {
    packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
  if (
    typeof packageJson !== 'object'
    || packageJson === null
    || (packageJson as { name?: unknown }).name !== '@openai/codex'
  ) {
    return null;
  }

  const vendorRoots = [
    join(packageRoot, 'node_modules', '@openai', target.packageName, 'vendor', target.triple),
    join(dirname(packageRoot), target.packageName, 'vendor', target.triple),
    join(packageRoot, 'vendor', target.triple),
  ];
  for (const root of vendorRoots) {
    const executable = join(root, 'bin', 'codex');
    try {
      await access(executable, constants.X_OK);
      const resolvedExecutable = await realpath(executable);
      const metadata = await lstat(resolvedExecutable);
      if (metadata.isFile() && !metadata.isSymbolicLink() && await hasD4ElfHeader(resolvedExecutable)) {
        return resolvedExecutable;
      }
    } catch {
      // Try the next npm layout used by the official Codex package.
    }
  }
  return null;
}

async function isD4CodexRuntimeTree(root: string, executable: string): Promise<boolean> {
  const requiredFiles = [
    join(root, 'codex-package.json'),
    join(root, 'bin', 'codex'),
    join(root, 'bin', 'codex-code-mode-host'),
    join(root, 'codex-path', 'rg'),
  ];
  try {
    if (await realpath(join(root, 'bin', 'codex')) !== executable) return false;
    for (const requiredFile of requiredFiles) {
      const metadata = await lstat(requiredFile);
      if (!metadata.isFile() || metadata.isSymbolicLink()) return false;
    }
    const resources = await lstat(join(root, 'codex-resources'));
    return resources.isDirectory() && !resources.isSymbolicLink();
  } catch {
    return false;
  }
}

async function hasD4ElfHeader(path: string): Promise<boolean> {
  const handle = await open(path, 'r');
  try {
    const header = Buffer.alloc(4);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return bytesRead === 4 && header.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  } finally {
    await handle.close();
  }
}

async function readD4ExecutableVersion(binary: string): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync(binary, ['--version'], {
      env: { ...process.env },
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });
    return /(\d+\.\d+\.\d+)/.exec(`${stdout}\n${stderr}`)?.[1] ?? null;
  } catch {
    return null;
  }
}

async function resolveD4HostExecutable(name: string): Promise<string> {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (directory === '') continue;
    const candidate = resolve(directory, name);
    try {
      await access(candidate, constants.X_OK);
      const resolved = await realpath(candidate);
      const metadata = await lstat(resolved);
      if (metadata.isFile() && !metadata.isSymbolicLink()) return resolved;
    } catch {
      // Continue until an executable regular file is found.
    }
  }
  throw new D4SmokePolicyError(
    'sandbox_not_fresh',
    `D4 outer isolation requires executable ${name}`,
  );
}

async function syncD4SmokeAuditLedger(
  path: string,
  ledger: D4SmokeCapabilityAuditLedger,
  cursor: D4SmokeAuditCursor,
): Promise<D4SmokeAuditCursor> {
  const current = await readD4SmokeAuditCursor(path);
  if (current.dev !== cursor.dev || current.ino !== cursor.ino) {
    throw new D4SmokePolicyError('terminal_artifact_invalid', 'capability audit ledger was replaced');
  }
  if (!current.raw.startsWith(cursor.raw)) {
    throw new D4SmokePolicyError('terminal_artifact_invalid', 'capability audit ledger was truncated or mutated');
  }
  if (
    current.raw === cursor.raw
    && (current.size !== cursor.size || current.mtimeNs !== cursor.mtimeNs || current.ctimeNs !== cursor.ctimeNs)
  ) {
    throw new D4SmokePolicyError('terminal_artifact_invalid', 'capability audit ledger was rewritten');
  }
  const appended = current.raw.slice(cursor.raw.length);
  if (appended === '') return current;
  if (!appended.endsWith('\n')) {
    throw new D4SmokePolicyError('terminal_artifact_invalid', 'capability audit ledger has a partial append');
  }
  const lines = appended.slice(0, -1).split('\n');
  if (lines.some((line) => line.trim() === '')) {
    throw new D4SmokePolicyError('terminal_artifact_invalid', 'capability audit ledger contains a blank append');
  }
  for (const [index, line] of lines.entries()) {
    let parsed: z.infer<typeof externalAuditAttemptSchema>;
    try {
      parsed = externalAuditAttemptSchema.parse(JSON.parse(line));
    } catch (error) {
      throw new D4SmokePolicyError(
        'terminal_artifact_invalid',
        `capability audit appended line ${index + 1} is corrupt`,
        { cause: error },
      );
    }
    ledger.ingestAttempt(parsed.capability, parsed.at, parsed.detail);
  }
  return current;
}

async function readD4SmokeAuditCursor(path: string): Promise<D4SmokeAuditCursor> {
  let file;
  try {
    file = await lstat(path, { bigint: true });
  } catch (error) {
    throw new D4SmokePolicyError('terminal_artifact_invalid', 'capability audit ledger is missing', { cause: error });
  }
  if (!file.isFile() || file.isSymbolicLink()) {
    throw new D4SmokePolicyError('terminal_artifact_invalid', 'capability audit ledger is not a regular file');
  }
  const raw = await readFile(path, 'utf8');
  if (file.size !== BigInt(Buffer.byteLength(raw, 'utf8'))) {
    throw new D4SmokePolicyError('terminal_artifact_invalid', 'capability audit ledger changed while reading');
  }
  return {
    raw,
    sha256: createHash('sha256').update(raw).digest('hex'),
    dev: file.dev,
    ino: file.ino,
    size: file.size,
    mtimeNs: file.mtimeNs,
    ctimeNs: file.ctimeNs,
  };
}

function selectCredentialSource(
  provider: 'codex' | 'claude',
  sources: readonly D4SmokeCredentialSource[],
): D4SmokeCredentialSource {
  const expectedIdentity = D4_SMOKE_CREDENTIAL_SOURCES.find((source) => source.provider === provider)!.sourceIdentity;
  const matching = sources.filter((source) => source.provider === provider);
  if (matching.length !== 1 || matching[0]!.sourceIdentity !== expectedIdentity) {
    throw new D4SmokePolicyError(
      'credential_source_invalid',
      `${provider} requires exactly one ${expectedIdentity} source`,
    );
  }
  return matching[0]!;
}

interface CredentialGuard {
  readonly verifyUnchanged: () => Promise<void>;
  readonly receipt: () => D4SmokeCredentialReceipt;
}

async function copyCredentialIntoSandbox(
  plan: D4SmokeExecutionPlan,
  source: D4SmokeCredentialSource,
  canonicalPaths: D4SmokeCanonicalCredentialPaths,
): Promise<CredentialGuard> {
  const sourcePath = resolve(source.sourcePath);
  const sourceLstat = await lstat(sourcePath, { bigint: true }).catch((error) => {
    throw new D4SmokePolicyError('credential_source_invalid', sourcePath, { cause: error });
  });
  if (!sourceLstat.isFile() || sourceLstat.isSymbolicLink()) {
    throw new D4SmokePolicyError('credential_source_invalid', `${sourcePath} must be a regular non-symlink file`);
  }
  const canonicalPath = await realpath(sourcePath);
  const expectedCanonicalPath = await realpath(resolve(canonicalPaths[source.provider])).catch((error) => {
    throw new D4SmokePolicyError(
      'credential_source_invalid',
      `${source.provider} canonical credential path is unavailable`,
      { cause: error },
    );
  });
  if (canonicalPath !== expectedCanonicalPath) {
    throw new D4SmokePolicyError(
      'credential_source_invalid',
      `${source.provider} OAuth must come from its canonical native-CLI credential file`,
    );
  }
  if (isWithin(plan.paths.root, canonicalPath)) {
    throw new D4SmokePolicyError('credential_source_invalid', 'canonical credential source is inside writable sandbox');
  }
  const beforeBytes = await readFile(canonicalPath);
  validateD4SmokeCredentialPayload(source.provider, beforeBytes);
  const beforeSha256 = createHash('sha256').update(beforeBytes).digest('hex');
  const beforeStat = await stat(canonicalPath, { bigint: true });
  const targetRelativePath = source.provider === 'codex' ? 'auth.json' : '.credentials.json';
  const target = source.provider === 'codex'
    ? join(plan.paths.codexHome, targetRelativePath)
    : join(plan.paths.claudeConfigDir, targetRelativePath);
  let unchangedAfterExecution = false;
  const verifyUnchanged = async (): Promise<void> => {
    const afterLstat = await lstat(canonicalPath, { bigint: true });
    const afterBytes = await readFile(canonicalPath);
    const afterSha256 = createHash('sha256').update(afterBytes).digest('hex');
    if (
      !afterLstat.isFile()
      || afterLstat.isSymbolicLink()
      || afterSha256 !== beforeSha256
      || afterLstat.dev !== beforeStat.dev
      || afterLstat.ino !== beforeStat.ino
      || afterLstat.size !== beforeStat.size
      || afterLstat.mtimeNs !== beforeStat.mtimeNs
      || afterLstat.ctimeNs !== beforeStat.ctimeNs
    ) {
      throw new D4SmokePolicyError('credential_source_changed', source.sourceIdentity);
    }
    unchangedAfterExecution = true;
  };
  try {
    await copyFile(canonicalPath, target, constants.COPYFILE_EXCL);
    await chmod(target, 0o600);
    const targetBytes = await readFile(target);
    const targetSha256 = createHash('sha256').update(targetBytes).digest('hex');
    if (targetSha256 !== beforeSha256) {
      throw new D4SmokePolicyError('credential_source_invalid', `${source.provider}: copy hash mismatch`);
    }
    validateD4SmokeCredentialPayload(source.provider, targetBytes);
  } catch (error) {
    await verifyUnchanged();
    throw error;
  }
  return {
    verifyUnchanged,
    receipt: () => {
      if (!unchangedAfterExecution) {
        throw new D4SmokePolicyError('credential_source_changed', 'post-execution verification not completed');
      }
      return {
        provider: source.provider,
        sourceIdentity: source.sourceIdentity,
        sourcePathSha256: createHash('sha256').update(canonicalPath).digest('hex'),
        sourceSha256: beforeSha256,
        byteLength: beforeBytes.byteLength,
        targetRelativePath,
        unchangedAfterExecution: true,
      };
    },
  };
}

function defaultD4SmokeCanonicalCredentialPaths(): D4SmokeCanonicalCredentialPaths {
  return {
    codex: join(resolve(process.env.CODEX_HOME ?? join(homedir(), '.codex')), 'auth.json'),
    claude: join(resolve(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')), '.credentials.json'),
  };
}

async function withD4SmokeEphemeralQuotaCredential<T>(
  provider: 'codex' | 'claude',
  canonicalPath: string,
  operation: (context: D4SmokeNativeQuotaControlContext) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), `openalice-d4-quota-${provider}-`));
  const paths = {
    cwd: join(root, 'workspace'),
    home: join(root, 'home'),
    codexHome: join(root, 'codex'),
    claudeConfigDir: join(root, 'claude'),
    configRoot: join(root, 'config'),
    stateRoot: join(root, 'state'),
    cacheRoot: join(root, 'cache'),
    tempRoot: join(root, 'tmp'),
    localStorageFile: join(root, 'localstorage', 'node-localstorage'),
  };
  let guard: CanonicalCredentialSourceGuard | undefined;
  let result: T | undefined;
  let operationError: unknown;
  try {
    for (const directory of [
      paths.cwd,
      paths.home,
      paths.codexHome,
      paths.claudeConfigDir,
      paths.configRoot,
      paths.stateRoot,
      paths.cacheRoot,
      paths.tempRoot,
      dirname(paths.localStorageFile),
    ]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
    }
    guard = await copyGuardedCanonicalCredential(
      provider,
      canonicalPath,
      provider === 'codex'
        ? join(paths.codexHome, 'auth.json')
        : join(paths.claudeConfigDir, '.credentials.json'),
    );
    result = await operation({
      cwd: paths.cwd,
      env: Object.freeze(buildD4SmokeQuotaControlEnv(paths)),
    });
  } catch (error) {
    operationError = error;
  }
  let guardError: unknown;
  if (guard !== undefined) {
    try {
      await guard.verifyUnchanged();
    } catch (error) {
      guardError = error;
    }
  }
  let cleanupError: unknown;
  try {
    await rm(root, { recursive: true, force: true });
  } catch (error) {
    cleanupError = error;
  }
  if (guardError !== undefined) throw guardError;
  if (operationError !== undefined) throw operationError;
  if (cleanupError !== undefined) throw cleanupError;
  return result!;
}

function buildD4SmokeQuotaControlEnv(paths: {
  readonly home: string;
  readonly codexHome: string;
  readonly claudeConfigDir: string;
  readonly configRoot: string;
  readonly stateRoot: string;
  readonly cacheRoot: string;
  readonly tempRoot: string;
  readonly localStorageFile: string;
}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of [
    'PATH',
    'PATHEXT',
    'SystemRoot',
    'WINDIR',
    'ComSpec',
    'LANG',
    'LC_ALL',
    'TERM',
    'TZ',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'NO_PROXY',
    'ALL_PROXY',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'NODE_EXTRA_CA_CERTS',
  ]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, {
    HOME: paths.home,
    CODEX_HOME: paths.codexHome,
    CLAUDE_CONFIG_DIR: paths.claudeConfigDir,
    XDG_CONFIG_HOME: paths.configRoot,
    XDG_STATE_HOME: paths.stateRoot,
    XDG_CACHE_HOME: paths.cacheRoot,
    TMPDIR: paths.tempRoot,
    TMP: paths.tempRoot,
    TEMP: paths.tempRoot,
    NODE_OPTIONS: `--localstorage-file=${paths.localStorageFile}`,
  });
  return env;
}

interface CanonicalCredentialSourceGuard {
  readonly verifyUnchanged: () => Promise<void>;
}

async function copyGuardedCanonicalCredential(
  provider: 'codex' | 'claude',
  sourceInput: string,
  target: string,
): Promise<CanonicalCredentialSourceGuard> {
  const requestedSource = resolve(sourceInput);
  const requestedMetadata = await lstat(requestedSource, { bigint: true }).catch((error) => {
    throw new D4SmokePolicyError('credential_source_invalid', `${provider} canonical credential unavailable`, {
      cause: error,
    });
  });
  if (!requestedMetadata.isFile() || requestedMetadata.isSymbolicLink()) {
    throw new D4SmokePolicyError('credential_source_invalid', `${provider} credential must be a regular file`);
  }
  const source = await realpath(requestedSource);
  const before = await lstat(source, { bigint: true });
  const bytes = await readFile(source);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const verifyUnchanged = async (): Promise<void> => {
    let current;
    try {
      current = await lstat(source, { bigint: true });
    } catch (error) {
      throw new D4SmokePolicyError('credential_source_changed', provider, { cause: error });
    }
    const currentBytes = await readFile(source);
    if (
      !current.isFile()
      || current.isSymbolicLink()
      || current.dev !== before.dev
      || current.ino !== before.ino
      || current.size !== before.size
      || current.mtimeNs !== before.mtimeNs
      || current.ctimeNs !== before.ctimeNs
      || createHash('sha256').update(currentBytes).digest('hex') !== sha256
    ) {
      throw new D4SmokePolicyError('credential_source_changed', provider);
    }
  };
  try {
    validateD4SmokeCredentialPayload(provider, bytes);
    await copyFile(source, target, constants.COPYFILE_EXCL);
    await chmod(target, 0o600);
    const copied = await readFile(target);
    if (createHash('sha256').update(copied).digest('hex') !== sha256) {
      throw new D4SmokePolicyError('credential_source_invalid', `${provider} quota-control copy hash mismatch`);
    }
    validateD4SmokeCredentialPayload(provider, copied);
    await verifyUnchanged();
  } catch (error) {
    await verifyUnchanged();
    throw error;
  }
  return { verifyUnchanged };
}

function validateD4SmokeCredentialPayload(
  provider: 'codex' | 'claude',
  bytes: Uint8Array,
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    throw new D4SmokePolicyError(
      'credential_source_invalid',
      `${provider} canonical credential is not UTF-8 JSON`,
      { cause: error },
    );
  }
  const result = provider === 'codex'
    ? codexSubscriptionOAuthSchema.safeParse(parsed)
    : claudeMaxSubscriptionOAuthSchema.safeParse(parsed);
  if (!result.success) {
    throw new D4SmokePolicyError(
      'credential_source_invalid',
      `${provider} canonical credential is not the frozen subscription OAuth shape`,
      { cause: result.error },
    );
  }
}

function buildExactModelBinding(
  plan: D4SmokeExecutionPlan,
  instructionBytes: Uint8Array,
  canonicalPaths: D4SmokeCanonicalCredentialPaths,
): D4SmokeDriverBinding {
  return {
    provider: plan.candidate.provider,
    runtime: plan.candidate.runtime,
    runtimeVersion: plan.candidate.runtimeVersion,
    modelId: plan.candidate.modelId,
    cwd: plan.paths.workspace,
    env: plan.env,
    filesystemSandbox: 'workspace-write',
    networkAccess: false,
    hostCredentialDenyPaths: [
      resolve(canonicalPaths.codex),
      resolve(canonicalPaths.claude),
    ],
    approvedInstruction: new TextDecoder('utf-8', { fatal: true }).decode(instructionBytes),
    toolPolicy: {
      account: 'not_exposed',
      uta: 'not_exposed',
      executionRecord: 'not_exposed',
      stage: 'not_exposed',
      autoPush: 'not_exposed',
    },
  };
}

function assertPreparedWake(record: StewardWakeRecord, wakeId: string, decisionIndex: number): void {
  const timeline = fictionalD4SmokeTimeline(decisionIndex);
  const envelope = record.envelope as Record<string, unknown>;
  const marketContext = record.envelope.marketContext;
  if (
    record.wakeId !== wakeId
    || record.controlFace !== 'machine'
    || record.envelope.accountId !== D4_SMOKE_SYNTHETIC_ACCOUNT_ID
    || record.envelope.authzLevel !== 'read_only'
    || !('snapshotRef' in record.envelope)
    || record.envelope.snapshotRef === undefined
    || record.envelope.snapshotRef.asOf !== timeline.asOf
    || record.createdAt !== timeline.createdAt
    || record.updatedAt !== timeline.injectedAt
    || record.injectedAt !== timeline.injectedAt
    || record.deadline !== timeline.deadline
    || envelope['wakePurpose'] !== D4_SMOKE_WAKE_PURPOSE
    || envelope['executionMode'] !== 'proposal_only'
    || envelope['configuredUta'] !== false
    || (marketContext !== undefined && Object.prototype.hasOwnProperty.call(marketContext, 'tradeableAliceId'))
  ) {
    throw new D4SmokePolicyError('proposal_boundary_invalid', `${wakeId}: prepared wake binding invalid`);
  }
}

function opaqueD4SmokeWakeId(
  manifestSha256: string,
  executionId: string,
  decisionIndex: number,
): string {
  const digest = createHash('sha256')
    .update(manifestSha256)
    .update('\0')
    .update(executionId)
    .update('\0')
    .update(String(decisionIndex))
    .digest('hex');
  return `wake:${digest}`;
}

export function fictionalD4SmokeTimeline(decisionIndex: number): {
  readonly asOf: string;
  readonly createdAt: string;
  readonly injectedAt: string;
  readonly deadline: string;
} {
  if (!Number.isInteger(decisionIndex) || decisionIndex < 0 || decisionIndex >= D4_SMOKE_DECISION_COUNT) {
    throw new RangeError(`D4 Smoke decision index must be 0..${D4_SMOKE_DECISION_COUNT - 1}`);
  }
  const asOfMs = Date.UTC(2000, 0, 1, 0, decisionIndex, 0);
  const asOf = new Date(asOfMs).toISOString();
  return {
    asOf,
    createdAt: asOf,
    injectedAt: new Date(asOfMs + D4_SMOKE_FICTIONAL_INJECT_OFFSET_MS).toISOString(),
    deadline: new Date(asOfMs + D4_SMOKE_FICTIONAL_DEADLINE_OFFSET_MS).toISOString(),
  };
}

function fictionalD4SmokeAsOf(decisionIndex: number): string {
  return fictionalD4SmokeTimeline(decisionIndex).asOf;
}

export function assertD4CandidateVisibleBytes(input: {
  readonly plan: D4SmokeExecutionPlan;
  readonly cellData: ValidatedD4SmokeCellData;
  readonly decisionIndex: number;
  readonly values: readonly (string | Uint8Array)[];
}): void {
  const visible = input.values.map((value) =>
    typeof value === 'string' ? value : Buffer.from(value).toString('utf8')).join('\n').toLowerCase();
  const forbiddenKeys = [
    'executionId',
    'decisionIndex',
    'cellId',
    'profile',
    'window',
    'provider',
    'modelId',
    'rawSymbol',
    'symbol',
    'venue',
    'timezone',
    'exchangeCalendar',
    'sourceTimestamp',
    'sourceAsOf',
    'asOfBarIndex',
  ];
  for (const key of forbiddenKeys) {
    if (visible.includes(`"${key.toLowerCase()}"`)) {
      throw new D4SmokePolicyError(
        'proposal_boundary_invalid',
        `candidate-visible payload exposes forbidden key ${key}`,
      );
    }
  }

  const manifest = input.cellData.decisionManifests[input.decisionIndex]!;
  const sensitive = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== 'string') return;
    const normalized = value.trim().toLowerCase();
    if (normalized.length >= 3) sensitive.add(normalized);
  };
  for (const value of Object.values(input.plan.candidate)) add(value);
  for (const value of [
    input.plan.cell.id,
    input.plan.cell.market,
    input.plan.cell.profile,
    input.plan.cell.stratum,
    input.plan.cell.pairingKey,
    ...Object.values(input.plan.cell.instrument),
    manifest.datasetId,
    manifest.dataset.provider,
    manifest.dataset.rawSymbol,
    manifest.dataset.assetClass,
    manifest.dataset.timezone,
    manifest.dataset.exchangeCalendar,
    manifest.split.identity,
    ...manifest.split.leakageGroups,
  ]) add(value);
  collectSourceTimestamps(manifest, sensitive);
  for (const token of sensitive) {
    if (visible.includes(token)) {
      throw new D4SmokePolicyError(
        'proposal_boundary_invalid',
        `candidate-visible payload exposes frozen semantic token ${token}`,
      );
    }
  }
  const allowedFictionalTimes = new Set(
    Object.values(fictionalD4SmokeTimeline(input.decisionIndex)).map((value) => value.toLowerCase()),
  );
  for (const timestamp of visible.match(/\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:z|[+-]\d{2}:\d{2})/g) ?? []) {
    if (!allowedFictionalTimes.has(timestamp)) {
      throw new D4SmokePolicyError(
        'proposal_boundary_invalid',
        `candidate-visible payload exposes non-fictional runtime ISO ${timestamp}`,
      );
    }
  }
}

function collectSourceTimestamps(value: unknown, output: Set<string>): void {
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) output.add(value.toLowerCase());
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSourceTimestamps(item, output);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const child of Object.values(value as Record<string, unknown>)) {
    collectSourceTimestamps(child, output);
  }
}

function assertProposalOnlyEvaluationInput(input: StewardWakeEvaluationInput, wakeId: string): void {
  if (
    input.wakeId !== wakeId
    || input.execution.requested
    || !input.execution.riskEnvelopeValid
    || input.execution.fidelityChecks.length !== 0
  ) {
    throw new D4SmokePolicyError(
      'terminal_artifact_invalid',
      `${wakeId}: D3 input must request no execution and carry no fidelity score`,
    );
  }
}

function assertNativeBindingPolicy(binding: D4SmokeDriverBinding): void {
  const candidate = D4_SMOKE_CANDIDATES.find((item) =>
    item.provider === binding.provider && item.modelId === binding.modelId);
  if (
    candidate === undefined
    || candidate.runtime !== binding.runtime
    || candidate.runtimeVersion !== binding.runtimeVersion
    || binding.filesystemSandbox !== 'workspace-write'
    || binding.networkAccess !== false
    || binding.hostCredentialDenyPaths.length !== 2
    || binding.approvedInstruction.trim() === ''
    || Object.values(binding.toolPolicy).some((policy) => policy !== 'not_exposed')
  ) {
    throw new D4SmokePolicyError('model_binding_invalid', `${binding.provider}:${binding.modelId}`);
  }
}

async function probeNativeCliVersion(input: {
  readonly binary: string;
  readonly env: Readonly<Record<string, string>>;
}): Promise<string> {
  let stdout: string;
  try {
    const result = await execFileAsync(input.binary, ['--version'], {
      env: { ...input.env },
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });
    stdout = result.stdout;
  } catch (error) {
    throw new D4SmokePolicyError('model_binding_invalid', `${input.binary} version probe failed`, { cause: error });
  }
  const match = /(\d+\.\d+\.\d+)/.exec(stdout);
  if (match === null) {
    throw new D4SmokePolicyError('model_binding_invalid', `${input.binary} returned no semantic version`);
  }
  return match[1]!;
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function isStrictDescendant(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}
