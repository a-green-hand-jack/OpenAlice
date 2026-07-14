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
import type {
  MachineTransport,
  ProviderModelUsage,
  StewardMachineDriver,
  ThreadTelemetry,
  TurnOutcome,
} from './machine-driver/types.js';
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

// Claude Code 2.1.202 uses CLAUDE_CODE_TMPDIR for its per-user Bash temp
// directory, but its Linux bridge initializer calls os.tmpdir() directly for
// the socat HTTP/SOCKS sockets. Keep both directories short.
const D4_CLAUDE_BRIDGE_SOCKET_PATH_MAX_BYTES = 107;
const D4_CLAUDE_BRIDGE_SOCKET_SUFFIX_RESERVE_BYTES = 64;
const D4_CLAUDE_EFFECTIVE_TMP_MAX_BYTES = 44;
const D4_CLAUDE_BRIDGE_TMP_PREFIX = 'oa-d4-';

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

const codexRateLimitResetCreditSchema = z.object({
  id: nonEmptyStringSchema,
  resetType: z.literal('codexRateLimits'),
  status: z.literal('available'),
  grantedAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
  title: nonEmptyStringSchema,
  description: nonEmptyStringSchema,
}).strict();

const codexRateLimitsResponseSchema = z.object({
  rateLimitsByLimitId: z.record(z.string(), codexRateLimitSnapshotSchema),
  rateLimitResetCredits: z.object({
    availableCount: z.number().int().nonnegative(),
    credits: z.array(codexRateLimitResetCreditSchema),
  }).strict().refine(
    ({ availableCount, credits }) => availableCount === credits.length,
    'availableCount must equal credits length',
  ),
}).passthrough();

const codexProviderSerialRateLimitSnapshotSchema = codexRateLimitSnapshotSchema.extend({
  credits: z.object({
    hasCredits: z.boolean(),
    unlimited: z.boolean(),
    balance: z.union([z.string(), z.null()]),
  }).passthrough().nullable(),
  individualLimit: z.unknown(),
});

const codexProviderSerialRateLimitsResponseSchema = codexRateLimitsResponseSchema.extend({
  rateLimitsByLimitId: z.record(z.string(), z.unknown()),
});

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

export const D4_OFFICIAL_CLAUDE_PROVIDER_SERIAL_DIRECTIVE =
  'AUTH-D4-DEV:issue-222:claude-first' as const;
export const D4_OFFICIAL_CODEX_PROVIDER_SERIAL_DIRECTIVE =
  'AUTH-D4-DEV:issue-226:codex-rejoin' as const;
export const D4_OFFICIAL_PROVIDER_SERIAL_QUOTA_SCHEMA =
  'steward-d4-official-provider-serial-quota/1' as const;
export const D4_OFFICIAL_PROVIDER_SERIAL_QUOTA_VERSION = 1 as const;
export const D4_OFFICIAL_PROVIDER_SERIAL_FORECAST_BASIS =
  'observed_delta_upper_bound_single_turn' as const;
export const D4_OFFICIAL_PROVIDER_SERIAL_MODEL_TURN_COUNT = 1 as const;

const d4SingleTurnApplicableWindowIds: Readonly<Record<
  typeof D4_SMOKE_CANDIDATES[number]['modelId'],
  readonly D4SmokeQuotaWindowId[]
>> = {
  'gpt-5.6-sol': ['codex-general-weekly'],
  'gpt-5.6-terra': ['codex-general-weekly'],
  'gpt-5.6-luna': ['codex-general-weekly'],
  'gpt-5.5': ['codex-general-weekly'],
  'gpt-5.3-codex-spark': ['codex-spark'],
  'claude-fable-5': ['claude-all-model-weekly', 'claude-fable-weekly', 'claude-current-short'],
  'claude-sonnet-5': ['claude-all-model-weekly', 'claude-current-short'],
  'claude-opus-4-8': ['claude-all-model-weekly', 'claude-current-short'],
  'claude-haiku-4-5-20251001': ['claude-all-model-weekly', 'claude-current-short'],
};

const d4OfficialProviderSerialQuotaWindowSchema = z.object({
  id: nonEmptyStringSchema,
  provider: z.enum(['codex', 'claude']),
  usedPercent: percentageSchema,
  perTurnForecastAdditionalPercent: percentageSchema,
  sourceIdentity: nonEmptyStringSchema,
  forecast: z.object({
    basis: z.literal(D4_OFFICIAL_PROVIDER_SERIAL_FORECAST_BASIS),
    observedDeltaUpperBoundPercentPerModelTurn: z.number().finite().positive().max(100),
    forecastModelTurnCount: z.literal(D4_OFFICIAL_PROVIDER_SERIAL_MODEL_TURN_COUNT),
    observationCount: z.number().int().positive(),
    observedAt: isoTimestampSchema,
    sourceIdentity: nonEmptyStringSchema,
  }).strict(),
}).strict();

const d4OfficialProviderSerialQuotaPhaseSchema = z.object({
  kind: z.literal('provider_serial_dispatch'),
  executionId: nonEmptyStringSchema,
  decisionIndex: z.number().int().min(0).max(D4_SMOKE_DECISION_COUNT - 1),
  wakeId: nonEmptyStringSchema,
}).strict();

/** Official single-dispatch evidence for a maintainer-ordered provider-serial
 * schedule. Its schema/purpose/target fields are intentionally incompatible
 * with engineering shakedown quota evidence. */
export const d4OfficialProviderSerialQuotaEvidenceSchema = z.object({
  schema: z.literal(D4_OFFICIAL_PROVIDER_SERIAL_QUOTA_SCHEMA),
  version: z.literal(D4_OFFICIAL_PROVIDER_SERIAL_QUOTA_VERSION),
  purpose: z.literal('official_smoke'),
  scheduleMode: z.literal('provider_serial'),
  schedulingDirective: z.union([
    z.literal(D4_OFFICIAL_CLAUDE_PROVIDER_SERIAL_DIRECTIVE),
    z.literal(D4_OFFICIAL_CODEX_PROVIDER_SERIAL_DIRECTIVE),
  ]),
  manifestSha256: sha256Schema,
  provider: z.enum(['codex', 'claude']),
  phase: d4OfficialProviderSerialQuotaPhaseSchema,
  capturedAt: isoTimestampSchema,
  validUntil: isoTimestampSchema,
  officialTargetExecutionCount: z.literal(D4_SMOKE_EXECUTION_COUNT),
  officialTargetModelTurnCount: z.literal(D4_SMOKE_MODEL_TURN_COUNT),
  forecastModelTurnCount: z.literal(D4_OFFICIAL_PROVIDER_SERIAL_MODEL_TURN_COUNT),
  cost: z.object({
    actualIncrementalSpendUsd: z.literal(0),
    forecastIncrementalSpendUsd: z.literal(0),
    subscriptionQuota: z.object({
      windows: z.array(d4OfficialProviderSerialQuotaWindowSchema),
    }).strict(),
    shadowApiEquivalent: z.discriminatedUnion('status', [
      z.object({ status: z.literal('unknown'), amountUsd: z.null() }).strict(),
      z.object({ status: z.literal('estimated'), amountUsd: z.number().finite().nonnegative() }).strict(),
    ]),
  }).strict(),
}).strict().superRefine((evidence, context) => {
  const expected = evidence.provider === 'codex'
    ? D4_OFFICIAL_CODEX_PROVIDER_SERIAL_DIRECTIVE
    : D4_OFFICIAL_CLAUDE_PROVIDER_SERIAL_DIRECTIVE;
  if (evidence.schedulingDirective !== expected) {
    context.addIssue({
      code: 'custom',
      path: ['schedulingDirective'],
      message: `${evidence.provider} evidence requires ${expected}`,
    });
  }
});

export type D4OfficialProviderSerialQuotaEvidence = z.infer<
  typeof d4OfficialProviderSerialQuotaEvidenceSchema
>;
export type D4OfficialProviderSerialQuotaPhase = D4OfficialProviderSerialQuotaEvidence['phase'];
export type D4OfficialProviderSerialQuotaReader = (
  phase: D4OfficialProviderSerialQuotaPhase,
  plan: D4SmokeExecutionPlan,
) => Promise<unknown>;

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
  readonly claudeRuntime: D4SmokeClaudeNativeRuntime | null;
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
  readonly expectedClaudeRuntimeVersion?: string;
  readonly resolveClaudeRuntime?: (expectedVersion: string) => Promise<D4SmokeClaudeNativeRuntime>;
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
  const claudeRuntime = input.expectedClaudeRuntimeVersion === undefined
    ? null
    : await (input.resolveClaudeRuntime ?? resolveD4ClaudeNativeRuntime)(
        input.expectedClaudeRuntimeVersion,
      );
  if (claudeRuntime !== null) {
    await assertD4ClaudeNativeRuntimeIdentity(claudeRuntime, input.expectedClaudeRuntimeVersion!);
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
    async (context) => {
      if (claudeRuntime !== null) {
        await assertD4ClaudeNativeRuntimeIdentity(claudeRuntime, claudeRuntime.version);
      }
      return input.readClaude?.(context) ?? readNativeClaudeQuota(context, claudeRuntime ?? undefined);
    },
  );
  readD4SmokeLiveQuotaWindows(codexRaw, claudeRaw);
  return {
    capturedAt: (input.now ?? (() => new Date()))(),
    codexRaw,
    claudeRaw,
    codexRuntime,
    claudeRuntime,
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
      if (snapshot.claudeRuntime === null) {
        throw new D4SmokePolicyError(
          'model_binding_invalid',
          'Claude dispatch quota reader is missing the preflight runtime attestation',
        );
      }
      await assertD4ClaudeNativeRuntimeIdentity(snapshot.claudeRuntime, plan.candidate.runtimeVersion);
      liveUsed = readD4SmokeClaudeQuotaWindows(await readNativeClaudeQuota(context, snapshot.claudeRuntime));
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

async function readNativeClaudeQuota(
  controlContext: D4SmokeNativeQuotaControlContext,
  runtime?: D4SmokeClaudeNativeRuntime,
): Promise<unknown> {
  if (runtime !== undefined) {
    await assertD4ClaudeNativeRuntimeIdentity(runtime, runtime.version);
  }
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
      ...(runtime === undefined ? {} : { pathToClaudeCodeExecutable: runtime.executable }),
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

function forecastD4SingleTurnPercent(bound: {
  readonly observedDeltaUpperBoundPercentPerModelTurn: number;
}): number {
  const value = bound.observedDeltaUpperBoundPercentPerModelTurn;
  if (!Number.isFinite(value) || value <= 0) {
    throw new D4SmokeQuotaError(
      'incomplete',
      'reliable observed delta upper bound per model turn is required; zero or guessed deltas are not admissible',
    );
  }
  return Math.min(100, value);
}

function d4SingleTurnApplicableWindows(modelId: string): {
  readonly candidate: D4SmokeCandidate;
  readonly windows: readonly typeof D4_SMOKE_QUOTA_WINDOWS[number][];
} {
  const candidate = D4_SMOKE_CANDIDATES.find((item) => item.modelId === modelId);
  const applicable = (d4SingleTurnApplicableWindowIds as Record<
    string,
    readonly D4SmokeQuotaWindowId[]
  >)[modelId];
  if (candidate === undefined || applicable === undefined) {
    throw new D4SmokeQuotaError('invalid', `${modelId} is not a frozen D4 candidate`);
  }
  const windows = applicable.map((id) => {
    const descriptor = D4_SMOKE_QUOTA_WINDOWS.find((window) => window.id === id);
    if (descriptor === undefined || descriptor.provider !== candidate.provider) {
      throw new D4SmokeQuotaError(
        'invalid',
        `${modelId}: applicable window ${id} is not a ${candidate.provider} window`,
      );
    }
    return descriptor;
  });
  return { candidate, windows };
}

function d4OfficialProviderApplicableWindows<Provider extends D4SmokeCandidate['provider']>(
  modelId: string,
  provider: Provider,
): {
  readonly candidate: D4SmokeCandidate & { readonly provider: Provider };
  readonly windows: readonly typeof D4_SMOKE_QUOTA_WINDOWS[number][];
} {
  const { candidate, windows } = d4SingleTurnApplicableWindows(modelId);
  if (candidate.provider !== provider) {
    const schedule = provider === 'claude' ? 'Claude-first' : 'Codex';
    throw new D4SmokePolicyError(
      'model_binding_invalid',
      `${modelId}: ${schedule} official scheduling forbids ${candidate.provider}`,
    );
  }
  return {
    candidate: candidate as D4SmokeCandidate & { readonly provider: Provider },
    windows,
  };
}

function d4OfficialClaudeApplicableWindows(modelId: string) {
  return d4OfficialProviderApplicableWindows(modelId, 'claude');
}

function d4OfficialCodexApplicableWindows(modelId: string) {
  return d4OfficialProviderApplicableWindows(modelId, 'codex');
}

function d4OfficialProviderSerialDirective(provider: D4SmokeCandidate['provider']) {
  return provider === 'codex'
    ? D4_OFFICIAL_CODEX_PROVIDER_SERIAL_DIRECTIVE
    : D4_OFFICIAL_CLAUDE_PROVIDER_SERIAL_DIRECTIVE;
}

export function validateD4OfficialProviderSerialQuotaEvidence(input: {
  readonly evidence: unknown;
  readonly manifestSha256: string;
  readonly phase: D4OfficialProviderSerialQuotaPhase;
  readonly modelId: string;
  readonly now: Date;
}): D4OfficialProviderSerialQuotaEvidence {
  const parsed = d4OfficialProviderSerialQuotaEvidenceSchema.safeParse(input.evidence);
  if (!parsed.success) {
    throw new D4SmokeQuotaError('invalid', formatZodIssues(parsed.error));
  }
  const evidence = parsed.data;
  const { candidate, windows: applicable } = d4SingleTurnApplicableWindows(input.modelId);
  const expectedDirective = d4OfficialProviderSerialDirective(candidate.provider);
  if (evidence.provider !== candidate.provider || evidence.schedulingDirective !== expectedDirective) {
    throw new D4SmokeQuotaError(
      'invalid',
      `${input.modelId} requires ${candidate.provider} evidence under ${expectedDirective}`,
    );
  }
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
  const expectedIdentities = applicable.map(({ id }) => ({ id, provider: candidate.provider }));
  const identities = evidence.cost.subscriptionQuota.windows.map(({ id, provider }) => ({ id, provider }));
  if (JSON.stringify(identities) !== JSON.stringify(expectedIdentities)) {
    throw new D4SmokeQuotaError(
      'incomplete',
      `${input.modelId} requires exactly [${applicable.map(({ id }) => id).join(',')}] in canonical order`,
    );
  }
  for (const window of evidence.cost.subscriptionQuota.windows) {
    if (Date.parse(window.forecast.observedAt) > Date.parse(evidence.capturedAt)) {
      throw new D4SmokeQuotaError('invalid', `${window.id} observed upper bound is from the future`);
    }
    const expectedPerTurn = forecastD4SingleTurnPercent(window.forecast);
    if (Math.abs(window.perTurnForecastAdditionalPercent - expectedPerTurn) > 1e-12) {
      throw new D4SmokeQuotaError(
        'invalid',
        `${window.id} single-turn forecast must derive from its observed delta upper bound`,
      );
    }
    const projected = window.usedPercent + window.perTurnForecastAdditionalPercent;
    if (projected >= 80) {
      throw new D4SmokeQuotaError(
        'reserve_exhausted',
        `${window.id} projects ${projected}% used; 20% reserve requires less than 80%`,
      );
    }
  }
  return evidence;
}

function buildD4OfficialProviderSerialEvidenceFromUsed(input: {
  readonly phase: D4OfficialProviderSerialQuotaPhase;
  readonly plan: D4SmokeExecutionPlan;
  readonly liveUsed: Readonly<Partial<Record<D4SmokeQuotaWindowId, number>>>;
  readonly forecastBounds: D4SmokeQuotaForecastBounds;
  readonly captured: Date;
  readonly validityMs: number;
}): D4OfficialProviderSerialQuotaEvidence {
  const { candidate, windows: applicable } = d4SingleTurnApplicableWindows(input.plan.candidate.modelId);
  const windows = applicable.map(({ id }) => {
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
      provider: candidate.provider,
      usedPercent,
      perTurnForecastAdditionalPercent: forecastD4SingleTurnPercent(bound),
      sourceIdentity: candidate.provider === 'codex'
        ? `codex:account/rateLimits/read:${id === 'codex-spark' ? 'codex_bengalfox' : 'codex'}`
        : `claude:usage-control:${id}`,
      forecast: {
        basis: D4_OFFICIAL_PROVIDER_SERIAL_FORECAST_BASIS,
        observedDeltaUpperBoundPercentPerModelTurn: bound.observedDeltaUpperBoundPercentPerModelTurn,
        forecastModelTurnCount: D4_OFFICIAL_PROVIDER_SERIAL_MODEL_TURN_COUNT,
        observationCount: bound.observationCount,
        observedAt: bound.observedAt,
        sourceIdentity: bound.sourceIdentity,
      },
    };
  });
  const evidence = {
    schema: D4_OFFICIAL_PROVIDER_SERIAL_QUOTA_SCHEMA,
    version: D4_OFFICIAL_PROVIDER_SERIAL_QUOTA_VERSION,
    purpose: 'official_smoke' as const,
    scheduleMode: 'provider_serial' as const,
    schedulingDirective: d4OfficialProviderSerialDirective(candidate.provider),
    manifestSha256: input.plan.manifestSha256,
    provider: candidate.provider,
    phase: input.phase,
    capturedAt: input.captured.toISOString(),
    validUntil: new Date(input.captured.getTime() + input.validityMs).toISOString(),
    officialTargetExecutionCount: D4_SMOKE_EXECUTION_COUNT,
    officialTargetModelTurnCount: D4_SMOKE_MODEL_TURN_COUNT,
    forecastModelTurnCount: D4_OFFICIAL_PROVIDER_SERIAL_MODEL_TURN_COUNT,
    cost: {
      actualIncrementalSpendUsd: 0 as const,
      forecastIncrementalSpendUsd: 0 as const,
      subscriptionQuota: { windows },
      shadowApiEquivalent: { status: 'unknown' as const, amountUsd: null },
    },
  };
  return validateD4OfficialProviderSerialQuotaEvidence({
    evidence,
    manifestSha256: input.plan.manifestSha256,
    phase: input.phase,
    modelId: input.plan.candidate.modelId,
    now: input.captured,
  });
}

/** Claude-only native reader for the maintainer-ordered official schedule.
 * Its API has no Codex runtime/control and therefore cannot read or consume a
 * Codex reset credit. */
export function createD4OfficialClaudeProviderSerialNativeQuotaReader(options: {
  readonly forecastBounds: D4SmokeQuotaForecastBounds;
  readonly claudeRuntime: D4SmokeClaudeNativeRuntime;
  readonly readClaude?: D4SmokeNativeQuotaProbe;
  readonly now?: () => Date;
  readonly validityMs?: number;
}): D4OfficialProviderSerialQuotaReader {
  const now = options.now ?? (() => new Date());
  const validityMs = options.validityMs ?? 60_000;
  if (!Number.isInteger(validityMs) || validityMs <= 0) {
    throw new D4SmokeQuotaError('invalid', 'official provider-serial quota validityMs must be positive');
  }
  return async (phase, plan) => {
    d4OfficialClaudeApplicableWindows(plan.candidate.modelId);
    await assertD4ClaudeNativeRuntimeIdentity(options.claudeRuntime, plan.candidate.runtimeVersion);
    const captured = now();
    const context = { cwd: plan.paths.workspace, env: plan.env };
    const raw = options.readClaude?.(context)
      ?? readNativeClaudeQuota(context, options.claudeRuntime);
    const liveUsed = readD4SmokeClaudeQuotaWindows(await raw);
    return buildD4OfficialProviderSerialEvidenceFromUsed({
      phase,
      plan,
      liveUsed,
      forecastBounds: options.forecastBounds,
      captured,
      validityMs,
    });
  };
}

/** Codex-only native reader for the maintainer-ordered official rejoin. Its
 * callable surface can only perform the read-only rate-limit method. */
export function createD4OfficialCodexProviderSerialNativeQuotaReader(options: {
  readonly forecastBounds: D4SmokeQuotaForecastBounds;
  readonly codexRuntime: D4SmokeCodexNativeRuntime;
  readonly codexControl?: D4SmokeCodexQuotaControl;
  readonly now?: () => Date;
  readonly validityMs?: number;
}): D4OfficialProviderSerialQuotaReader {
  const now = options.now ?? (() => new Date());
  const validityMs = options.validityMs ?? 60_000;
  if (!Number.isInteger(validityMs) || validityMs <= 0) {
    throw new D4SmokeQuotaError('invalid', 'official provider-serial quota validityMs must be positive');
  }
  return async (phase, plan) => {
    const { windows } = d4OfficialCodexApplicableWindows(plan.candidate.modelId);
    if (windows.length !== 1) {
      throw new D4SmokeQuotaError(
        'invalid',
        `${plan.candidate.modelId} must bind exactly one Codex quota window`,
      );
    }
    await assertD4CodexNativeRuntimeIdentity(options.codexRuntime, plan.candidate.runtimeVersion);
    const captured = now();
    const context = { cwd: plan.paths.workspace, env: plan.env };
    const raw = options.codexControl !== undefined
      ? await options.codexControl.request('account/rateLimits/read', null)
      : await readNativeCodexQuota(
          options.codexRuntime.executable,
          'account/rateLimits/read',
          null,
          context,
        );
    const windowId = windows[0]!.id;
    const liveUsed = readD4SmokeApplicableCodexQuotaWindow(raw, windowId);
    return buildD4OfficialProviderSerialEvidenceFromUsed({
      phase,
      plan,
      liveUsed,
      forecastBounds: options.forecastBounds,
      captured,
      validityMs,
    });
  };
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

function readD4SmokeApplicableCodexQuotaWindow(
  codexRaw: unknown,
  windowId: D4SmokeQuotaWindowId,
): Readonly<Partial<Record<D4SmokeQuotaWindowId, number>>> {
  const limitId = windowId === 'codex-general-weekly'
    ? 'codex'
    : windowId === 'codex-spark'
      ? 'codex_bengalfox'
      : null;
  if (limitId === null) {
    throw new D4SmokeQuotaError('invalid', `${windowId} is not a Codex quota window`);
  }
  const codex = codexProviderSerialRateLimitsResponseSchema.safeParse(codexRaw);
  if (!codex.success) {
    throw new D4SmokeQuotaError('invalid', `Codex subscription quota response: ${formatZodIssues(codex.error)}`);
  }
  return { [windowId]: readD4SmokeProviderSerialCodexQuotaBucket(codex.data, limitId) };
}

function readD4SmokeProviderSerialCodexQuotaBucket(
  response: z.infer<typeof codexProviderSerialRateLimitsResponseSchema>,
  limitId: 'codex' | 'codex_bengalfox',
): number {
  const rawBucket = response.rateLimitsByLimitId[limitId];
  if (rawBucket === undefined) {
    throw new D4SmokeQuotaError('incomplete', `Codex ${limitId} quota bucket is required by exact key`);
  }
  const parsed = codexProviderSerialRateLimitSnapshotSchema.safeParse(rawBucket);
  if (!parsed.success) {
    throw new D4SmokeQuotaError(
      'invalid',
      `Codex ${limitId} quota bucket: ${formatZodIssues(parsed.error)}`,
    );
  }
  if (parsed.data.limitId !== limitId) {
    throw new D4SmokeQuotaError(
      'incomplete',
      `Codex ${limitId} quota bucket reported ${parsed.data.limitId}`,
    );
  }
  const credits = parsed.data.credits;
  if (credits !== null && (credits.hasCredits || credits.unlimited || !['0', null].includes(credits.balance))) {
    throw new D4SmokeQuotaError('invalid', `${limitId} exposes credits/overage`);
  }
  if (parsed.data.individualLimit !== null) {
    throw new D4SmokeQuotaError('invalid', `${limitId} exposes metered spend control`);
  }
  return parsed.data.primary.usedPercent;
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
  /** Private host-side Claude bridge directory; it is not a candidate write root. */
  readonly claudeBridgeTempDir: string;
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
          env: sandboxEnv(paths, candidate.provider),
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
    if (JSON.stringify(plan.env) !== JSON.stringify(sandboxEnv(expectedPaths, plan.candidate.provider))) {
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
  /** Production passes the exact version-managed Claude executable here,
   * instead of accepting the host-global `claude` launcher. */
  readonly claudeRuntime?: D4SmokeClaudeNativeRuntime;
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
      : options.claudeRuntime?.executable ?? options.claudeBin ?? 'claude';
    if (binding.provider === 'claude' && options.claudeRuntime !== undefined) {
      await assertD4ClaudeNativeRuntimeIdentity(options.claudeRuntime, binding.runtimeVersion);
    }
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

export interface D4OfficialClaudeProviderSerialExecutionResult {
  readonly executionId: string;
  readonly status: 'valid' | 'invalid';
  readonly reports: readonly StewardWakeEvaluationReport[];
  readonly modelAttestations: readonly D4OfficialClaudeTurnModelAttestation[];
  readonly scheduling: {
    readonly mode: 'provider_serial';
    readonly activeProvider: 'claude';
    readonly directive: typeof D4_OFFICIAL_CLAUDE_PROVIDER_SERIAL_DIRECTIVE;
    readonly pending: readonly [{
      readonly provider: 'codex';
      readonly status: 'pending';
      readonly reason: 'maintainer_scheduled_later';
      readonly inferentialOutcome: false;
    }];
  };
  readonly quotaEvidence: {
    readonly dispatches: readonly D4OfficialProviderSerialQuotaEvidence[];
  };
  readonly credential: D4SmokeCredentialReceipt;
  readonly capabilityAttempts: readonly D4SmokeCapabilityAttempt[];
}

export interface D4OfficialCodexProviderSerialExecutionResult {
  readonly executionId: string;
  readonly status: 'valid' | 'invalid';
  readonly reports: readonly StewardWakeEvaluationReport[];
  readonly scheduling: {
    readonly mode: 'provider_serial';
    readonly activeProvider: 'codex';
    readonly directive: typeof D4_OFFICIAL_CODEX_PROVIDER_SERIAL_DIRECTIVE;
    readonly pending: readonly [{
      readonly provider: 'claude';
      readonly status: 'quota_paused';
      readonly reason: 'provider_quota_reserve';
      readonly inferentialOutcome: false;
    }];
  };
  readonly quotaEvidence: {
    readonly dispatches: readonly D4OfficialProviderSerialQuotaEvidence[];
  };
  readonly credential: D4SmokeCredentialReceipt;
  readonly capabilityAttempts: readonly D4SmokeCapabilityAttempt[];
}

export interface D4OfficialClaudeTurnModelAttestation {
  readonly decisionIndex: number;
  readonly wakeId: string;
  readonly roles: D4ModelRoleAttestation;
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

export interface D4OfficialClaudeProviderSerialExecutionInput extends Omit<
  D4SmokeExecutionInput,
  'quotaReader' | 'codexRuntime'
> {
  readonly quotaReader: D4OfficialProviderSerialQuotaReader;
}

export interface D4OfficialCodexProviderSerialExecutionInput extends Omit<
  D4SmokeExecutionInput,
  'quotaReader' | 'codexRuntime'
> {
  readonly quotaReader: D4OfficialProviderSerialQuotaReader;
  readonly codexRuntime: D4SmokeCodexNativeRuntime;
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

export type D4OfficialClaudeProviderSerialFilesystemExecutionInput = D4SmokeFilesystemExecutionInput;
export type D4OfficialCodexProviderSerialFilesystemExecutionInput = D4SmokeFilesystemExecutionInput;

type D4SmokeExecutionCoreInput = Omit<D4SmokeExecutionInput, 'quotaReader'>;

interface D4SmokeFullLayerAdmission {
  readonly mode: 'full_layer';
  readonly quotaReader: D4SmokeQuotaReader;
}

interface D4SmokeClaudeProviderSerialAdmission {
  readonly mode: 'claude_provider_serial';
  readonly quotaReader: D4OfficialProviderSerialQuotaReader;
}

interface D4SmokeCodexProviderSerialAdmission {
  readonly mode: 'codex_provider_serial';
  readonly quotaReader: D4OfficialProviderSerialQuotaReader;
}

type D4SmokeExecutionAdmission =
  | D4SmokeFullLayerAdmission
  | D4SmokeClaudeProviderSerialAdmission
  | D4SmokeCodexProviderSerialAdmission;

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

function frozenD4SmokeClaudeRuntimeVersion(): string {
  const versions = new Set(
    D4_SMOKE_CANDIDATES
      .filter((candidate) => candidate.provider === 'claude')
      .map((candidate) => candidate.runtimeVersion),
  );
  if (versions.size !== 1) {
    throw new D4SmokePolicyError(
      'model_binding_invalid',
      `D4 Claude matrix must freeze one runtime version, found ${[...versions].join(',')}`,
    );
  }
  return [...versions][0]!;
}

function assertD4SmokeProductionInput(input: unknown): void {
  const rawInput = input as Record<string, unknown>;
  const forbidden = D4_SMOKE_PRODUCTION_SEAMS.filter((key) =>
    Object.prototype.hasOwnProperty.call(rawInput, key));
  if (forbidden.length > 0) {
    throw new D4SmokePolicyError(
      'production_seam_forbidden',
      `watchdog entrypoint does not accept ${forbidden.join(',')}`,
    );
  }
}

/** Watchdog-facing, single-execution production entrypoint. */
export async function runD4SmokeFilesystemExecution(
  input: D4SmokeFilesystemExecutionInput,
): Promise<D4SmokeExecutionResult> {
  assertD4SmokeProductionInput(input);
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
    expectedClaudeRuntimeVersion: frozenD4SmokeClaudeRuntimeVersion(),
  });
  if (preflightQuota.codexRuntime === null) {
    throw new D4SmokePolicyError('model_binding_invalid', 'production preflight did not pin Codex');
  }
  if (preflightQuota.claudeRuntime === null) {
    throw new D4SmokePolicyError('model_binding_invalid', 'production preflight did not pin Claude Code');
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
    driverFactory: createD4SmokeNativeDriverFactory({ claudeRuntime: preflightQuota.claudeRuntime }),
    codexRuntime: preflightQuota.codexRuntime,
    bootstrapWorkspace: adapter.bootstrapWorkspace,
    prepareDecision: adapter.prepareDecision,
    readTerminalArtifact: adapter.readTerminalArtifact,
    auditLedger: new D4SmokeCapabilityAuditLedger(),
    deadlineMs: input.deadlineMs,
  });
}

/** Watchdog-facing Claude-first official entrypoint. It resolves, copies, and
 * reads only Claude runtime state; Codex remains a non-inferential pending
 * provider until a later maintainer directive. */
export async function runD4OfficialClaudeProviderSerialFilesystemExecution(
  input: D4OfficialClaudeProviderSerialFilesystemExecutionInput,
): Promise<D4OfficialClaudeProviderSerialExecutionResult> {
  assertD4SmokeProductionInput(input);
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
  d4OfficialClaudeApplicableWindows(plan.candidate.modelId);
  const forecastBounds = deriveD4SmokeQuotaForecastBounds({ stage, contentByRef: input.contentByRef });
  const canonical = defaultD4SmokeCanonicalCredentialPaths();
  const claudeRuntime = await resolveD4ClaudeNativeRuntime(frozenD4SmokeClaudeRuntimeVersion());
  const adapter = createD4SmokeFilesystemWorkspaceAdapter(input.filesystemAdapterOptions);
  const claudeCredential = D4_SMOKE_CREDENTIAL_SOURCES.find(({ provider }) => provider === 'claude')!;
  return runD4OfficialClaudeProviderSerialExecution({
    manifestBytes: input.manifestBytes,
    receipt: input.receipt,
    repoRoot: D4_REPO_ROOT,
    contentByRef: input.contentByRef,
    sandboxBase: input.sandboxBase,
    executionId: input.executionId,
    credentialSources: [{ ...claudeCredential, sourcePath: canonical.claude }],
    canonicalCredentialPaths: canonical,
    quotaReader: createD4OfficialClaudeProviderSerialNativeQuotaReader({
      forecastBounds,
      claudeRuntime,
    }),
    driverFactory: createD4SmokeNativeDriverFactory({ claudeRuntime }),
    bootstrapWorkspace: adapter.bootstrapWorkspace,
    prepareDecision: adapter.prepareDecision,
    readTerminalArtifact: adapter.readTerminalArtifact,
    auditLedger: new D4SmokeCapabilityAuditLedger(),
    deadlineMs: input.deadlineMs,
  });
}

/** Watchdog-facing Codex rejoin entrypoint. It resolves, copies, and reads only
 * Codex runtime state; the Claude credential path remains a deny-only outer
 * isolation identity. */
export async function runD4OfficialCodexProviderSerialFilesystemExecution(
  input: D4OfficialCodexProviderSerialFilesystemExecutionInput,
): Promise<D4OfficialCodexProviderSerialExecutionResult> {
  assertD4SmokeProductionInput(input);
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
  d4OfficialCodexApplicableWindows(plan.candidate.modelId);
  const forecastBounds = deriveD4SmokeQuotaForecastBounds({ stage, contentByRef: input.contentByRef });
  const canonical = defaultD4SmokeCanonicalCredentialPaths();
  const codexRuntime = await resolveD4CodexNativeRuntime(frozenD4SmokeCodexRuntimeVersion());
  const adapter = createD4SmokeFilesystemWorkspaceAdapter(input.filesystemAdapterOptions);
  const codexCredential = D4_SMOKE_CREDENTIAL_SOURCES.find(({ provider }) => provider === 'codex')!;
  return runD4OfficialCodexProviderSerialExecution({
    manifestBytes: input.manifestBytes,
    receipt: input.receipt,
    repoRoot: D4_REPO_ROOT,
    contentByRef: input.contentByRef,
    sandboxBase: input.sandboxBase,
    executionId: input.executionId,
    credentialSources: [{ ...codexCredential, sourcePath: canonical.codex }],
    canonicalCredentialPaths: canonical,
    quotaReader: createD4OfficialCodexProviderSerialNativeQuotaReader({
      forecastBounds,
      codexRuntime,
    }),
    driverFactory: createD4SmokeNativeDriverFactory(),
    codexRuntime,
    bootstrapWorkspace: adapter.bootstrapWorkspace,
    prepareDecision: adapter.prepareDecision,
    readTerminalArtifact: adapter.readTerminalArtifact,
    auditLedger: new D4SmokeCapabilityAuditLedger(),
    deadlineMs: input.deadlineMs,
  });
}

export async function runD4SmokeExecution(input: D4SmokeExecutionInput): Promise<D4SmokeExecutionResult> {
  return runD4SmokeExecutionCore(input, { mode: 'full_layer', quotaReader: input.quotaReader });
}

export async function runD4OfficialClaudeProviderSerialExecution(
  input: D4OfficialClaudeProviderSerialExecutionInput,
): Promise<D4OfficialClaudeProviderSerialExecutionResult> {
  return runD4SmokeExecutionCore(input, {
    mode: 'claude_provider_serial',
    quotaReader: input.quotaReader,
  });
}

export async function runD4OfficialCodexProviderSerialExecution(
  input: D4OfficialCodexProviderSerialExecutionInput,
): Promise<D4OfficialCodexProviderSerialExecutionResult> {
  return runD4SmokeExecutionCore(input, {
    mode: 'codex_provider_serial',
    quotaReader: input.quotaReader,
  });
}

function runD4SmokeExecutionCore(
  input: D4SmokeExecutionCoreInput,
  admission: D4SmokeFullLayerAdmission,
): Promise<D4SmokeExecutionResult>;
function runD4SmokeExecutionCore(
  input: D4SmokeExecutionCoreInput,
  admission: D4SmokeClaudeProviderSerialAdmission,
): Promise<D4OfficialClaudeProviderSerialExecutionResult>;
function runD4SmokeExecutionCore(
  input: D4SmokeExecutionCoreInput,
  admission: D4SmokeCodexProviderSerialAdmission,
): Promise<D4OfficialCodexProviderSerialExecutionResult>;
async function runD4SmokeExecutionCore(
  input: D4SmokeExecutionCoreInput,
  admission: D4SmokeExecutionAdmission,
): Promise<
  D4SmokeExecutionResult
  | D4OfficialClaudeProviderSerialExecutionResult
  | D4OfficialCodexProviderSerialExecutionResult
> {
  const now = input.now ?? (() => new Date());
  const stage = await validateD4SmokeStage(input);
  const plans = planD4SmokeExecutions(stage, input.sandboxBase);
  const plan = plans.find((candidate) => candidate.executionId === input.executionId);
  if (plan === undefined) {
    throw new D4SmokePlanError('coverage_invalid', `unknown execution ${input.executionId}`);
  }
  if (admission.mode === 'claude_provider_serial') {
    d4OfficialClaudeApplicableWindows(plan.candidate.modelId);
  } else if (admission.mode === 'codex_provider_serial') {
    d4OfficialCodexApplicableWindows(plan.candidate.modelId);
  }
  const source = selectCredentialSource(plan.candidate.provider, input.credentialSources);
  input.auditLedger.assertZero();
  const forbiddenBoundaries = createD4SmokeForbiddenCapabilityBoundaries(input.auditLedger, now);
  let admissionQuota: D4SmokeQuotaEvidence | null = null;
  if (admission.mode === 'full_layer') {
    const admissionPhase = { kind: 'layer_admission' } as const;
    admissionQuota = validateD4SmokeQuotaEvidence({
      evidence: await admission.quotaReader(admissionPhase, plan),
      manifestSha256: stage.manifestSha256,
      phase: admissionPhase,
      now: now(),
    });
  }

  await createFreshSandbox(plan.paths, plan.candidate.provider);
  let auditCursor: D4SmokeAuditCursor | null = null;
  const canonicalPaths = input.canonicalCredentialPaths ?? defaultD4SmokeCanonicalCredentialPaths();
  let credential: CredentialGuard;
  try {
    credential = await copyCredentialIntoSandbox(plan, source, canonicalPaths);
  } catch (error) {
    await releaseD4ClaudeBridgeTemp(plan.paths, plan.candidate.provider).catch(() => undefined);
    throw error;
  }

  let driver: StewardMachineDriver | null = null;
  const reports: StewardWakeEvaluationReport[] = [];
  const officialClaudeModelAttestations: D4OfficialClaudeTurnModelAttestation[] = [];
  const dispatchQuotaEvidence: D4SmokeQuotaEvidence[] = [];
  const providerSerialQuotaEvidence: D4OfficialProviderSerialQuotaEvidence[] = [];
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
      if (admission.mode === 'full_layer') {
        const dispatchPhase = {
          kind: 'dispatch',
          executionId: plan.executionId,
          decisionIndex,
          wakeId,
        } as const;
        dispatchQuotaEvidence.push(validateD4SmokeQuotaEvidence({
          evidence: await admission.quotaReader(dispatchPhase, plan),
          manifestSha256: stage.manifestSha256,
          phase: dispatchPhase,
          provider: plan.candidate.provider,
          now: now(),
        }));
      } else {
        const dispatchPhase = {
          kind: 'provider_serial_dispatch',
          executionId: plan.executionId,
          decisionIndex,
          wakeId,
        } as const;
        providerSerialQuotaEvidence.push(validateD4OfficialProviderSerialQuotaEvidence({
          evidence: await admission.quotaReader(dispatchPhase, plan),
          manifestSha256: stage.manifestSha256,
          phase: dispatchPhase,
          modelId: plan.candidate.modelId,
          now: now(),
        }));
      }
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
      const officialClaudeModelAttestation = admission.mode === 'claude_provider_serial'
        ? attestD4ModelRoles({
            outcome,
            provider: 'claude',
            requestedModelId: plan.candidate.modelId,
            wakeId,
          })
        : null;
      if (officialClaudeModelAttestation === null) {
        assertD4ActualModelIds(outcome.actualModelIds, plan.candidate.modelId, wakeId);
      } else {
        assertD4ModelRoleEvidence(officialClaudeModelAttestation, wakeId);
        assertD4SuccessfulModelRoles({
          attestation: officialClaudeModelAttestation,
          provider: 'claude',
          requestedModelId: plan.candidate.modelId,
          wakeId,
        });
      }
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
      if (officialClaudeModelAttestation !== null) {
        officialClaudeModelAttestations.push({
          decisionIndex,
          wakeId,
          roles: officialClaudeModelAttestation,
        });
      }
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
        await releaseD4ClaudeBridgeTemp(plan.paths, plan.candidate.provider);
      } catch (error) {
        cleanupError ??= error;
      }
      try {
        await releaseD4SmokeRuntimeForHost(plan.paths);
      } catch (error) {
        cleanupError ??= error;
      }
    }
    executionError ??= cleanupError;
  }
  if (executionError !== undefined) throw executionError;

  const common = {
    executionId: plan.executionId,
    status: reports.every((report) => report.protocol.verdict === 'pass' && report.decision.verdict === 'pass')
      ? 'valid' as const
      : 'invalid' as const,
    reports,
    credential: credential.receipt(),
    capabilityAttempts: input.auditLedger.snapshot(),
  };
  if (admission.mode === 'claude_provider_serial') {
    return {
      ...common,
      modelAttestations: officialClaudeModelAttestations,
      scheduling: {
        mode: 'provider_serial',
        activeProvider: 'claude',
        directive: D4_OFFICIAL_CLAUDE_PROVIDER_SERIAL_DIRECTIVE,
        pending: [{
          provider: 'codex',
          status: 'pending',
          reason: 'maintainer_scheduled_later',
          inferentialOutcome: false,
        }],
      },
      quotaEvidence: { dispatches: providerSerialQuotaEvidence },
    };
  }
  if (admission.mode === 'codex_provider_serial') {
    return {
      ...common,
      scheduling: {
        mode: 'provider_serial',
        activeProvider: 'codex',
        directive: D4_OFFICIAL_CODEX_PROVIDER_SERIAL_DIRECTIVE,
        pending: [{
          provider: 'claude',
          status: 'quota_paused',
          reason: 'provider_quota_reserve',
          inferentialOutcome: false,
        }],
      },
      quotaEvidence: { dispatches: providerSerialQuotaEvidence },
    };
  }
  return {
    ...common,
    quotaEvidence: {
      layerAdmission: admissionQuota!,
      dispatches: dispatchQuotaEvidence,
    },
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
    claudeBridgeTempDir: d4ClaudeBridgeTempDir(root),
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

function d4ClaudeBridgeTempDir(root: string): string {
  const digest = createHash('sha256').update(root).digest('hex').slice(0, 16);
  return join(resolve(tmpdir()), `${D4_CLAUDE_BRIDGE_TMP_PREFIX}${digest}`);
}

function d4ClaudeEffectiveBashTempDir(directory: string): string {
  return join(directory, `claude-${process.getuid?.() ?? 0}`);
}

function assertD4ClaudeBridgeTempDirFits(directory: string): void {
  const effectiveDirectory = d4ClaudeEffectiveBashTempDir(directory);
  if (
    Buffer.byteLength(effectiveDirectory) > D4_CLAUDE_EFFECTIVE_TMP_MAX_BYTES
    || Buffer.byteLength(effectiveDirectory) + D4_CLAUDE_BRIDGE_SOCKET_SUFFIX_RESERVE_BYTES
    > D4_CLAUDE_BRIDGE_SOCKET_PATH_MAX_BYTES
  ) {
    throw new D4SmokePlanError('shared_writable_root', 'Claude effective Bash bridge temp directory exceeds native socket budget');
  }
}

function sandboxEnv(
  paths: D4SmokeSandboxPaths,
  provider: D4SmokeCandidate['provider'],
): Readonly<Record<string, string>> {
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
  if (provider === 'claude') {
    assertD4ClaudeBridgeTempDirFits(paths.claudeBridgeTempDir);
    env.CLAUDE_CODE_TMPDIR = paths.claudeBridgeTempDir;
    // The pinned native bridge uses os.tmpdir(), which honors TMPDIR rather
    // than CLAUDE_CODE_TMPDIR, before bwrap starts the sandboxed command.
    env.TMPDIR = paths.claudeBridgeTempDir;
    env.TMP = paths.claudeBridgeTempDir;
    env.TEMP = paths.claudeBridgeTempDir;
  }
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

async function createFreshSandbox(
  paths: D4SmokeSandboxPaths,
  provider: D4SmokeCandidate['provider'],
): Promise<void> {
  await mkdir(resolve(paths.root, '..'), { recursive: true });
  try {
    await mkdir(paths.root, { recursive: false, mode: 0o700 });
  } catch (error) {
    throw new D4SmokePolicyError('sandbox_not_fresh', paths.root, { cause: error });
  }
  let bridgeCreated = false;
  try {
    for (const path of writablePaths(paths)) {
      if (isWithin(paths.workspace, path)) continue;
      const directory = path === paths.localStorageFile || path === paths.auditCallLedger
        ? dirname(path)
        : path;
      await mkdir(directory, { recursive: true, mode: 0o700 });
    }
    if (provider === 'claude') {
      try {
        await mkdir(paths.claudeBridgeTempDir, { recursive: false, mode: 0o700 });
        bridgeCreated = true;
      } catch (error) {
        throw new D4SmokePolicyError('sandbox_not_fresh', paths.claudeBridgeTempDir, { cause: error });
      }
    }
    await mkdir(paths.runtimeRoot, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (bridgeCreated) await releaseD4ClaudeBridgeTemp(paths, provider).catch(() => undefined);
    throw error;
  }
}

async function releaseD4ClaudeBridgeTemp(
  paths: D4SmokeSandboxPaths,
  provider: D4SmokeCandidate['provider'],
): Promise<void> {
  if (provider === 'claude') await rm(paths.claudeBridgeTempDir, { recursive: true, force: true });
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

export interface D4SmokeClaudeNativeRuntime {
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

/** Resolve the exact version-managed Claude Code executable rather than the
 * mutable host-global `claude` launcher. */
export async function resolveD4ClaudeNativeRuntime(
  expectedVersion: string,
  versionsRoot = join(homedir(), '.local', 'share', 'claude', 'versions'),
): Promise<D4SmokeClaudeNativeRuntime> {
  const candidate = join(versionsRoot, expectedVersion);
  let executable: string;
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    await access(candidate, constants.X_OK);
    metadata = await lstat(candidate, { bigint: true });
    executable = await realpath(candidate);
  } catch (error) {
    throw new D4SmokePolicyError(
      'sandbox_not_fresh',
      `D4 requires version-managed Claude Code ${expectedVersion}`,
      { cause: error },
    );
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || executable !== candidate) {
    throw new D4SmokePolicyError(
      'model_binding_invalid',
      `version-managed Claude Code ${expectedVersion} is not a regular executable`,
    );
  }
  const version = await readD4ExecutableVersion(executable);
  if (version !== expectedVersion) {
    throw new D4SmokePolicyError(
      'model_binding_invalid',
      `Claude Code must be ${expectedVersion}, found ${version ?? 'unknown'}`,
    );
  }
  return {
    root: dirname(executable),
    executable,
    version,
    identity: {
      dev: metadata.dev,
      ino: metadata.ino,
      size: metadata.size,
      mtimeNs: metadata.mtimeNs,
      ctimeNs: metadata.ctimeNs,
    },
  };
}

async function assertD4ClaudeNativeRuntimeIdentity(
  runtime: D4SmokeClaudeNativeRuntime,
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
      'pinned Claude Code runtime disappeared',
      { cause: error },
    );
  }
  if (
    runtime.version !== expectedVersion
    || runtime.root !== dirname(runtime.executable)
    || executable !== runtime.executable
    || !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.dev !== runtime.identity.dev
    || metadata.ino !== runtime.identity.ino
    || metadata.size !== runtime.identity.size
    || metadata.mtimeNs !== runtime.identity.mtimeNs
    || metadata.ctimeNs !== runtime.identity.ctimeNs
  ) {
    throw new D4SmokePolicyError(
      'model_binding_invalid',
      `pinned Claude Code runtime identity diverged from ${expectedVersion}`,
    );
  }
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

/* Engineering shakedown (issue #205): a bounded, explicitly NON-INFERENTIAL
 * path that runs ONE frozen decision turn for ONE frozen G2 candidate against
 * ONE critic-approved dev cell to shake the D4 runtime when the official
 * 108/1296 Smoke layer cannot fit the quota forecast. It reuses the vetted
 * official primitives, never touches `runD4SmokeExecution`, and schema-marks
 * its artifacts so they can never be assigned to `D4SmokeExecutionResult` nor
 * ingested by an official plan/result path. */

export const D4_ENGINEERING_SHAKEDOWN_PURPOSE = 'engineering_shakedown' as const;
export const D4_ENGINEERING_SHAKEDOWN_EXECUTION_PREFIX = 'engineering-shakedown' as const;
export const D4_ENGINEERING_SHAKEDOWN_ROOT_PREFIX = 'engineering-shakedown' as const;
/** The shakedown forecasts exactly ONE next model turn — never the official
 * per-layer 1296. */
export const D4_ENGINEERING_SHAKEDOWN_MODEL_TURN_COUNT = 1 as const;
export const D4_ENGINEERING_SHAKEDOWN_FORECAST_BASIS = 'observed_delta_upper_bound_single_turn' as const;
export const D4_ENGINEERING_SHAKEDOWN_QUOTA_SCHEMA = 'steward-d4-engineering-shakedown-quota/1' as const;
export const D4_ENGINEERING_SHAKEDOWN_QUOTA_VERSION = 1 as const;
export const D4_ENGINEERING_SHAKEDOWN_DIAGNOSTIC_REPORT_SCHEMA =
  'steward-d4-engineering-shakedown-diagnostic-report/1' as const;
export const D4_ENGINEERING_SHAKEDOWN_DIAGNOSTIC_REPORT_VERSION = 1 as const;
export const D4_ENGINEERING_SHAKEDOWN_RESULT_SCHEMA = 'steward-d4-engineering-shakedown-result/2' as const;
export const D4_ENGINEERING_SHAKEDOWN_RESULT_VERSION = 2 as const;
export const D4_ENGINEERING_SHAKEDOWN_FAILURE_PURPOSE = 'engineering_shakedown_failure' as const;
export const D4_ENGINEERING_SHAKEDOWN_FAILURE_SCHEMA = 'steward-d4-engineering-shakedown-failure/2' as const;
export const D4_ENGINEERING_SHAKEDOWN_FAILURE_VERSION = 2 as const;

/** The exact native subscription windows that a frozen model's turn actually
 * charges, in canonical order. Admission evidence and reserve enforcement
 * require exactly this ordered set per model — the native response may expose
 * other windows, but a missing applicable window fails closed. */
export const D4_ENGINEERING_SHAKEDOWN_APPLICABLE_WINDOWS: Readonly<Record<
  typeof D4_SMOKE_CANDIDATES[number]['modelId'],
  readonly D4SmokeQuotaWindowId[]
>> = d4SingleTurnApplicableWindowIds;

export class D4EngineeringShakedownError extends Error {
  constructor(
    readonly code: 'selection_invalid' | 'namespace_collision' | 'artifact_invalid',
    detail: string,
  ) {
    super(`D4 engineering shakedown ${code}: ${detail}`);
    this.name = 'D4EngineeringShakedownError';
  }
}

/** Resolve the frozen candidate for a model id and its applicable window
 * descriptors in canonical order. Fails closed for any non-frozen model. */
function d4EngineeringShakedownApplicableWindows(modelId: string): {
  readonly provider: 'codex' | 'claude';
  readonly windows: readonly typeof D4_SMOKE_QUOTA_WINDOWS[number][];
} {
  const { candidate, windows } = d4SingleTurnApplicableWindows(modelId);
  return { provider: candidate.provider, windows };
}

const shakedownQuotaWindowSchema = z.object({
  id: nonEmptyStringSchema,
  provider: z.enum(['codex', 'claude']),
  usedPercent: percentageSchema,
  perTurnForecastAdditionalPercent: percentageSchema,
  sourceIdentity: nonEmptyStringSchema,
  forecast: z.object({
    basis: z.literal(D4_ENGINEERING_SHAKEDOWN_FORECAST_BASIS),
    observedDeltaUpperBoundPercentPerModelTurn: z.number().finite().positive().max(100),
    forecastModelTurnCount: z.literal(D4_ENGINEERING_SHAKEDOWN_MODEL_TURN_COUNT),
    observationCount: z.number().int().positive(),
    observedAt: isoTimestampSchema,
    sourceIdentity: nonEmptyStringSchema,
  }).strict(),
}).strict();

const shakedownQuotaPhaseFields = {
  shakedownExecutionId: nonEmptyStringSchema,
  decisionIndex: z.number().int().min(0).max(D4_SMOKE_DECISION_COUNT - 1),
  wakeId: nonEmptyStringSchema,
} as const;

const shakedownQuotaPhaseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('shakedown_dispatch'), ...shakedownQuotaPhaseFields }).strict(),
  z.object({ kind: z.literal('shakedown_post_turn'), ...shakedownQuotaPhaseFields }).strict(),
]);

/** Distinct shakedown quota evidence: a per-dispatch single-turn forecast with
 * hard non-inferential literals and NO official layer/full-run fields
 * (`forecastExecutionCount` / `forecastModelTurnCount: 1296`). The `.strict()`
 * envelope means an official evidence object fails this schema and vice
 * versa — mechanical proof the two cannot be interchanged. */
export const d4EngineeringShakedownQuotaEvidenceSchema = z.object({
  schema: z.literal(D4_ENGINEERING_SHAKEDOWN_QUOTA_SCHEMA),
  version: z.literal(D4_ENGINEERING_SHAKEDOWN_QUOTA_VERSION),
  purpose: z.literal(D4_ENGINEERING_SHAKEDOWN_PURPOSE),
  eligibleForInference: z.literal(false),
  inferenceEligibility: z.literal('forbidden'),
  validForRanking: z.literal(false),
  validForSurvivorSelection: z.literal(false),
  validForOfficialSmoke: z.literal(false),
  manifestSha256: sha256Schema,
  provider: z.enum(['codex', 'claude']),
  phase: shakedownQuotaPhaseSchema,
  capturedAt: isoTimestampSchema,
  validUntil: isoTimestampSchema,
  forecastModelTurnCount: z.literal(D4_ENGINEERING_SHAKEDOWN_MODEL_TURN_COUNT),
  cost: z.object({
    actualIncrementalSpendUsd: z.literal(0),
    forecastIncrementalSpendUsd: z.literal(0),
    subscriptionQuota: z.object({ windows: z.array(shakedownQuotaWindowSchema) }).strict(),
    shadowApiEquivalent: z.discriminatedUnion('status', [
      z.object({ status: z.literal('unknown'), amountUsd: z.null() }).strict(),
      z.object({ status: z.literal('estimated'), amountUsd: z.number().finite().nonnegative() }).strict(),
    ]),
  }).strict(),
}).strict();

export type D4EngineeringShakedownQuotaEvidence = z.infer<typeof d4EngineeringShakedownQuotaEvidenceSchema>;
export type D4ShakedownQuotaPhase = D4EngineeringShakedownQuotaEvidence['phase'];

export interface D4EngineeringShakedownSelector {
  readonly modelId: string;
  readonly cellId: string;
  readonly decisionIndex: number;
}

export interface D4EngineeringShakedownPlan {
  readonly purpose: typeof D4_ENGINEERING_SHAKEDOWN_PURPOSE;
  readonly shakedownExecutionId: string;
  readonly manifestSha256: string;
  readonly candidate: D4SmokeCandidate;
  readonly cell: D4SmokeCell;
  readonly decisionIndex: number;
  readonly repetitionId: 'r1';
  readonly paths: D4SmokeSandboxPaths;
  readonly env: Readonly<Record<string, string>>;
}

export type D4ShakedownQuotaReader = (
  phase: D4ShakedownQuotaPhase,
  plan: D4EngineeringShakedownPlan,
) => Promise<unknown>;

function d4EngineeringShakedownExecutionId(
  candidate: D4SmokeCandidate,
  cellId: string,
  decisionIndex: number,
): string {
  return [
    D4_ENGINEERING_SHAKEDOWN_EXECUTION_PREFIX,
    candidate.provider,
    candidate.modelId,
    cellId,
    `d${String(decisionIndex + 1).padStart(2, '0')}`,
  ].join(':');
}

/** Build the single frozen shakedown plan. It selects one exact G2 candidate,
 * one dev cell, and one decision index, then roots the sandbox under a
 * shakedown-namespaced path whose execution id cannot collide with an official
 * `provider:modelId:cell:r1` id. */
export function planD4EngineeringShakedown(
  stage: ValidatedD4SmokeStage,
  sandboxBaseInput: string,
  selector: D4EngineeringShakedownSelector,
): D4EngineeringShakedownPlan {
  if (
    !Number.isInteger(selector.decisionIndex)
    || selector.decisionIndex < 0
    || selector.decisionIndex >= D4_SMOKE_DECISION_COUNT
  ) {
    throw new D4EngineeringShakedownError(
      'selection_invalid',
      `decision index must be 0..${D4_SMOKE_DECISION_COUNT - 1}`,
    );
  }
  const candidate = stage.manifest.content.candidates.find(
    (item) => item.modelId === selector.modelId,
  );
  const frozen = D4_SMOKE_CANDIDATES.find((item) => item.modelId === selector.modelId);
  if (candidate === undefined || frozen === undefined || JSON.stringify(candidate) !== JSON.stringify(frozen)) {
    throw new D4EngineeringShakedownError(
      'selection_invalid',
      `${selector.modelId} is not an exact frozen G2 candidate`,
    );
  }
  const cell = stage.manifest.content.cells.find((item) => item.id === selector.cellId);
  if (cell === undefined) {
    throw new D4EngineeringShakedownError('selection_invalid', `${selector.cellId} is not a dev cell`);
  }
  if (cell.split !== 'dev') {
    throw new D4EngineeringShakedownError('selection_invalid', `${cell.id} is not a dev-split cell`);
  }
  const sandboxBase = resolve(sandboxBaseInput);
  const shakedownExecutionId = d4EngineeringShakedownExecutionId(candidate, cell.id, selector.decisionIndex);
  const slug = createHash('sha256').update(shakedownExecutionId).digest('hex').slice(0, 16);
  const root = join(sandboxBase, `${D4_ENGINEERING_SHAKEDOWN_ROOT_PREFIX}-${slug}`);
  const paths = sandboxPaths(root);
  const plan: D4EngineeringShakedownPlan = {
    purpose: D4_ENGINEERING_SHAKEDOWN_PURPOSE,
    shakedownExecutionId,
    manifestSha256: stage.manifestSha256,
    candidate,
    cell,
    decisionIndex: selector.decisionIndex,
    repetitionId: 'r1',
    paths,
    env: sandboxEnv(paths, candidate.provider),
  };
  validateD4EngineeringShakedownPlan(plan, sandboxBase);
  return plan;
}

export function validateD4EngineeringShakedownPlan(
  plan: D4EngineeringShakedownPlan,
  sandboxBaseInput: string,
): void {
  const sandboxBase = resolve(sandboxBaseInput);
  const frozen = D4_SMOKE_CANDIDATES.find((item) => item.modelId === plan.candidate.modelId);
  if (frozen === undefined || JSON.stringify(frozen) !== JSON.stringify(plan.candidate)) {
    throw new D4EngineeringShakedownError(
      'selection_invalid',
      `${plan.candidate.modelId}: candidate is not exact frozen G2`,
    );
  }
  if (plan.repetitionId !== 'r1') {
    throw new D4EngineeringShakedownError('selection_invalid', `${plan.shakedownExecutionId}: invalid repetition`);
  }
  if (
    !Number.isInteger(plan.decisionIndex)
    || plan.decisionIndex < 0
    || plan.decisionIndex >= D4_SMOKE_DECISION_COUNT
  ) {
    throw new D4EngineeringShakedownError(
      'selection_invalid',
      `${plan.shakedownExecutionId}: decision index out of range`,
    );
  }
  const expectedExecutionId = d4EngineeringShakedownExecutionId(
    plan.candidate,
    plan.cell.id,
    plan.decisionIndex,
  );
  const officialExecutionId = `${plan.candidate.provider}:${plan.candidate.modelId}:${plan.cell.id}:${plan.repetitionId}`;
  if (
    plan.shakedownExecutionId !== expectedExecutionId
    || !plan.shakedownExecutionId.startsWith(`${D4_ENGINEERING_SHAKEDOWN_EXECUTION_PREFIX}:`)
    || plan.shakedownExecutionId === officialExecutionId
  ) {
    throw new D4EngineeringShakedownError(
      'namespace_collision',
      `${plan.shakedownExecutionId}: execution id is not shakedown-namespaced`,
    );
  }
  const slug = createHash('sha256').update(plan.shakedownExecutionId).digest('hex').slice(0, 16);
  const expectedRoot = join(sandboxBase, `${D4_ENGINEERING_SHAKEDOWN_ROOT_PREFIX}-${slug}`);
  if (resolve(plan.paths.root) !== expectedRoot) {
    throw new D4EngineeringShakedownError('namespace_collision', `${plan.shakedownExecutionId}: non-canonical root`);
  }
  const expectedPaths = sandboxPaths(expectedRoot);
  if (JSON.stringify(expectedPaths) !== JSON.stringify(plan.paths)) {
    throw new D4EngineeringShakedownError('namespace_collision', `${plan.shakedownExecutionId}: sandbox path drift`);
  }
  for (const path of writablePaths(plan.paths)) {
    if (!isAbsolute(path) || !isStrictDescendant(expectedRoot, path)) {
      throw new D4EngineeringShakedownError(
        'namespace_collision',
        `${plan.shakedownExecutionId}: ${path} escapes its root`,
      );
    }
  }
  if (JSON.stringify(plan.env) !== JSON.stringify(sandboxEnv(expectedPaths, plan.candidate.provider))) {
    throw new D4EngineeringShakedownError('namespace_collision', `${plan.shakedownExecutionId}: sandbox environment drift`);
  }
}

/** Structural view onto the vetted official plan shape so the shakedown can
 * reuse `buildExactModelBinding`, the filesystem adapter, and the audit/
 * isolation helpers verbatim. The namespaced execution id and sandbox root
 * carry through, so every derived wake id / provenance path stays isolated. */
function d4EngineeringShakedownOfficialPlanView(plan: D4EngineeringShakedownPlan): D4SmokeExecutionPlan {
  return {
    ordinal: 0,
    executionId: plan.shakedownExecutionId,
    manifestSha256: plan.manifestSha256,
    candidate: plan.candidate,
    cell: plan.cell,
    repetitionId: plan.repetitionId,
    paths: plan.paths,
    env: plan.env,
  };
}

export function validateD4EngineeringShakedownQuotaEvidence(input: {
  readonly evidence: unknown;
  readonly manifestSha256: string;
  readonly phase: D4ShakedownQuotaPhase;
  readonly modelId: string;
  readonly now: Date;
}): D4EngineeringShakedownQuotaEvidence {
  const parsed = d4EngineeringShakedownQuotaEvidenceSchema.safeParse(input.evidence);
  if (!parsed.success) {
    throw new D4SmokeQuotaError('invalid', formatZodIssues(parsed.error));
  }
  const evidence = parsed.data;
  const { provider, windows: applicable } = d4EngineeringShakedownApplicableWindows(input.modelId);
  if (evidence.manifestSha256 !== input.manifestSha256) {
    throw new D4SmokeQuotaError(
      'invalid',
      `evidence binds ${evidence.manifestSha256}, manifest is ${input.manifestSha256}`,
    );
  }
  if (evidence.provider !== provider) {
    throw new D4SmokeQuotaError(
      'invalid',
      `evidence provider ${evidence.provider} differs from the ${input.modelId} provider ${provider}`,
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
  const expectedIdentities = applicable.map(({ id, provider: windowProvider }) => ({ id, provider: windowProvider }));
  const identities = evidence.cost.subscriptionQuota.windows.map(({ id, provider: windowProvider }) => ({ id, provider: windowProvider }));
  if (JSON.stringify(identities) !== JSON.stringify(expectedIdentities)) {
    throw new D4SmokeQuotaError(
      'incomplete',
      `${input.modelId} requires exactly its applicable quota windows [${applicable.map((window) => window.id).join(',')}] in canonical order`,
    );
  }
  const enforceReserve = input.phase.kind === 'shakedown_dispatch';
  for (const window of evidence.cost.subscriptionQuota.windows) {
    if (Date.parse(window.forecast.observedAt) > Date.parse(evidence.capturedAt)) {
      throw new D4SmokeQuotaError('invalid', `${window.id} observed upper bound is from the future`);
    }
    const expectedPerTurn = forecastD4SingleTurnPercent(window.forecast);
    if (Math.abs(window.perTurnForecastAdditionalPercent - expectedPerTurn) > 1e-12) {
      throw new D4SmokeQuotaError(
        'invalid',
        `${window.id} single-turn forecast must derive from its observed delta upper bound`,
      );
    }
    if (enforceReserve) {
      const projected = window.usedPercent + window.perTurnForecastAdditionalPercent;
      if (projected >= 80) {
        throw new D4SmokeQuotaError(
          'reserve_exhausted',
          `${window.id} projects ${projected}% used; 20% reserve requires less than 80%`,
        );
      }
    }
  }
  return evidence;
}

function buildD4EngineeringShakedownEvidenceFromUsed(input: {
  readonly phase: D4ShakedownQuotaPhase;
  readonly plan: D4EngineeringShakedownPlan;
  readonly liveUsed: Readonly<Partial<Record<D4SmokeQuotaWindowId, number>>>;
  readonly forecastBounds: D4SmokeQuotaForecastBounds;
  readonly captured: Date;
  readonly validityMs: number;
}): D4EngineeringShakedownQuotaEvidence {
  const modelId = input.plan.candidate.modelId;
  const { provider, windows: applicable } = d4EngineeringShakedownApplicableWindows(modelId);
  const windows = applicable.map(({ id }) => {
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
      perTurnForecastAdditionalPercent: forecastD4SingleTurnPercent(bound),
      sourceIdentity: provider === 'codex'
        ? `codex:account/rateLimits/read:${id === 'codex-spark' ? 'codex_bengalfox' : 'codex'}`
        : `claude:usage-control:${id}`,
      forecast: {
        basis: D4_ENGINEERING_SHAKEDOWN_FORECAST_BASIS,
        observedDeltaUpperBoundPercentPerModelTurn: bound.observedDeltaUpperBoundPercentPerModelTurn,
        forecastModelTurnCount: D4_ENGINEERING_SHAKEDOWN_MODEL_TURN_COUNT,
        observationCount: bound.observationCount,
        observedAt: bound.observedAt,
        sourceIdentity: bound.sourceIdentity,
      },
    };
  });
  const evidence = {
    schema: D4_ENGINEERING_SHAKEDOWN_QUOTA_SCHEMA,
    version: D4_ENGINEERING_SHAKEDOWN_QUOTA_VERSION,
    purpose: D4_ENGINEERING_SHAKEDOWN_PURPOSE,
    eligibleForInference: false as const,
    inferenceEligibility: 'forbidden' as const,
    validForRanking: false as const,
    validForSurvivorSelection: false as const,
    validForOfficialSmoke: false as const,
    manifestSha256: input.plan.manifestSha256,
    provider,
    phase: input.phase,
    capturedAt: input.captured.toISOString(),
    validUntil: new Date(input.captured.getTime() + input.validityMs).toISOString(),
    forecastModelTurnCount: D4_ENGINEERING_SHAKEDOWN_MODEL_TURN_COUNT,
    cost: {
      actualIncrementalSpendUsd: 0 as const,
      forecastIncrementalSpendUsd: 0 as const,
      subscriptionQuota: { windows },
      shadowApiEquivalent: { status: 'unknown' as const, amountUsd: null },
    },
  };
  return validateD4EngineeringShakedownQuotaEvidence({
    evidence,
    manifestSha256: input.plan.manifestSha256,
    phase: input.phase,
    modelId,
    now: input.captured,
  });
}

/** Native, per-dispatch shakedown quota reader. It reads the selected model's
 * applicable live subscription windows only (no cross-provider read, no layer
 * admission) immediately before each read, and forecasts exactly one next
 * model turn. */
export function createD4EngineeringShakedownNativeQuotaReader(options: {
  readonly forecastBounds: D4SmokeQuotaForecastBounds;
  readonly codexRuntime: D4SmokeCodexNativeRuntime | null;
  readonly claudeRuntime: D4SmokeClaudeNativeRuntime | null;
  readonly now?: () => Date;
  readonly validityMs?: number;
}): D4ShakedownQuotaReader {
  const now = options.now ?? (() => new Date());
  const validityMs = options.validityMs ?? 60_000;
  if (!Number.isInteger(validityMs) || validityMs <= 0) {
    throw new D4SmokeQuotaError('invalid', 'shakedown quota validityMs must be a positive integer');
  }
  return async (phase, plan) => {
    const captured = now();
    const provider = plan.candidate.provider;
    const context = { cwd: plan.paths.workspace, env: plan.env };
    let liveUsed: Readonly<Record<string, number>>;
    if (provider === 'codex') {
      if (options.codexRuntime === null) {
        throw new D4SmokePolicyError(
          'model_binding_invalid',
          'shakedown Codex quota reader is missing the pinned native runtime',
        );
      }
      await assertD4CodexNativeRuntimeIdentity(options.codexRuntime, plan.candidate.runtimeVersion);
      liveUsed = readD4SmokeCodexQuotaWindows(await readNativeCodexQuota(
        options.codexRuntime.executable,
        'account/rateLimits/read',
        null,
        context,
      ));
    } else {
      if (options.claudeRuntime === null) {
        throw new D4SmokePolicyError(
          'model_binding_invalid',
          'shakedown Claude quota reader is missing the pinned native runtime',
        );
      }
      await assertD4ClaudeNativeRuntimeIdentity(options.claudeRuntime, plan.candidate.runtimeVersion);
      liveUsed = readD4SmokeClaudeQuotaWindows(await readNativeClaudeQuota(context, options.claudeRuntime));
    }
    return buildD4EngineeringShakedownEvidenceFromUsed({
      phase,
      plan,
      liveUsed,
      forecastBounds: options.forecastBounds,
      captured,
      validityMs,
    });
  };
}

export interface D4EngineeringShakedownWindowDelta {
  readonly id: string;
  readonly provider: 'codex' | 'claude';
  readonly beforePercent: number;
  readonly afterPercent: number;
  readonly deltaPercent: number;
}

const shakedownProtocolVerdictSchema = z.enum(['pass', 'fail']);
const shakedownDecisionVerdictSchema = z.enum(['pass', 'fail', 'not_evaluated']);

/** The exported per-turn diagnostic report. It replaces the raw official
 * `StewardWakeEvaluationReport` (which, being official-shaped, could be pushed
 * into an official `reports[]`) with a distinct non-inferential object of its
 * own schema/literals that carries only the verdicts. */
export const d4EngineeringShakedownDiagnosticReportSchema = z.object({
  schema: z.literal(D4_ENGINEERING_SHAKEDOWN_DIAGNOSTIC_REPORT_SCHEMA),
  version: z.literal(D4_ENGINEERING_SHAKEDOWN_DIAGNOSTIC_REPORT_VERSION),
  purpose: z.literal(D4_ENGINEERING_SHAKEDOWN_PURPOSE),
  inferenceEligibility: z.literal('forbidden'),
  eligibleForInference: z.literal(false),
  validForRanking: z.literal(false),
  validForSurvivorSelection: z.literal(false),
  validForOfficialSmoke: z.literal(false),
  wakeId: nonEmptyStringSchema,
  protocolVerdict: shakedownProtocolVerdictSchema,
  decisionVerdict: shakedownDecisionVerdictSchema,
  executionVerdict: z.literal('not_evaluated'),
}).strict();

export type D4EngineeringShakedownDiagnosticReport = z.infer<typeof d4EngineeringShakedownDiagnosticReportSchema>;

const shakedownWindowDeltaSchema = z.object({
  id: nonEmptyStringSchema,
  provider: z.enum(['codex', 'claude']),
  beforePercent: percentageSchema,
  afterPercent: percentageSchema,
  deltaPercent: z.number().finite(),
}).strict();

const shakedownCredentialReceiptSchema = z.object({
  provider: z.enum(['codex', 'claude']),
  sourceIdentity: nonEmptyStringSchema,
  sourcePathSha256: sha256Schema,
  sourceSha256: sha256Schema,
  byteLength: z.number().int().nonnegative(),
  targetRelativePath: z.enum(['auth.json', '.credentials.json']),
  unchangedAfterExecution: z.literal(true),
}).strict();

const shakedownCapabilityAttemptSchema = z.object({
  sequence: z.number().int().positive(),
  capability: z.enum(D4_SMOKE_FORBIDDEN_CAPABILITIES),
  at: isoTimestampSchema,
  detail: nonEmptyStringSchema.nullable(),
}).strict();

const shakedownTelemetrySchema = z.union([
  z.null(),
  z.object({
    totalTokens: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    contextWindow: z.number().int().positive().nullable().optional(),
    updatedAt: isoTimestampSchema,
  }).strict(),
]);

const shakedownProviderModelUsageSchema = z.object({
  modelId: nonEmptyStringSchema,
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadInputTokens: z.number().int().nonnegative(),
  cacheCreationInputTokens: z.number().int().nonnegative(),
  webSearchRequests: z.number().int().nonnegative(),
  costUSD: z.number().finite().nonnegative(),
  contextWindow: z.number().int().nonnegative(),
  maxOutputTokens: z.number().int().nonnegative(),
}).strict();

const shakedownRoleAttestationSchema = z.object({
  /** Decision-producing direct main-loop identities only. */
  directDecisionAuthorModelIds: z.array(nonEmptyStringSchema),
  /** Init, direct-main-loop, and structured refusal identities. */
  primaryRoleGuardModelIds: z.array(nonEmptyStringSchema),
  /** Result usage entries that belong to a primary-role guard identity. */
  primaryModelUsages: z.array(shakedownProviderModelUsageSchema),
  /** Exact model identities from the provider-native result modelUsage table. */
  providerModelUsageIds: z.array(nonEmptyStringSchema),
  /** Every result usage identity outside the primary role, with native usage. */
  auxiliaryModels: z.array(z.object({
    modelId: nonEmptyStringSchema,
    modelUsage: shakedownProviderModelUsageSchema,
  }).strict()),
  /** Assistant identities outside primary guards that had no result usage. */
  sidechainAssistantModelIds: z.array(nonEmptyStringSchema),
  providerReportedModelIds: z.array(nonEmptyStringSchema),
}).strict();

export type D4ModelRoleAttestation = z.infer<typeof shakedownRoleAttestationSchema>;

function addD4ModelRoleEvidenceIssues(
  attestation: D4ModelRoleAttestation,
  ctx: z.RefinementCtx,
): void {
  const providerReported = new Set(attestation.providerReportedModelIds);
  const direct = new Set(attestation.directDecisionAuthorModelIds);
  const primaryGuards = new Set(attestation.primaryRoleGuardModelIds);
  const auxiliary = new Set(attestation.auxiliaryModels.map(({ modelId }) => modelId));
  const sidechain = new Set(attestation.sidechainAssistantModelIds);
  const primaryUsage = new Set(attestation.primaryModelUsages.map(({ modelId }) => modelId));
  const providerUsage = new Set(attestation.providerModelUsageIds);
  if (
    providerReported.size !== attestation.providerReportedModelIds.length
    || direct.size !== attestation.directDecisionAuthorModelIds.length
    || primaryGuards.size !== attestation.primaryRoleGuardModelIds.length
    || auxiliary.size !== attestation.auxiliaryModels.length
    || sidechain.size !== attestation.sidechainAssistantModelIds.length
    || primaryUsage.size !== attestation.primaryModelUsages.length
    || providerUsage.size !== attestation.providerModelUsageIds.length
  ) {
    ctx.addIssue({ code: 'custom', path: ['providerReportedModelIds'], message: 'role evidence identities must be unique' });
  }
  if (
    [...direct].some((modelId) => !primaryGuards.has(modelId))
    || [...auxiliary].some((modelId) => primaryGuards.has(modelId) || sidechain.has(modelId))
    || [...sidechain].some((modelId) => primaryGuards.has(modelId))
    || [...primaryUsage].some((modelId) => !primaryGuards.has(modelId))
    || [...providerUsage].some((modelId) => !providerReported.has(modelId) || sidechain.has(modelId))
  ) {
    ctx.addIssue({ code: 'custom', path: ['primaryRoleGuardModelIds'], message: 'primary, auxiliary, and sidechain roles must be disjoint and accounted' });
  }
  const recordedUsage = new Set([...primaryUsage, ...auxiliary]);
  if (
    recordedUsage.size !== providerUsage.size
    || [...recordedUsage].some((modelId) => !providerUsage.has(modelId))
  ) {
    ctx.addIssue({ code: 'custom', path: ['providerModelUsageIds'], message: 'provider model usage identities must equal recorded primary and auxiliary usage identities' });
  }
  const accounted = new Set([...primaryGuards, ...auxiliary, ...sidechain]);
  if (
    accounted.size !== providerReported.size
    || [...accounted].some((modelId) => !providerReported.has(modelId))
  ) {
    ctx.addIssue({ code: 'custom', path: ['providerReportedModelIds'], message: 'every provider-reported model identity must be role-accounted' });
  }
  for (const [index, auxiliaryModel] of attestation.auxiliaryModels.entries()) {
    if (auxiliaryModel.modelUsage.modelId !== auxiliaryModel.modelId) {
      ctx.addIssue({ code: 'custom', path: ['auxiliaryModels', index, 'modelUsage'], message: 'auxiliary usage must belong to its auxiliary identity' });
    }
  }
}

function addD4ShakedownSuccessfulPrimaryIssues(
  attestation: D4ModelRoleAttestation,
  requestedModelId: string,
  ctx: z.RefinementCtx,
): void {
  for (const [path, ids] of [
    ['directDecisionAuthorModelIds', attestation.directDecisionAuthorModelIds],
    ['primaryRoleGuardModelIds', attestation.primaryRoleGuardModelIds],
  ] as const) {
    if (ids.length !== 1 || ids[0] !== requestedModelId) {
      ctx.addIssue({ code: 'custom', path: [path], message: 'successful shakedown primary identity must equal requestedModelId exactly' });
    }
  }
}

function normalizedD4ModelIds(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? [])
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter((value) => value !== ''))].sort();
}

const d4ModelRoleEvidenceSchema = shakedownRoleAttestationSchema.superRefine(
  addD4ModelRoleEvidenceIssues,
);

function assertD4ModelRoleEvidence(
  attestation: D4ModelRoleAttestation,
  wakeId: string,
): void {
  const parsed = d4ModelRoleEvidenceSchema.safeParse(attestation);
  if (!parsed.success) {
    throw new D4SmokePolicyError(
      'model_binding_invalid',
      `${wakeId}: invalid provider model role accounting: ${parsed.error.issues.map(({ message }) => message).join('; ')}`,
    );
  }
}

function attestD4ModelRoles(input: {
  readonly outcome: TurnOutcome;
  readonly provider: 'codex' | 'claude';
  readonly requestedModelId: string;
  readonly wakeId: string;
}): D4ModelRoleAttestation {
  const providerReportedModelIds = normalizedD4ModelIds(input.outcome.actualModelIds);
  const directDecisionAuthorModelIds = normalizedD4ModelIds(input.outcome.primaryModelIds);
  const primaryRoleGuardModelIds = input.provider === 'codex'
    ? [input.requestedModelId]
    : normalizedD4ModelIds(input.outcome.primaryRoleGuardModelIds);
  const usageByModelId = new Map<string, ProviderModelUsage>();
  for (const usage of input.outcome.modelUsage ?? []) {
    if (usageByModelId.has(usage.modelId)) {
      throw new D4SmokePolicyError('model_binding_invalid', `${input.wakeId}: duplicate model usage for ${usage.modelId}`);
    }
    if (!providerReportedModelIds.includes(usage.modelId)) {
      throw new D4SmokePolicyError('model_binding_invalid', `${input.wakeId}: model usage identity ${usage.modelId} was not provider-reported`);
    }
    usageByModelId.set(usage.modelId, usage);
  }
  const primaryModelUsages = [...usageByModelId.values()]
    .filter(({ modelId }) => primaryRoleGuardModelIds.includes(modelId));
  const auxiliaryModels = [...usageByModelId.values()]
    .filter(({ modelId }) => !primaryRoleGuardModelIds.includes(modelId))
    .map((modelUsage) => ({ modelId: modelUsage.modelId, modelUsage }));
  const sidechainAssistantModelIds = providerReportedModelIds.filter((modelId) =>
    !primaryRoleGuardModelIds.includes(modelId) && !usageByModelId.has(modelId));
  return {
    directDecisionAuthorModelIds: input.provider === 'codex'
      ? [input.requestedModelId]
      : directDecisionAuthorModelIds,
    primaryRoleGuardModelIds,
    primaryModelUsages,
    providerModelUsageIds: [...usageByModelId.keys()].sort(),
    auxiliaryModels,
    sidechainAssistantModelIds,
    providerReportedModelIds,
  };
}

function assertD4SuccessfulModelRoles(input: {
  readonly attestation: D4ModelRoleAttestation;
  readonly provider: 'codex' | 'claude';
  readonly requestedModelId: string;
  readonly wakeId: string;
}): void {
  if (input.provider === 'codex') {
    // Codex has no direct-assistant frame. Keep its established exact-union
    // rule rather than reclassifying an extra identity as auxiliary.
    assertD4ActualModelIds(
      input.attestation.providerReportedModelIds,
      input.requestedModelId,
      input.wakeId,
    );
    return;
  }
  for (const ids of [
    input.attestation.directDecisionAuthorModelIds,
    input.attestation.primaryRoleGuardModelIds,
  ]) {
    if (ids.length !== 1 || ids[0] !== input.requestedModelId) {
      throw new D4SmokePolicyError(
        'model_binding_invalid',
        `${input.wakeId}: direct decision-author and primary-role guard sets must each equal ${input.requestedModelId}`,
      );
    }
  }
}

/** Strict full artifact schema. Every top-level field, the nested quota
 * evidence, the diagnostic report, telemetry, credential receipt, and
 * capability attempts are validated — and because it is `.strict()`, any
 * missing, extra, relabeled, or official-collection key (`status` / `reports`
 * / `quotaEvidence`, or a raw `report`) is rejected. */
export const d4EngineeringShakedownResultSchema = z.object({
  schema: z.literal(D4_ENGINEERING_SHAKEDOWN_RESULT_SCHEMA),
  version: z.literal(D4_ENGINEERING_SHAKEDOWN_RESULT_VERSION),
  purpose: z.literal(D4_ENGINEERING_SHAKEDOWN_PURPOSE),
  inferenceEligibility: z.literal('forbidden'),
  eligibleForInference: z.literal(false),
  validForRanking: z.literal(false),
  validForSurvivorSelection: z.literal(false),
  validForOfficialSmoke: z.literal(false),
  shakedownExecutionId: nonEmptyStringSchema,
  manifestSha256: sha256Schema,
  provider: z.enum(['codex', 'claude']),
  requestedModelId: nonEmptyStringSchema,
  modelAttestation: shakedownRoleAttestationSchema,
  decisionIndex: z.number().int().min(0).max(D4_SMOKE_DECISION_COUNT - 1),
  wakeId: nonEmptyStringSchema,
  terminalStatus: nonEmptyStringSchema,
  diagnosticReport: d4EngineeringShakedownDiagnosticReportSchema,
  durationMs: z.number().finite().nonnegative().nullable(),
  latencyMs: z.number().finite().nonnegative(),
  tokenTelemetry: shakedownTelemetrySchema,
  quota: z.object({
    dispatch: d4EngineeringShakedownQuotaEvidenceSchema,
    postTurn: d4EngineeringShakedownQuotaEvidenceSchema,
    windowDeltas: z.array(shakedownWindowDeltaSchema),
  }).strict(),
  credential: shakedownCredentialReceiptSchema,
  capabilityAttempts: z.array(shakedownCapabilityAttemptSchema).length(0),
}).strict().superRefine((artifact, ctx) => {
  const candidate = D4_SMOKE_CANDIDATES.find(({ modelId }) => modelId === artifact.requestedModelId);
  if (candidate === undefined || candidate.provider !== artifact.provider) {
    ctx.addIssue({ code: 'custom', path: ['requestedModelId'], message: 'requested model/provider is not frozen' });
    return;
  }
  addD4ModelRoleEvidenceIssues(artifact.modelAttestation, ctx);
  addD4ShakedownSuccessfulPrimaryIssues(artifact.modelAttestation, artifact.requestedModelId, ctx);
  if (!artifact.shakedownExecutionId.startsWith(
    `${D4_ENGINEERING_SHAKEDOWN_EXECUTION_PREFIX}:${artifact.provider}:${artifact.requestedModelId}:`,
  )) {
    ctx.addIssue({ code: 'custom', path: ['shakedownExecutionId'], message: 'execution namespace/model mismatch' });
  }
  if (artifact.diagnosticReport.wakeId !== artifact.wakeId) {
    ctx.addIssue({ code: 'custom', path: ['diagnosticReport', 'wakeId'], message: 'diagnostic wakeId mismatch' });
  }
  const applicable = D4_ENGINEERING_SHAKEDOWN_APPLICABLE_WINDOWS[
    artifact.requestedModelId as keyof typeof D4_ENGINEERING_SHAKEDOWN_APPLICABLE_WINDOWS
  ];
  const dispatch = artifact.quota.dispatch;
  const postTurn = artifact.quota.postTurn;
  for (const [label, evidence, kind] of [
    ['dispatch', dispatch, 'shakedown_dispatch'],
    ['postTurn', postTurn, 'shakedown_post_turn'],
  ] as const) {
    if (
      evidence.manifestSha256 !== artifact.manifestSha256
      || evidence.provider !== artifact.provider
      || evidence.phase.kind !== kind
      || evidence.phase.shakedownExecutionId !== artifact.shakedownExecutionId
      || evidence.phase.decisionIndex !== artifact.decisionIndex
      || evidence.phase.wakeId !== artifact.wakeId
    ) {
      ctx.addIssue({ code: 'custom', path: ['quota', label], message: 'quota evidence is not bound to this artifact' });
    }
    if (JSON.stringify(evidence.cost.subscriptionQuota.windows.map(({ id }) => id)) !== JSON.stringify(applicable)) {
      ctx.addIssue({ code: 'custom', path: ['quota', label], message: 'quota windows are not the model-applicable set' });
    }
  }
  const dispatchById = new Map(dispatch.cost.subscriptionQuota.windows.map((window) => [window.id, window]));
  const postById = new Map(postTurn.cost.subscriptionQuota.windows.map((window) => [window.id, window]));
  if (JSON.stringify(artifact.quota.windowDeltas.map(({ id }) => id)) !== JSON.stringify(applicable)) {
    ctx.addIssue({ code: 'custom', path: ['quota', 'windowDeltas'], message: 'quota delta windows are not applicable' });
  }
  for (const [index, delta] of artifact.quota.windowDeltas.entries()) {
    const before = dispatchById.get(delta.id);
    const after = postById.get(delta.id);
    if (
      before === undefined
      || after === undefined
      || delta.provider !== artifact.provider
      || delta.beforePercent !== before.usedPercent
      || delta.afterPercent !== after.usedPercent
      || Math.abs(delta.deltaPercent - (after.usedPercent - before.usedPercent)) > 1e-12
    ) {
      ctx.addIssue({ code: 'custom', path: ['quota', 'windowDeltas', index], message: 'quota delta is not bound to snapshots' });
    }
  }
  if (artifact.credential.provider !== artifact.provider) {
    ctx.addIssue({ code: 'custom', path: ['credential', 'provider'], message: 'credential provider mismatch' });
  }
});

/** The shakedown artifact. Structurally distinct from `D4SmokeExecutionResult`
 * (no `status`, no `reports[]`, no `quotaEvidence`, no raw report) and carrying
 * hard non-inferential literals so it can never be relabeled as, or assigned
 * to, an official Smoke result. It records observations only — never a winner,
 * score, rank, survivor, profitability, or official-Smoke validity. */
export type D4EngineeringShakedownResult = z.infer<typeof d4EngineeringShakedownResultSchema>;

const shakedownFailureErrorSchema = z.object({
  kind: z.enum(['policy', 'runtime']),
  name: nonEmptyStringSchema,
  code: nonEmptyStringSchema.nullable(),
  message: nonEmptyStringSchema,
}).strict();

/** A strict operator-persistable record for a completed turn that failed only
 * after its dispatch and fresh post-turn accounting were captured. It is not a
 * result, carries no official collection keys, and remains invalid by literal. */
export const d4EngineeringShakedownFailureSchema = z.object({
  schema: z.literal(D4_ENGINEERING_SHAKEDOWN_FAILURE_SCHEMA),
  version: z.literal(D4_ENGINEERING_SHAKEDOWN_FAILURE_VERSION),
  purpose: z.literal(D4_ENGINEERING_SHAKEDOWN_FAILURE_PURPOSE),
  inferenceEligibility: z.literal('forbidden'),
  eligibleForInference: z.literal(false),
  validForRanking: z.literal(false),
  validForSurvivorSelection: z.literal(false),
  validForOfficialSmoke: z.literal(false),
  failureValidity: z.literal('invalid'),
  shakedownExecutionId: nonEmptyStringSchema,
  manifestSha256: sha256Schema,
  provider: z.enum(['codex', 'claude']),
  requestedModelId: nonEmptyStringSchema,
  modelAttestation: shakedownRoleAttestationSchema,
  decisionIndex: z.number().int().min(0).max(D4_SMOKE_DECISION_COUNT - 1),
  wakeId: nonEmptyStringSchema,
  terminal: z.object({
    providerReportedStatus: z.literal('completed'),
    interrupted: z.literal(false),
  }).strict(),
  durationMs: z.number().finite().nonnegative().nullable(),
  latencyMs: z.number().finite().nonnegative(),
  tokenTelemetry: shakedownTelemetrySchema,
  quota: z.object({
    dispatch: d4EngineeringShakedownQuotaEvidenceSchema,
    postTurn: d4EngineeringShakedownQuotaEvidenceSchema,
    windowDeltas: z.array(shakedownWindowDeltaSchema),
  }).strict(),
  credential: shakedownCredentialReceiptSchema,
  capabilityAttempts: z.array(shakedownCapabilityAttemptSchema),
  error: shakedownFailureErrorSchema,
}).strict().superRefine((artifact, ctx) => {
  const candidate = D4_SMOKE_CANDIDATES.find(({ modelId }) => modelId === artifact.requestedModelId);
  if (candidate === undefined || candidate.provider !== artifact.provider) {
    ctx.addIssue({ code: 'custom', path: ['requestedModelId'], message: 'requested model/provider is not frozen' });
    return;
  }
  if (!artifact.shakedownExecutionId.startsWith(
    `${D4_ENGINEERING_SHAKEDOWN_EXECUTION_PREFIX}:${artifact.provider}:${artifact.requestedModelId}:`,
  )) {
    ctx.addIssue({ code: 'custom', path: ['shakedownExecutionId'], message: 'execution namespace/model mismatch' });
  }
  addD4ModelRoleEvidenceIssues(artifact.modelAttestation, ctx);
  const applicable = D4_ENGINEERING_SHAKEDOWN_APPLICABLE_WINDOWS[
    artifact.requestedModelId as keyof typeof D4_ENGINEERING_SHAKEDOWN_APPLICABLE_WINDOWS
  ];
  const dispatchById = new Map(artifact.quota.dispatch.cost.subscriptionQuota.windows.map((window) => [window.id, window]));
  const postById = new Map(artifact.quota.postTurn.cost.subscriptionQuota.windows.map((window) => [window.id, window]));
  for (const [label, evidence, kind] of [
    ['dispatch', artifact.quota.dispatch, 'shakedown_dispatch'],
    ['postTurn', artifact.quota.postTurn, 'shakedown_post_turn'],
  ] as const) {
    if (
      evidence.manifestSha256 !== artifact.manifestSha256
      || evidence.provider !== artifact.provider
      || evidence.phase.kind !== kind
      || evidence.phase.shakedownExecutionId !== artifact.shakedownExecutionId
      || evidence.phase.decisionIndex !== artifact.decisionIndex
      || evidence.phase.wakeId !== artifact.wakeId
      || JSON.stringify(evidence.cost.subscriptionQuota.windows.map(({ id }) => id)) !== JSON.stringify(applicable)
    ) {
      ctx.addIssue({ code: 'custom', path: ['quota', label], message: 'quota evidence is not bound to this failure artifact' });
    }
  }
  if (JSON.stringify(artifact.quota.windowDeltas.map(({ id }) => id)) !== JSON.stringify(applicable)) {
    ctx.addIssue({ code: 'custom', path: ['quota', 'windowDeltas'], message: 'quota delta windows are not applicable' });
  }
  for (const [index, delta] of artifact.quota.windowDeltas.entries()) {
    const before = dispatchById.get(delta.id);
    const after = postById.get(delta.id);
    if (
      before === undefined
      || after === undefined
      || delta.provider !== artifact.provider
      || delta.beforePercent !== before.usedPercent
      || delta.afterPercent !== after.usedPercent
      || Math.abs(delta.deltaPercent - (after.usedPercent - before.usedPercent)) > 1e-12
    ) {
      ctx.addIssue({ code: 'custom', path: ['quota', 'windowDeltas', index], message: 'quota delta is not bound to snapshots' });
    }
  }
  if (artifact.credential.provider !== artifact.provider) {
    ctx.addIssue({ code: 'custom', path: ['credential', 'provider'], message: 'credential provider mismatch' });
  }
});

export type D4EngineeringShakedownFailure = z.infer<typeof d4EngineeringShakedownFailureSchema>;

/** Official-Smoke result collection keys the shakedown artifact must never
 * carry — the mechanical block against ingestion by an official result path. */
const D4_OFFICIAL_SMOKE_RESULT_KEYS = ['status', 'reports', 'quotaEvidence'] as const;

export function assertD4EngineeringShakedownNonInferential(result: unknown): D4EngineeringShakedownResult {
  if (typeof result !== 'object' || result === null) {
    throw new D4EngineeringShakedownError('artifact_invalid', 'shakedown artifact must be an object');
  }
  for (const key of D4_OFFICIAL_SMOKE_RESULT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(result, key)) {
      throw new D4EngineeringShakedownError(
        'artifact_invalid',
        `shakedown artifact must not carry the official Smoke result key "${key}"`,
      );
    }
  }
  const parsed = d4EngineeringShakedownResultSchema.safeParse(result);
  if (!parsed.success) {
    throw new D4EngineeringShakedownError('artifact_invalid', formatZodIssues(parsed.error));
  }
  return result as D4EngineeringShakedownResult;
}

export function assertD4EngineeringShakedownFailureNonInferential(
  artifact: unknown,
): D4EngineeringShakedownFailure {
  if (typeof artifact !== 'object' || artifact === null) {
    throw new D4EngineeringShakedownError('artifact_invalid', 'shakedown failure artifact must be an object');
  }
  for (const key of D4_OFFICIAL_SMOKE_RESULT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(artifact, key)) {
      throw new D4EngineeringShakedownError(
        'artifact_invalid',
        `shakedown failure artifact must not carry the official Smoke result key "${key}"`,
      );
    }
  }
  const parsed = d4EngineeringShakedownFailureSchema.safeParse(artifact);
  if (!parsed.success) {
    throw new D4EngineeringShakedownError('artifact_invalid', formatZodIssues(parsed.error));
  }
  return artifact as D4EngineeringShakedownFailure;
}

export class D4EngineeringShakedownFailureError extends Error {
  constructor(
    readonly artifact: D4EngineeringShakedownFailure,
    options?: { cause?: unknown },
  ) {
    super(`D4 engineering shakedown failure: ${artifact.error.message}`, options);
    this.name = 'D4EngineeringShakedownFailureError';
  }
}

function d4EngineeringShakedownWindowDeltas(
  dispatch: D4EngineeringShakedownQuotaEvidence,
  postTurn: D4EngineeringShakedownQuotaEvidence,
): D4EngineeringShakedownWindowDelta[] {
  const dispatchByWindow = new Map(
    dispatch.cost.subscriptionQuota.windows.map((quotaWindow) => [quotaWindow.id, quotaWindow]),
  );
  return postTurn.cost.subscriptionQuota.windows.map((after) => {
    const before = dispatchByWindow.get(after.id);
    if (before === undefined) {
      throw new D4SmokeQuotaError('incomplete', `${after.id}: post-turn window has no pre-turn baseline`);
    }
    return {
      id: after.id,
      provider: after.provider,
      beforePercent: before.usedPercent,
      afterPercent: after.usedPercent,
      deltaPercent: after.usedPercent - before.usedPercent,
    };
  });
}

function d4EngineeringShakedownFailureErrorDetail(error: unknown): z.infer<typeof shakedownFailureErrorSchema> {
  if (error instanceof D4SmokePolicyError || error instanceof D4SmokeQuotaError) {
    return { kind: 'policy', name: error.name, code: error.code, message: error.message };
  }
  if (error instanceof Error) {
    return { kind: 'runtime', name: error.name, code: null, message: error.message };
  }
  return { kind: 'runtime', name: 'NonErrorThrown', code: null, message: String(error) };
}

export interface D4EngineeringShakedownInput {
  readonly manifestBytes: string | Uint8Array;
  readonly receipt: D4SmokeCriticReceipt | unknown;
  readonly repoRoot: string;
  readonly gitVerifier?: D4SmokeGitVerifier;
  readonly contentByRef: Readonly<Record<string, string | Uint8Array>>;
  readonly sandboxBase: string;
  readonly selector: D4EngineeringShakedownSelector;
  readonly credentialSources: readonly D4SmokeCredentialSource[];
  readonly canonicalCredentialPaths?: D4SmokeCanonicalCredentialPaths;
  readonly quotaReader: D4ShakedownQuotaReader;
  readonly driverFactory: D4SmokeDriverFactory;
  readonly codexRuntime?: D4SmokeCodexNativeRuntime;
  readonly bootstrapWorkspace?: D4SmokeBootstrapWorkspace;
  readonly prepareDecision: D4SmokePrepareDecision;
  readonly readTerminalArtifact: D4SmokeReadTerminalArtifact;
  readonly auditLedger: D4SmokeCapabilityAuditLedger;
  readonly now?: () => Date;
  readonly deadlineMs?: number;
}

export interface D4EngineeringShakedownFilesystemInput {
  readonly manifestBytes: string | Uint8Array;
  readonly receipt: D4SmokeCriticReceipt | unknown;
  readonly contentByRef: Readonly<Record<string, string | Uint8Array>>;
  readonly sandboxBase: string;
  readonly selector: D4EngineeringShakedownSelector;
  readonly deadlineMs?: number;
  readonly filesystemAdapterOptions?: { readonly terminalWaitMs?: number };
}

/** Watchdog-facing, serial single-execution production entrypoint. It pins the
 * frozen native runtime for the selected candidate, reads live
 * subscription quota per-dispatch, and never accepts a test seam. */
export async function runD4EngineeringShakedownFilesystem(
  input: D4EngineeringShakedownFilesystemInput,
): Promise<D4EngineeringShakedownResult> {
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
  const plan = planD4EngineeringShakedown(stage, input.sandboxBase, input.selector);
  const forecastBounds = deriveD4SmokeQuotaForecastBounds({ stage, contentByRef: input.contentByRef });
  const canonical = defaultD4SmokeCanonicalCredentialPaths();
  let codexRuntime: D4SmokeCodexNativeRuntime | undefined;
  let claudeRuntime: D4SmokeClaudeNativeRuntime | undefined;
  if (plan.candidate.provider === 'codex') {
    const version = frozenD4SmokeCodexRuntimeVersion();
    codexRuntime = await resolveD4CodexNativeRuntime(version);
    await assertD4CodexNativeRuntimeIdentity(codexRuntime, version);
  } else {
    const version = frozenD4SmokeClaudeRuntimeVersion();
    claudeRuntime = await resolveD4ClaudeNativeRuntime(version);
    await assertD4ClaudeNativeRuntimeIdentity(claudeRuntime, version);
  }
  const adapter = createD4SmokeFilesystemWorkspaceAdapter(input.filesystemAdapterOptions);
  return runD4EngineeringShakedown({
    manifestBytes: input.manifestBytes,
    receipt: input.receipt,
    repoRoot: D4_REPO_ROOT,
    contentByRef: input.contentByRef,
    sandboxBase: input.sandboxBase,
    selector: input.selector,
    credentialSources: D4_SMOKE_CREDENTIAL_SOURCES.map((source) => ({
      ...source,
      sourcePath: canonical[source.provider],
    })),
    canonicalCredentialPaths: canonical,
    quotaReader: createD4EngineeringShakedownNativeQuotaReader({
      forecastBounds,
      codexRuntime: codexRuntime ?? null,
      claudeRuntime: claudeRuntime ?? null,
    }),
    driverFactory: createD4SmokeNativeDriverFactory({ claudeRuntime }),
    ...(codexRuntime !== undefined ? { codexRuntime } : {}),
    bootstrapWorkspace: adapter.bootstrapWorkspace,
    prepareDecision: adapter.prepareDecision,
    readTerminalArtifact: adapter.readTerminalArtifact,
    auditLedger: new D4SmokeCapabilityAuditLedger(),
    ...(input.deadlineMs !== undefined ? { deadlineMs: input.deadlineMs } : {}),
  });
}

export async function runD4EngineeringShakedown(
  input: D4EngineeringShakedownInput,
): Promise<D4EngineeringShakedownResult> {
  const now = input.now ?? (() => new Date());
  const stage = await validateD4SmokeStage(input);
  const plan = planD4EngineeringShakedown(stage, input.sandboxBase, input.selector);
  const officialPlan = d4EngineeringShakedownOfficialPlanView(plan);
  const provider = plan.candidate.provider;
  const decisionIndex = plan.decisionIndex;
  const source = selectCredentialSource(provider, input.credentialSources);
  input.auditLedger.assertZero();
  const forbiddenBoundaries = createD4SmokeForbiddenCapabilityBoundaries(input.auditLedger, now);

  await createFreshSandbox(plan.paths, plan.candidate.provider);
  let auditCursor: D4SmokeAuditCursor | null = null;
  const canonicalPaths = input.canonicalCredentialPaths ?? defaultD4SmokeCanonicalCredentialPaths();
  let credential: CredentialGuard;
  try {
    credential = await copyCredentialIntoSandbox(officialPlan, source, canonicalPaths);
  } catch (error) {
    await releaseD4ClaudeBridgeTemp(plan.paths, provider).catch(() => undefined);
    throw error;
  }

  let driver: StewardMachineDriver | null = null;
  let executionError: unknown;
  let wakeId: string | null = null;
  let report: StewardWakeEvaluationReport | null = null;
  let dispatchQuota: D4EngineeringShakedownQuotaEvidence | null = null;
  let postTurnQuota: D4EngineeringShakedownQuotaEvidence | null = null;
  let terminalStatus: string | null = null;
  let modelAttestation: D4ModelRoleAttestation | null = null;
  let durationMs: number | null = null;
  let latencyMs = 0;
  let tokenTelemetry: ThreadTelemetry | null = null;
  let turnInterrupted: boolean | null = null;
  try {
    const instructionValue = input.contentByRef[stage.manifest.content.baseline.instruction.ref]!;
    const instructionBytes = typeof instructionValue === 'string'
      ? Buffer.from(instructionValue, 'utf8')
      : Buffer.from(instructionValue);
    const runtimePolicyValue = input.contentByRef[stage.manifest.content.baseline.runtimePolicy.ref]!;
    const runtimePolicyBytes = typeof runtimePolicyValue === 'string'
      ? Buffer.from(runtimePolicyValue, 'utf8')
      : Buffer.from(runtimePolicyValue);
    const approvedInstructionBytes = combineD4SmokeInstructionBytes(instructionBytes, runtimePolicyBytes);
    const bootstrapWorkspace = input.bootstrapWorkspace
      ?? createD4SmokeFilesystemWorkspaceAdapter().bootstrapWorkspace;
    await bootstrapWorkspace({
      plan: officialPlan,
      stage,
      instructionBytes,
      runtimePolicyBytes,
      forbiddenBoundaries,
    });
    auditCursor = await installD4SmokeAuditShims(plan.paths, plan.candidate, input.codexRuntime);
    if (provider === 'codex') {
      await verifyD4CodexOuterIsolation(officialPlan, canonicalPaths.claude);
    }
    const binding = buildExactModelBinding(officialPlan, approvedInstructionBytes, canonicalPaths);
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
    const window = d4SmokeDecisionWindow(plan.cell.profile, decisionIndex);
    const candidateSnapshot = cellData.decisionSnapshots[decisionIndex]!;
    const bars = candidateSnapshot['bars'];
    if (!Array.isArray(bars) || bars.length !== window.visibleEndExclusive) {
      throw new D4SmokePolicyError('proposal_boundary_invalid', `${plan.cell.id}: incomplete visible prefix`);
    }
    wakeId = opaqueD4SmokeWakeId(stage.manifestSha256, plan.shakedownExecutionId, decisionIndex);
    const fictionalAsOf = fictionalD4SmokeAsOf(decisionIndex);
    const prepared = await input.prepareDecision({
      executionId: plan.shakedownExecutionId,
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
      plan: officialPlan,
      cellData,
      decisionIndex,
      values: [prompt, ...prepared.candidateVisibleBytes],
    });
    // Fresh, reserve-gated read of this exact model's applicable native windows,
    // immediately before the single dispatch.
    const dispatchPhase = {
      kind: 'shakedown_dispatch',
      shakedownExecutionId: plan.shakedownExecutionId,
      decisionIndex,
      wakeId,
    } as const;
    dispatchQuota = validateD4EngineeringShakedownQuotaEvidence({
      evidence: await input.quotaReader(dispatchPhase, plan),
      manifestSha256: stage.manifestSha256,
      phase: dispatchPhase,
      modelId: plan.candidate.modelId,
      now: now(),
    });
    auditCursor = await syncD4SmokeAuditLedger(plan.paths.auditCallLedger, input.auditLedger, auditCursor);
    input.auditLedger.assertZero();
    let auditAppendFailure = false;
    const turnStartedAt = now();
    const outcome = await driver.runTurn(
      thread.threadId,
      prompt,
      {
        ...(input.deadlineMs !== undefined ? { deadlineMs: input.deadlineMs } : {}),
        model: plan.candidate.modelId,
        onEvent: (event) => {
          if (
            event.type === 'item-completed'
            && event.exitCode === 125
            && event.aggregatedOutput?.includes('D4_SMOKE_AUDIT_APPEND_FAILED')
          ) {
            auditAppendFailure = true;
          }
          if (event.type === 'token-usage') {
            tokenTelemetry = event.telemetry;
          }
        },
      },
    );
    latencyMs = now().getTime() - turnStartedAt.getTime();
    terminalStatus = outcome.status;
    turnInterrupted = outcome.interrupted;
    durationMs = outcome.durationMs;
    if (outcome.agentMessage?.includes('D4_SMOKE_AUDIT_APPEND_FAILED')) {
      auditAppendFailure = true;
    }
    // A settled provider turn may have consumed quota even when the very next
    // policy assertion rejects it. Capture the fresh observation before any
    // post-turn assertion so a strict failure artifact can preserve it.
    const postTurnPhase = {
      kind: 'shakedown_post_turn',
      shakedownExecutionId: plan.shakedownExecutionId,
      decisionIndex,
      wakeId,
    } as const;
    postTurnQuota = validateD4EngineeringShakedownQuotaEvidence({
      evidence: await input.quotaReader(postTurnPhase, plan),
      manifestSha256: stage.manifestSha256,
      phase: postTurnPhase,
      modelId: plan.candidate.modelId,
      now: now(),
    });
    tokenTelemetry = driver.readTelemetry(thread.threadId) ?? tokenTelemetry;
    modelAttestation = attestD4ModelRoles({
      outcome,
      provider,
      requestedModelId: plan.candidate.modelId,
      wakeId,
    });
    assertD4SuccessfulModelRoles({
      attestation: modelAttestation,
      provider,
      requestedModelId: plan.candidate.modelId,
      wakeId,
    });
    auditCursor = await syncD4SmokeAuditLedger(plan.paths.auditCallLedger, input.auditLedger, auditCursor);
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
      executionId: plan.shakedownExecutionId,
      wakeId,
      decisionIndex,
      workspaceDir: plan.paths.workspace,
      forbiddenBoundaries,
    });
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
    input.auditLedger.assertZero();
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
        auditCursor = await syncD4SmokeAuditLedger(plan.paths.auditCallLedger, input.auditLedger, auditCursor);
      }
    } catch (error) {
      cleanupError ??= error;
    }
    try {
      await credential.verifyUnchanged();
    } catch (error) {
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
        await releaseD4ClaudeBridgeTemp(plan.paths, provider);
      } catch (error) {
        cleanupError ??= error;
      }
      try {
        await releaseD4SmokeRuntimeForHost(plan.paths);
      } catch (error) {
        cleanupError ??= error;
      }
    }
    executionError ??= cleanupError;
  }
  if (executionError !== undefined) {
    if (
      dispatchQuota !== null
      && postTurnQuota !== null
      && wakeId !== null
      && terminalStatus === 'completed'
      && turnInterrupted === false
      && modelAttestation !== null
    ) {
      const artifact = assertD4EngineeringShakedownFailureNonInferential({
        schema: D4_ENGINEERING_SHAKEDOWN_FAILURE_SCHEMA,
        version: D4_ENGINEERING_SHAKEDOWN_FAILURE_VERSION,
        purpose: D4_ENGINEERING_SHAKEDOWN_FAILURE_PURPOSE,
        inferenceEligibility: 'forbidden',
        eligibleForInference: false,
        validForRanking: false,
        validForSurvivorSelection: false,
        validForOfficialSmoke: false,
        failureValidity: 'invalid',
        shakedownExecutionId: plan.shakedownExecutionId,
        manifestSha256: plan.manifestSha256,
        provider,
        requestedModelId: plan.candidate.modelId,
        modelAttestation,
        decisionIndex,
        wakeId,
        terminal: {
          providerReportedStatus: terminalStatus,
          interrupted: false,
        },
        durationMs,
        latencyMs,
        tokenTelemetry,
        quota: {
          dispatch: dispatchQuota,
          postTurn: postTurnQuota,
          windowDeltas: d4EngineeringShakedownWindowDeltas(dispatchQuota, postTurnQuota),
        },
        credential: credential.receipt(),
        capabilityAttempts: [...input.auditLedger.snapshot()],
        error: d4EngineeringShakedownFailureErrorDetail(executionError),
      });
      throw new D4EngineeringShakedownFailureError(artifact, { cause: executionError });
    }
    throw executionError;
  }

  const dispatch = dispatchQuota!;
  const postTurn = postTurnQuota!;
  const windowDeltas = d4EngineeringShakedownWindowDeltas(dispatch, postTurn);

  // Derive the exported diagnostic report from the internal official report,
  // which is never itself exposed (an official-shaped report could be pushed
  // into an official `reports[]`).
  const protocolVerdict = report!.protocol.verdict;
  if (protocolVerdict === 'not_evaluated') {
    throw new D4SmokePolicyError(
      'terminal_artifact_invalid',
      `${wakeId}: protocol verdict must be pass or fail`,
    );
  }
  const diagnosticReport: D4EngineeringShakedownDiagnosticReport = {
    schema: D4_ENGINEERING_SHAKEDOWN_DIAGNOSTIC_REPORT_SCHEMA,
    version: D4_ENGINEERING_SHAKEDOWN_DIAGNOSTIC_REPORT_VERSION,
    purpose: D4_ENGINEERING_SHAKEDOWN_PURPOSE,
    inferenceEligibility: 'forbidden',
    eligibleForInference: false,
    validForRanking: false,
    validForSurvivorSelection: false,
    validForOfficialSmoke: false,
    wakeId: wakeId!,
    protocolVerdict,
    decisionVerdict: report!.decision.verdict,
    executionVerdict: 'not_evaluated',
  };

  const result: D4EngineeringShakedownResult = {
    schema: D4_ENGINEERING_SHAKEDOWN_RESULT_SCHEMA,
    version: D4_ENGINEERING_SHAKEDOWN_RESULT_VERSION,
    purpose: D4_ENGINEERING_SHAKEDOWN_PURPOSE,
    inferenceEligibility: 'forbidden',
    eligibleForInference: false,
    validForRanking: false,
    validForSurvivorSelection: false,
    validForOfficialSmoke: false,
    shakedownExecutionId: plan.shakedownExecutionId,
    manifestSha256: plan.manifestSha256,
    provider,
    requestedModelId: plan.candidate.modelId,
    modelAttestation: modelAttestation!,
    decisionIndex,
    wakeId: wakeId!,
    terminalStatus: terminalStatus!,
    diagnosticReport,
    durationMs,
    latencyMs,
    tokenTelemetry,
    quota: { dispatch, postTurn, windowDeltas },
    credential: credential.receipt(),
    capabilityAttempts: [...input.auditLedger.snapshot()],
  };
  return assertD4EngineeringShakedownNonInferential(result);
}
