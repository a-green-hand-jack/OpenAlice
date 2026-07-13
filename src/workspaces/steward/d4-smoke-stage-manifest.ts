import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { isDeepStrictEqual, promisify } from 'node:util';

import { z } from 'zod';

import {
  sha256StewardEvaluationContent,
  stewardEvaluationDataManifestSchema,
  stewardEvaluationManifestContentIdentities,
  validateStewardEvaluationDataManifest,
  type StewardEvaluationDataManifest,
} from './evaluation-data-manifest.js';
import { canonicalizeJson } from './ledger-receipt.js';

const execFileAsync = promisify(execFile);

export const D4_SMOKE_STAGE_MANIFEST_SCHEMA = 'steward-d4-stage-manifest/1' as const;
export const D4_SMOKE_STAGE_MANIFEST_VERSION = 1 as const;
export const D4_SMOKE_CRITIC_RECEIPT_SCHEMA = 'steward-d4-critic-receipt/1' as const;
export const D4_SMOKE_CRITIC_RECEIPT_VERSION = 1 as const;
export const D4_SMOKE_CANDIDATE_CELL_SCHEMA = 'steward-d4-candidate-cell/1' as const;
export const D4_SMOKE_CANDIDATE_CELL_VERSION = 1 as const;
export const D4_SMOKE_CELL_AUDIT_SCHEMA = 'steward-d4-cell-audit/1' as const;
export const D4_SMOKE_CELL_AUDIT_VERSION = 1 as const;
export const D4_SMOKE_RUNTIME_TREE_SCHEMA = 'steward-d4-runtime-tree/1' as const;
export const D4_SMOKE_RUNTIME_TREE_VERSION = 1 as const;
export const D4_SMOKE_QUOTA_FORECAST_EVIDENCE_SCHEMA = 'steward-d4-quota-forecast-observations/1' as const;
export const D4_SMOKE_QUOTA_FORECAST_EVIDENCE_VERSION = 1 as const;

export const D4_SMOKE_AUTHORIZATION = 'AUTH-D4-DEV' as const;
export const D4_SMOKE_BASELINE_COMMIT = 'c8071ebf' as const;
export const D4_SMOKE_BEHAVIOR_VERSION = 'v9-RUNTIME' as const;
export const D4_SMOKE_INSTRUCTION_REF = 'src/workspaces/templates/steward/files/instruction.md' as const;
export const D4_SMOKE_STAGE_MANIFEST_REF =
  'tools/campaigns/data/d4-smoke-dev-a/stage-manifest.json' as const;
export const D4_SMOKE_INSTRUCTION_SHA256 =
  '2b76a194634015914807b8e6591fd72f00bf50647c8c57c665eec7c021a5803c' as const;
export const D4_SMOKE_RUNTIME_POLICY_REF =
  'src/workspaces/templates/steward/files/d4-smoke-runtime-policy.md' as const;
export const D4_SMOKE_RUNTIME_POLICY_SHA256 =
  'c46f434f813e59b4ba9979c95f5769fac49aca83361023e28b8143e0bf701de7' as const;
export const D4_SMOKE_REPETITIONS = ['r1'] as const;
export const D4_SMOKE_DECISION_COUNT = 12 as const;
export const D4_SMOKE_EXECUTION_COUNT = 108 as const;
export const D4_SMOKE_SYNTHETIC_ACCOUNT_ID = 'eval:d4-smoke:proposal-only' as const;
/** Exact repo-local runtime closure for the D4 watchdog entrypoint. This list
 * is intentionally explicit: directory scans can silently omit dependencies
 * imported from outside a selected subtree. */
export const D4_SMOKE_RUNTIME_TREE_FILES = [
  'src/workspaces/claude-autotrust-settings.ts',
  'src/workspaces/steward/d4-smoke-runner.ts',
  'src/workspaces/steward/d4-smoke-stage-manifest.ts',
  'src/workspaces/steward/evaluation-data-manifest.ts',
  'src/workspaces/steward/evaluation-harness.ts',
  'src/workspaces/steward/evaluation-provenance-store.ts',
  'src/workspaces/steward/finalize-store.ts',
  'src/workspaces/steward/injector.ts',
  'src/workspaces/steward/ledger-receipt.ts',
  'src/workspaces/steward/ledger-store.ts',
  'src/workspaces/steward/ledger-writer.ts',
  'src/workspaces/steward/machine-driver/claude-agent-sdk-driver.ts',
  'src/workspaces/steward/machine-driver/codex-app-server-driver.ts',
  'src/workspaces/steward/machine-driver/jsonrpc-stdio.ts',
  'src/workspaces/steward/machine-driver/types.ts',
  'src/workspaces/steward/paths.ts',
  'src/workspaces/steward/snapshot.ts',
  'src/workspaces/steward/types.ts',
  'src/workspaces/steward/wake-store.ts',
  'src/workspaces/templates/_common.mjs',
  'src/workspaces/templates/steward/bootstrap.mjs',
  'src/workspaces/templates/steward/files/d4-smoke-runtime-policy.md',
  'src/workspaces/templates/steward/files/decision-ledger.v3.json',
  'src/workspaces/templates/steward/README.md',
] as const;

export const D4_SMOKE_MARKETS = [
  'crypto-major',
  'us-index-etf',
  'us-single',
  'gcn-equity',
  'fx',
  'commodity-proxy',
] as const;

export const D4_SMOKE_PROFILES = {
  bull: {
    barInterval: '1d',
    decisionCadenceBars: 5,
    lookbackBars: 60,
    decisionCount: D4_SMOKE_DECISION_COUNT,
    totalBars: 120,
    finalVisibleEndExclusive: 115,
  },
  bear: {
    barInterval: '4h',
    decisionCadenceBars: 6,
    lookbackBars: 90,
    decisionCount: D4_SMOKE_DECISION_COUNT,
    totalBars: 162,
    finalVisibleEndExclusive: 156,
  },
} as const;

export const D4_SMOKE_CANDIDATES = [
  {
    provider: 'codex',
    runtime: 'Codex CLI',
    runtimeVersion: '0.144.0',
    subscription: 'ChatGPT subscription',
    modelId: 'gpt-5.6-sol',
  },
  {
    provider: 'codex',
    runtime: 'Codex CLI',
    runtimeVersion: '0.144.0',
    subscription: 'ChatGPT subscription',
    modelId: 'gpt-5.6-terra',
  },
  {
    provider: 'codex',
    runtime: 'Codex CLI',
    runtimeVersion: '0.144.0',
    subscription: 'ChatGPT subscription',
    modelId: 'gpt-5.6-luna',
  },
  {
    provider: 'codex',
    runtime: 'Codex CLI',
    runtimeVersion: '0.144.0',
    subscription: 'ChatGPT subscription',
    modelId: 'gpt-5.5',
  },
  {
    provider: 'codex',
    runtime: 'Codex CLI',
    runtimeVersion: '0.144.0',
    subscription: 'ChatGPT subscription (Spark window)',
    modelId: 'gpt-5.3-codex-spark',
  },
  {
    provider: 'claude',
    runtime: 'Claude Code',
    runtimeVersion: '2.1.202',
    subscription: 'Claude Max',
    modelId: 'claude-fable-5',
  },
  {
    provider: 'claude',
    runtime: 'Claude Code',
    runtimeVersion: '2.1.202',
    subscription: 'Claude Max',
    modelId: 'claude-sonnet-5',
  },
  {
    provider: 'claude',
    runtime: 'Claude Code',
    runtimeVersion: '2.1.202',
    subscription: 'Claude Max',
    modelId: 'claude-opus-4-8',
  },
  {
    provider: 'claude',
    runtime: 'Claude Code',
    runtimeVersion: '2.1.202',
    subscription: 'Claude Max',
    modelId: 'claude-haiku-4-5-20251001',
  },
] as const;

export const D4_SMOKE_FORBIDDEN_CAPABILITIES = [
  'account_create',
  'account_edit',
  'account_elevate',
  'uta_mutation',
  'execution_record_publish',
  'stage',
  'auto_push',
] as const;

export const D4_SMOKE_CREDENTIAL_SOURCES = [
  { provider: 'codex', sourceIdentity: 'codex-subscription-oauth' },
  { provider: 'claude', sourceIdentity: 'claude-max-oauth' },
] as const;

export const D4_SMOKE_QUOTA_WINDOWS = [
  {
    id: 'codex-general-weekly', provider: 'codex', calibrationTurnCount: 4, applicableModelTurnCount: 576,
  },
  { id: 'codex-spark', provider: 'codex', calibrationTurnCount: 1, applicableModelTurnCount: 144 },
  {
    id: 'claude-all-model-weekly', provider: 'claude', calibrationTurnCount: 4, applicableModelTurnCount: 576,
  },
  { id: 'claude-fable-weekly', provider: 'claude', calibrationTurnCount: 1, applicableModelTurnCount: 144 },
  {
    id: 'claude-current-short', provider: 'claude', calibrationTurnCount: 4, applicableModelTurnCount: 576,
  },
] as const;

const nonEmptyStringSchema = z.string().trim().min(1);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const isoTimestampSchema = z.iso.datetime({ offset: true });
const providerSchema = z.enum(['codex', 'claude']);
const marketSchema = z.enum(D4_SMOKE_MARKETS);
const profileSchema = z.enum(['bull', 'bear']);
const contentIdentitySchema = z.object({
  ref: nonEmptyStringSchema,
  sha256: sha256Schema,
}).strict();
const receiptIdentitySchema = contentIdentitySchema.extend({
  canonicalByteLength: z.number().int().positive(),
  barCount: z.number().int().positive(),
}).strict();

const quotaObservationSnapshotSchema = z.object({
  capturedAt: isoTimestampSchema,
  raw: contentIdentitySchema,
}).strict();

const quotaResolutionFields = {
  resolutionPercent: z.number().finite().positive().max(100),
} as const;

const codexQuotaObservationSchema = z.object({
  id: nonEmptyStringSchema,
  provider: z.literal('codex'),
  charges: z.tuple([
    z.object({
      id: z.literal('codex-general-weekly'),
      chargedTurnCount: z.literal(4),
      ...quotaResolutionFields,
    }).strict(),
    z.object({ id: z.literal('codex-spark'), chargedTurnCount: z.literal(1), ...quotaResolutionFields }).strict(),
  ]),
  before: quotaObservationSnapshotSchema,
  after: quotaObservationSnapshotSchema,
}).strict();

const claudeQuotaObservationSchema = z.object({
  id: nonEmptyStringSchema,
  provider: z.literal('claude'),
  charges: z.tuple([
    z.object({
      id: z.literal('claude-all-model-weekly'),
      chargedTurnCount: z.literal(4),
      ...quotaResolutionFields,
    }).strict(),
    z.object({
      id: z.literal('claude-fable-weekly'),
      chargedTurnCount: z.literal(1),
      ...quotaResolutionFields,
    }).strict(),
    z.object({
      id: z.literal('claude-current-short'),
      chargedTurnCount: z.literal(4),
      ...quotaResolutionFields,
    }).strict(),
  ]),
  before: quotaObservationSnapshotSchema,
  after: quotaObservationSnapshotSchema,
}).strict();

export const d4SmokeQuotaForecastEvidenceSchema = z.object({
  schema: z.literal(D4_SMOKE_QUOTA_FORECAST_EVIDENCE_SCHEMA),
  version: z.literal(D4_SMOKE_QUOTA_FORECAST_EVIDENCE_VERSION),
  sourceIdentity: z.literal('native-subscription-controls'),
  observations: z.array(z.discriminatedUnion('provider', [
    codexQuotaObservationSchema,
    claudeQuotaObservationSchema,
  ])).min(2),
}).strict();

const candidateSchema = z.object({
  provider: providerSchema,
  runtime: z.enum(['Codex CLI', 'Claude Code']),
  runtimeVersion: nonEmptyStringSchema,
  subscription: nonEmptyStringSchema,
  modelId: nonEmptyStringSchema,
}).strict();

const instrumentSchema = z.object({
  provider: nonEmptyStringSchema,
  symbol: nonEmptyStringSchema,
  datasetName: nonEmptyStringSchema,
  assetClass: nonEmptyStringSchema,
  timezone: nonEmptyStringSchema,
  exchangeCalendar: nonEmptyStringSchema,
  providerAdjustmentMode: nonEmptyStringSchema,
  candidateAdjustmentMode: nonEmptyStringSchema,
  d3AdjustmentMode: z.literal('unadjusted'),
}).strict();

const runtimeTreeEntrySchema = z.object({
  path: nonEmptyStringSchema,
  sha256: sha256Schema,
  byteLength: z.number().int().nonnegative(),
}).strict();

const runtimeTreeIdentitySchema = z.object({
  schema: z.literal(D4_SMOKE_RUNTIME_TREE_SCHEMA),
  version: z.literal(D4_SMOKE_RUNTIME_TREE_VERSION),
  files: z.array(nonEmptyStringSchema).length(D4_SMOKE_RUNTIME_TREE_FILES.length),
  entries: z.array(runtimeTreeEntrySchema).min(1),
  sha256: sha256Schema,
}).strict();

const temporalSchema = z.object({
  barInterval: z.enum(['1d', '4h']),
  decisionCadenceBars: z.number().int().positive(),
  lookbackBars: z.number().int().positive(),
  decisionCount: z.literal(D4_SMOKE_DECISION_COUNT),
  totalBars: z.number().int().positive(),
  finalVisibleEndExclusive: z.number().int().positive(),
}).strict();

const cellSchema = z.object({
  id: nonEmptyStringSchema,
  market: marketSchema,
  profile: profileSchema,
  window: z.literal('a'),
  split: z.literal('dev'),
  stratum: nonEmptyStringSchema,
  pairingKey: nonEmptyStringSchema,
  temporal: temporalSchema,
  instrument: instrumentSchema,
  asOf: z.object({
    decisionStart: isoTimestampSchema,
    decisionEnd: isoTimestampSchema,
    outcomeEnd: isoTimestampSchema,
  }).strict(),
  evidence: z.object({
    candidatePayload: contentIdentitySchema,
    audit: contentIdentitySchema,
    sourceReceipt: contentIdentitySchema,
    splitEvidence: contentIdentitySchema,
    samplingPlan: contentIdentitySchema,
    selectedRaw: receiptIdentitySchema,
    selectedDerived: receiptIdentitySchema,
  }).strict(),
}).strict();

const stageManifestContentSchema = z.object({
  authorization: z.literal(D4_SMOKE_AUTHORIZATION),
  stage: z.literal('Smoke'),
  split: z.literal('dev'),
  baseline: z.object({
    commit: z.literal(D4_SMOKE_BASELINE_COMMIT),
    behaviorVersion: z.literal(D4_SMOKE_BEHAVIOR_VERSION),
    instruction: z.object({
      ref: z.literal(D4_SMOKE_INSTRUCTION_REF),
      sha256: z.literal(D4_SMOKE_INSTRUCTION_SHA256),
    }).strict(),
    runtimePolicy: z.object({
      ref: z.literal(D4_SMOKE_RUNTIME_POLICY_REF),
      sha256: z.literal(D4_SMOKE_RUNTIME_POLICY_SHA256),
    }).strict(),
    quotaForecastEvidence: contentIdentitySchema,
    runtimeTree: runtimeTreeIdentitySchema,
  }).strict(),
  proposalOnly: z.object({
    authzLevel: z.literal('read_only'),
    accountId: z.literal(D4_SMOKE_SYNTHETIC_ACCOUNT_ID),
    configuredUta: z.literal(false),
    outputs: z.tuple([z.literal('decision_intent'), z.literal('information_snapshot')]),
    forbiddenCapabilities: z.tuple(D4_SMOKE_FORBIDDEN_CAPABILITIES.map((value) => z.literal(value)) as [
      z.ZodLiteral<'account_create'>,
      z.ZodLiteral<'account_edit'>,
      z.ZodLiteral<'account_elevate'>,
      z.ZodLiteral<'uta_mutation'>,
      z.ZodLiteral<'execution_record_publish'>,
      z.ZodLiteral<'stage'>,
      z.ZodLiteral<'auto_push'>,
    ]),
  }).strict(),
  credentialSources: z.tuple([
    z.object({ provider: z.literal('codex'), sourceIdentity: z.literal('codex-subscription-oauth') }).strict(),
    z.object({ provider: z.literal('claude'), sourceIdentity: z.literal('claude-max-oauth') }).strict(),
  ]),
  candidates: z.array(candidateSchema),
  repetitions: z.array(nonEmptyStringSchema),
  cells: z.array(cellSchema),
}).strict();

export const d4SmokeStageManifestSchema = z.object({
  schema: z.literal(D4_SMOKE_STAGE_MANIFEST_SCHEMA),
  version: z.literal(D4_SMOKE_STAGE_MANIFEST_VERSION),
  content: stageManifestContentSchema,
}).strict();

export const d4SmokeCriticReceiptSchema = z.object({
  schema: z.literal(D4_SMOKE_CRITIC_RECEIPT_SCHEMA),
  version: z.literal(D4_SMOKE_CRITIC_RECEIPT_VERSION),
  manifestSha256: sha256Schema,
  reviewerIdentity: nonEmptyStringSchema,
  verdict: z.enum(['APPROVE', 'REJECT']),
  reviewedCommit: z.string().regex(/^[0-9a-f]{7,40}$/),
}).strict();

const candidateBarSchema = z.object({
  index: z.number().int().nonnegative(),
  open: z.number().finite(),
  high: z.number().finite(),
  low: z.number().finite(),
  close: z.number().finite(),
  volume: z.number().finite().nonnegative(),
}).strict();

const candidateDecisionSchema = z.object({
  ordinal: z.number().int().min(1).max(D4_SMOKE_DECISION_COUNT),
  visibleStart: z.literal(0),
  visibleEndExclusive: z.number().int().positive(),
  visibleBarCount: z.number().int().positive(),
  asOfBarIndex: z.number().int().nonnegative(),
}).strict();

export const d4SmokeCandidateCellSchema = z.object({
  schema: z.literal(D4_SMOKE_CANDIDATE_CELL_SCHEMA),
  version: z.literal(D4_SMOKE_CANDIDATE_CELL_VERSION),
  cellId: nonEmptyStringSchema,
  split: z.literal('dev'),
  window: z.literal('a'),
  profile: profileSchema,
  codename: nonEmptyStringSchema,
  interval: z.enum(['1d', '4h']),
  decisions: z.array(candidateDecisionSchema).length(D4_SMOKE_DECISION_COUNT),
  bars: z.array(candidateBarSchema),
}).passthrough();

const auditActionSchema = z.object({
  artifact: z.unknown(),
  content: contentIdentitySchema,
}).passthrough();

export const d4SmokeCellAuditSchema = z.object({
  schema: z.literal(D4_SMOKE_CELL_AUDIT_SCHEMA),
  version: z.literal(D4_SMOKE_CELL_AUDIT_VERSION),
  cellId: nonEmptyStringSchema,
  split: z.literal('dev'),
  sourceReceipt: z.object({
    selectedRaw: receiptIdentitySchema,
    selectedDerived: receiptIdentitySchema,
  }).passthrough(),
  universeEvidence: z.unknown(),
  splitEvidence: z.object({
    actions: z.array(auditActionSchema),
  }).passthrough(),
  decisionManifests: z.array(stewardEvaluationDataManifestSchema).length(D4_SMOKE_DECISION_COUNT),
}).passthrough();

export type D4SmokeStageManifest = z.infer<typeof d4SmokeStageManifestSchema>;
export type D4SmokeStageManifestContent = z.infer<typeof stageManifestContentSchema>;
export type D4SmokeCriticReceipt = z.infer<typeof d4SmokeCriticReceiptSchema>;
export type D4SmokeCell = D4SmokeStageManifestContent['cells'][number];
export type D4SmokeCandidate = D4SmokeStageManifestContent['candidates'][number];
export type D4SmokeCandidateCell = z.infer<typeof d4SmokeCandidateCellSchema>;
export type D4SmokeCellAudit = z.infer<typeof d4SmokeCellAuditSchema>;
export type D4SmokeBar = D4SmokeCandidateCell['bars'][number];
export type D4SmokeForbiddenCapability = typeof D4_SMOKE_FORBIDDEN_CAPABILITIES[number];
export type D4SmokeRuntimeTreeIdentity = z.infer<typeof runtimeTreeIdentitySchema>;
export type D4SmokeQuotaForecastEvidence = z.infer<typeof d4SmokeQuotaForecastEvidenceSchema>;

export interface ValidatedD4SmokeCellData {
  readonly candidate: D4SmokeCandidateCell;
  readonly audit: D4SmokeCellAudit;
  readonly decisionSnapshots: readonly Readonly<Record<string, unknown>>[];
  readonly decisionManifests: readonly StewardEvaluationDataManifest[];
  readonly contentByRef: Readonly<Record<string, Uint8Array>>;
}

export interface ValidatedD4SmokeStage {
  readonly manifest: D4SmokeStageManifest;
  readonly manifestSha256: string;
  readonly receipt: D4SmokeCriticReceipt;
  readonly quotaForecastEvidence: D4SmokeQuotaForecastEvidence;
  readonly contentByCellId: ReadonlyMap<string, ValidatedD4SmokeCellData>;
}

export type D4SmokeManifestErrorCode =
  | 'shape_invalid'
  | 'manifest_not_canonical'
  | 'manifest_hash_mismatch'
  | 'manifest_not_committed'
  | 'critic_receipt_invalid'
  | 'critic_not_approved'
  | 'reviewed_commit_not_ancestor'
  | 'runtime_tree_drift'
  | 'candidate_drift'
  | 'repetition_drift'
  | 'cell_roster_drift'
  | 'cell_contract_invalid'
  | 'holdout_forbidden'
  | 'content_unverified'
  | 'content_hash_mismatch'
  | 'content_shape_invalid';

export class D4SmokeManifestError extends Error {
  constructor(readonly code: D4SmokeManifestErrorCode, detail: string, options?: { cause?: unknown }) {
    super(`D4 Smoke manifest ${code}: ${detail}`, options);
    this.name = 'D4SmokeManifestError';
  }
}

export function canonicalD4SmokeManifestContentBytes(content: unknown): Buffer {
  const parsed = stageManifestContentSchema.parse(content);
  return Buffer.from(JSON.stringify(canonicalizeJson(parsed)), 'utf8');
}

export function canonicalD4SmokeManifestBytes(manifest: unknown): Buffer {
  const parsed = d4SmokeStageManifestSchema.parse(manifest);
  return Buffer.from(`${JSON.stringify(canonicalizeJson(parsed), null, 2)}\n`, 'utf8');
}

export function sha256D4SmokeManifestBytes(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function canonicalD4SmokeRuntimeTreeBytes(
  value: Pick<D4SmokeRuntimeTreeIdentity, 'schema' | 'version' | 'files' | 'entries'>,
): Buffer {
  return Buffer.from(`${JSON.stringify(canonicalizeJson(value))}\n`, 'utf8');
}

export async function computeD4SmokeRuntimeTreeIdentity(input: {
  readonly repoRoot: string;
  readonly revision?: string;
}): Promise<D4SmokeRuntimeTreeIdentity> {
  const repoRoot = resolve(input.repoRoot);
  const paths = await listD4SmokeRuntimeTreePaths(repoRoot, input.revision);
  const entries = await Promise.all(paths.map(async (path) => {
    const bytes = input.revision === undefined
      ? await readRuntimeTreeWorktreeFile(repoRoot, path)
      : await readRuntimeTreeRevisionFile(repoRoot, input.revision, path);
    return {
      path,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      byteLength: bytes.byteLength,
    };
  }));
  const base = {
    schema: D4_SMOKE_RUNTIME_TREE_SCHEMA,
    version: D4_SMOKE_RUNTIME_TREE_VERSION,
    files: [...D4_SMOKE_RUNTIME_TREE_FILES],
    entries,
  };
  return runtimeTreeIdentitySchema.parse({
    ...base,
    sha256: createHash('sha256').update(canonicalD4SmokeRuntimeTreeBytes(base)).digest('hex'),
  });
}

export interface D4SmokeStageManifestArtifact {
  readonly manifest: D4SmokeStageManifest;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

export function buildD4SmokeStageManifest(content: unknown): D4SmokeStageManifestArtifact {
  const parsed = stageManifestContentSchema.parse(content);
  const manifest = d4SmokeStageManifestSchema.parse({
    schema: D4_SMOKE_STAGE_MANIFEST_SCHEMA,
    version: D4_SMOKE_STAGE_MANIFEST_VERSION,
    content: parsed,
  });
  const bytes = canonicalD4SmokeManifestBytes(manifest);
  return { manifest, bytes, sha256: sha256D4SmokeManifestBytes(bytes) };
}

export function expectedD4SmokeCellIds(): readonly string[] {
  return D4_SMOKE_MARKETS.flatMap((market) => [
    `d4-${market}-bull-a`,
    `d4-${market}-bear-a`,
  ]);
}

export function d4SmokeDecisionWindow(
  profile: keyof typeof D4_SMOKE_PROFILES,
  decisionIndex: number,
): { readonly visibleStart: 0; readonly visibleEndExclusive: number; readonly asOfBarIndex: number } {
  if (!Number.isInteger(decisionIndex) || decisionIndex < 0 || decisionIndex >= D4_SMOKE_DECISION_COUNT) {
    throw new RangeError(`D4 Smoke decision index must be 0..${D4_SMOKE_DECISION_COUNT - 1}`);
  }
  const spec = D4_SMOKE_PROFILES[profile];
  const visibleEndExclusive = spec.lookbackBars + decisionIndex * spec.decisionCadenceBars;
  return { visibleStart: 0, visibleEndExclusive, asOfBarIndex: visibleEndExclusive - 1 };
}

export interface D4SmokeGitVerification {
  readonly head: string;
  readonly reviewedCommitIsAncestor: boolean;
  readonly reviewedManifestMatches: boolean;
  readonly headManifestMatches: boolean;
  readonly reviewedRuntimeTreeMatches: boolean;
  readonly headRuntimeTreeMatches: boolean;
  readonly worktreeRuntimeTreeMatches: boolean;
}

export type D4SmokeGitVerifier = (input: {
  readonly repoRoot: string;
  readonly reviewedCommit: string;
  readonly manifestBytes: Uint8Array;
  readonly runtimeTree: D4SmokeRuntimeTreeIdentity;
}) => Promise<D4SmokeGitVerification>;

export async function validateD4SmokeStage(input: {
  readonly manifestBytes: string | Uint8Array;
  readonly receipt: unknown;
  readonly repoRoot: string;
  readonly gitVerifier?: D4SmokeGitVerifier;
  readonly contentByRef: Readonly<Record<string, string | Uint8Array>>;
}): Promise<ValidatedD4SmokeStage> {
  const rawBytes = typeof input.manifestBytes === 'string'
    ? Buffer.from(input.manifestBytes, 'utf8')
    : Buffer.from(input.manifestBytes);
  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBytes));
  } catch (error) {
    throw new D4SmokeManifestError('shape_invalid', 'manifest bytes are not UTF-8 JSON', { cause: error });
  }
  const manifestResult = d4SmokeStageManifestSchema.safeParse(rawManifest);
  if (!manifestResult.success) {
    throw new D4SmokeManifestError('shape_invalid', formatZodError(manifestResult.error));
  }
  const manifest = manifestResult.data;
  const canonicalBytes = canonicalD4SmokeManifestBytes(manifest);
  if (!rawBytes.equals(canonicalBytes)) {
    throw new D4SmokeManifestError(
      'manifest_not_canonical',
      'raw bytes must equal the versioned canonical JSON encoding',
    );
  }
  const manifestSha256 = sha256D4SmokeManifestBytes(rawBytes);

  const receiptResult = d4SmokeCriticReceiptSchema.safeParse(input.receipt);
  if (!receiptResult.success) {
    throw new D4SmokeManifestError('critic_receipt_invalid', formatZodError(receiptResult.error));
  }
  const receipt = receiptResult.data;
  if (receipt.manifestSha256 !== manifestSha256) {
    throw new D4SmokeManifestError(
      'manifest_hash_mismatch',
      `receipt binds ${receipt.manifestSha256}, raw manifest bytes are ${manifestSha256}`,
    );
  }
  if (receipt.verdict !== 'APPROVE') {
    throw new D4SmokeManifestError('critic_not_approved', receipt.verdict);
  }
  validateRuntimeTreeIdentity(manifest.content.baseline.runtimeTree);
  const verification = await (input.gitVerifier ?? verifyReviewedCommitAgainstHead)({
    repoRoot: input.repoRoot,
    reviewedCommit: receipt.reviewedCommit,
    manifestBytes: rawBytes,
    runtimeTree: manifest.content.baseline.runtimeTree,
  });
  if (!verification.reviewedCommitIsAncestor) {
    throw new D4SmokeManifestError(
      'reviewed_commit_not_ancestor',
      `${receipt.reviewedCommit} is not an ancestor of HEAD ${verification.head}`,
    );
  }
  if (!verification.reviewedManifestMatches || !verification.headManifestMatches) {
    throw new D4SmokeManifestError(
      'manifest_not_committed',
      `${D4_SMOKE_STAGE_MANIFEST_REF} must match the approved bytes at both reviewed commit and HEAD`,
    );
  }
  if (
    !verification.reviewedRuntimeTreeMatches
    || !verification.headRuntimeTreeMatches
    || !verification.worktreeRuntimeTreeMatches
  ) {
    throw new D4SmokeManifestError(
      'runtime_tree_drift',
      'approved runtime-tree bytes must match the reviewed commit, HEAD, and current worktree',
    );
  }

  if (!isDeepStrictEqual(manifest.content.candidates, D4_SMOKE_CANDIDATES)) {
    throw new D4SmokeManifestError('candidate_drift', 'Smoke candidates must equal the frozen G2 roster');
  }
  if (!isDeepStrictEqual(manifest.content.repetitions, D4_SMOKE_REPETITIONS)) {
    throw new D4SmokeManifestError('repetition_drift', 'Smoke repetitions must be exactly ["r1"]');
  }
  if (containsHoldout(manifest.content)) {
    throw new D4SmokeManifestError('holdout_forbidden', 'manifest contains a holdout ref or value');
  }

  const expectedIds = expectedD4SmokeCellIds();
  const actualIds = manifest.content.cells.map((cell) => cell.id);
  if (!isDeepStrictEqual(actualIds, expectedIds)) {
    throw new D4SmokeManifestError(
      'cell_roster_drift',
      `expected canonical cells ${expectedIds.join(',')}; received ${actualIds.join(',')}`,
    );
  }

  verifyContentIdentity(
    manifest.content.baseline.instruction,
    input.contentByRef,
    'instruction',
  );
  verifyContentIdentity(
    manifest.content.baseline.runtimePolicy,
    input.contentByRef,
    'runtime-policy',
  );
  const quotaForecastBytes = verifyContentIdentity(
    manifest.content.baseline.quotaForecastEvidence,
    input.contentByRef,
    'quota-forecast-evidence',
  );
  const quotaForecastResult = d4SmokeQuotaForecastEvidenceSchema.safeParse(
    parseJsonBytes(quotaForecastBytes, 'quota-forecast-evidence'),
  );
  if (!quotaForecastResult.success) {
    throw new D4SmokeManifestError(
      'content_shape_invalid',
      `quota-forecast-evidence: ${formatZodError(quotaForecastResult.error)}`,
    );
  }
  const quotaForecastEvidence = quotaForecastResult.data;
  const observationIds = quotaForecastEvidence.observations.map((observation) => observation.id);
  if (new Set(observationIds).size !== observationIds.length) {
    throw new D4SmokeManifestError('content_shape_invalid', 'quota forecast observation ids must be unique');
  }
  const observedProviders = new Set(
    quotaForecastEvidence.observations.map((observation) => observation.provider),
  );
  if (!observedProviders.has('codex') || !observedProviders.has('claude')) {
    throw new D4SmokeManifestError(
      'content_shape_invalid',
      'quota forecast evidence requires at least one provider-specific observation for Codex and Claude',
    );
  }
  const observedWindows = new Set(
    quotaForecastEvidence.observations.flatMap(
      (observation) => observation.charges.map((charge) => charge.id),
    ),
  );
  if (D4_SMOKE_QUOTA_WINDOWS.some(({ id }) => !observedWindows.has(id))) {
    throw new D4SmokeManifestError(
      'content_shape_invalid',
      'quota forecast evidence does not cover every frozen quota window',
    );
  }
  for (const observation of quotaForecastEvidence.observations) {
    if (Date.parse(observation.after.capturedAt) <= Date.parse(observation.before.capturedAt)) {
      throw new D4SmokeManifestError(
        'content_shape_invalid',
        `${observation.id}: quota observation after must follow before`,
      );
    }
    for (const [label, identity] of [
      [`before.${observation.provider}`, observation.before.raw],
      [`after.${observation.provider}`, observation.after.raw],
    ] as const) {
      if (containsHoldout(identity.ref)) {
        throw new D4SmokeManifestError('holdout_forbidden', `${observation.id}:${label}`);
      }
      verifyContentIdentity(identity, input.contentByRef, `${observation.id}:${label}`);
    }
  }
  const contentByCellId = new Map<string, ValidatedD4SmokeCellData>();
  for (const cell of manifest.content.cells) {
    validateCellContract(cell);
    const candidateBytes = verifyContentIdentity(
      cell.evidence.candidatePayload,
      input.contentByRef,
      `${cell.id}:candidate`,
    );
    const auditBytes = verifyContentIdentity(
      cell.evidence.audit,
      input.contentByRef,
      `${cell.id}:audit`,
    );
    const samplingPlanBytes = verifyContentIdentity(
      cell.evidence.samplingPlan,
      input.contentByRef,
      `${cell.id}:sampling-plan`,
    );
    const data = parseAndValidateCellData({
      cell,
      candidateBytes,
      auditBytes,
      samplingPlanBytes,
    });
    contentByCellId.set(cell.id, data);
  }

  return {
    manifest,
    manifestSha256,
    receipt,
    quotaForecastEvidence,
    contentByCellId,
  };
}

async function verifyReviewedCommitAgainstHead(input: {
  readonly repoRoot: string;
  readonly reviewedCommit: string;
  readonly manifestBytes: Uint8Array;
  readonly runtimeTree: D4SmokeRuntimeTreeIdentity;
}): Promise<D4SmokeGitVerification> {
  let head: string;
  let reviewedManifestBytes: string;
  let headManifestBytes: string;
  try {
    const headResult = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: input.repoRoot,
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });
    head = headResult.stdout.trim();
    await execFileAsync('git', ['merge-base', '--is-ancestor', input.reviewedCommit, head], {
      cwd: input.repoRoot,
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });
    const [reviewedManifest, headManifest] = await Promise.all([
      execFileAsync('git', ['show', `${input.reviewedCommit}:${D4_SMOKE_STAGE_MANIFEST_REF}`], {
        cwd: input.repoRoot,
        timeout: 5_000,
        maxBuffer: 4 * 1024 * 1024,
      }),
      execFileAsync('git', ['show', `${head}:${D4_SMOKE_STAGE_MANIFEST_REF}`], {
        cwd: input.repoRoot,
        timeout: 5_000,
        maxBuffer: 4 * 1024 * 1024,
      }),
    ]);
    reviewedManifestBytes = reviewedManifest.stdout;
    headManifestBytes = headManifest.stdout;
  } catch (error) {
    throw new D4SmokeManifestError(
      'reviewed_commit_not_ancestor',
      `cannot prove ${input.reviewedCommit} is an ancestor of current HEAD`,
      { cause: error },
    );
  }
  const manifestBytes = Buffer.from(input.manifestBytes);
  const [reviewedRuntimeTree, headRuntimeTree, worktreeRuntimeTree] = await Promise.all([
    computeD4SmokeRuntimeTreeIdentity({ repoRoot: input.repoRoot, revision: input.reviewedCommit }),
    computeD4SmokeRuntimeTreeIdentity({ repoRoot: input.repoRoot, revision: head }),
    computeD4SmokeRuntimeTreeIdentity({ repoRoot: input.repoRoot }),
  ]);
  return {
    head,
    reviewedCommitIsAncestor: true,
    reviewedManifestMatches: Buffer.from(reviewedManifestBytes, 'utf8').equals(manifestBytes),
    headManifestMatches: Buffer.from(headManifestBytes, 'utf8').equals(manifestBytes),
    reviewedRuntimeTreeMatches: isDeepStrictEqual(reviewedRuntimeTree, input.runtimeTree),
    headRuntimeTreeMatches: isDeepStrictEqual(headRuntimeTree, input.runtimeTree),
    worktreeRuntimeTreeMatches: isDeepStrictEqual(worktreeRuntimeTree, input.runtimeTree),
  };
}

function validateCellContract(cell: D4SmokeCell): void {
  const expectedId = `d4-${cell.market}-${cell.profile}-a`;
  const expectedTemporal = D4_SMOKE_PROFILES[cell.profile];
  if (cell.id !== expectedId) {
    throw new D4SmokeManifestError('cell_contract_invalid', `${cell.id}: expected id ${expectedId}`);
  }
  if (cell.pairingKey !== cell.id) {
    throw new D4SmokeManifestError('cell_contract_invalid', `${cell.id}: pairingKey must equal cell id`);
  }
  if (cell.stratum !== `${cell.market}:${cell.profile}`) {
    throw new D4SmokeManifestError(
      'cell_contract_invalid',
      `${cell.id}: stratum must be ${cell.market}:${cell.profile}`,
    );
  }
  if (!isDeepStrictEqual(cell.temporal, expectedTemporal)) {
    throw new D4SmokeManifestError(
      'cell_contract_invalid',
      `${cell.id}: temporal profile differs from frozen ${cell.profile}`,
    );
  }
  for (const identity of Object.values(cell.evidence)) {
    if (containsHoldout(identity.ref)) {
      throw new D4SmokeManifestError('holdout_forbidden', `${cell.id}: ${identity.ref}`);
    }
  }
}

function validateCandidateCellData(cell: D4SmokeCell, data: D4SmokeCandidateCell): void {
  if (data.cellId !== cell.id || data.profile !== cell.profile || data.window !== cell.window) {
    throw new D4SmokeManifestError('content_shape_invalid', `${cell.id}: candidate identity differs`);
  }
  if (data.interval !== cell.temporal.barInterval) {
    throw new D4SmokeManifestError('content_shape_invalid', `${cell.id}: candidate interval differs`);
  }
  if (data.codename.trim() === cell.instrument.symbol.trim()) {
    throw new D4SmokeManifestError('content_shape_invalid', `${cell.id}: candidate codename exposes raw symbol`);
  }
  if (data.bars.length !== cell.temporal.totalBars) {
    throw new D4SmokeManifestError(
      'content_shape_invalid',
      `${cell.id}: expected exactly ${cell.temporal.totalBars} bars, received ${data.bars.length}`,
    );
  }
  for (const [index, bar] of data.bars.entries()) {
    if (bar.index !== index) {
      throw new D4SmokeManifestError('content_shape_invalid', `${cell.id}: bar ${index} has index ${bar.index}`);
    }
    if (bar.high < Math.max(bar.open, bar.close) || bar.low > Math.min(bar.open, bar.close) || bar.low > bar.high) {
      throw new D4SmokeManifestError('content_shape_invalid', `${cell.id}: bar ${index} has invalid OHLC bounds`);
    }
  }

  const first = d4SmokeDecisionWindow(cell.profile, 0);
  const final = d4SmokeDecisionWindow(cell.profile, D4_SMOKE_DECISION_COUNT - 1);
  if (first.visibleEndExclusive !== cell.temporal.lookbackBars) {
    throw new D4SmokeManifestError('cell_contract_invalid', `${cell.id}: first prefix is not the frozen lookback`);
  }
  if (final.visibleEndExclusive !== cell.temporal.finalVisibleEndExclusive) {
    throw new D4SmokeManifestError('cell_contract_invalid', `${cell.id}: final prefix boundary drifted`);
  }
  if (cell.temporal.totalBars !== cell.temporal.lookbackBars
    + D4_SMOKE_DECISION_COUNT * cell.temporal.decisionCadenceBars) {
    throw new D4SmokeManifestError('cell_contract_invalid', `${cell.id}: T must equal L + D*C`);
  }
  if (cell.temporal.totalBars - final.visibleEndExclusive !== cell.temporal.decisionCadenceBars) {
    throw new D4SmokeManifestError('cell_contract_invalid', `${cell.id}: final outcome-only suffix must be exactly C bars`);
  }
  for (const [decisionIndex, decision] of data.decisions.entries()) {
    const expected = d4SmokeDecisionWindow(cell.profile, decisionIndex);
    if (!isDeepStrictEqual(decision, {
      ordinal: decisionIndex + 1,
      visibleStart: expected.visibleStart,
      visibleEndExclusive: expected.visibleEndExclusive,
      visibleBarCount: expected.visibleEndExclusive,
      asOfBarIndex: expected.asOfBarIndex,
    })) {
      throw new D4SmokeManifestError(
        'content_shape_invalid',
        `${cell.id}: decision ${decisionIndex + 1} visibility differs from frozen profile`,
      );
    }
  }
}

function verifyContentIdentity(
  identity: { readonly ref: string; readonly sha256: string },
  contentByRef: Readonly<Record<string, string | Uint8Array>>,
  label: string,
): Uint8Array {
  if (!Object.prototype.hasOwnProperty.call(contentByRef, identity.ref)) {
    throw new D4SmokeManifestError('content_unverified', `${label}: ${identity.ref}`);
  }
  const value = contentByRef[identity.ref]!;
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== identity.sha256) {
    throw new D4SmokeManifestError(
      'content_hash_mismatch',
      `${label}: expected ${identity.sha256}, computed ${actual}`,
    );
  }
  return bytes;
}

export function d4SmokeWakeIdPlaceholder(decisionIndex: number): string {
  if (!Number.isInteger(decisionIndex) || decisionIndex < 0 || decisionIndex >= D4_SMOKE_DECISION_COUNT) {
    throw new RangeError(`D4 Smoke decision index must be 0..${D4_SMOKE_DECISION_COUNT - 1}`);
  }
  return `d4-opaque-wake-placeholder:${String(decisionIndex + 1).padStart(2, '0')}`;
}

export function d4SmokeCandidateDecisionSnapshot(
  candidate: D4SmokeCandidateCell,
  decisionIndex: number,
): Readonly<Record<string, unknown>> {
  const decision = candidate.decisions[decisionIndex];
  if (decision === undefined) {
    throw new RangeError(`D4 Smoke candidate has no decision ${decisionIndex}`);
  }
  return {
    schema: 'steward-d4-decision-snapshot/1',
    instrument: candidate.codename,
    interval: candidate.interval,
    decisionOrdinal: decision.ordinal,
    visibleRange: [decision.visibleStart, decision.visibleEndExclusive],
    bars: candidate.bars.slice(decision.visibleStart, decision.visibleEndExclusive),
  };
}

export function canonicalD4SmokeEmbeddedBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(canonicalizeJson(value))}\n`, 'utf8');
}

export function materializeD4SmokeEvaluationManifest(
  template: StewardEvaluationDataManifest,
  decisionIndex: number,
  wakeId: string,
): StewardEvaluationDataManifest {
  const expected = d4SmokeWakeIdPlaceholder(decisionIndex);
  if (template.wakeId !== expected) {
    throw new D4SmokeManifestError(
      'content_shape_invalid',
      `decision ${decisionIndex + 1}: expected opaque wake placeholder ${expected}`,
    );
  }
  return stewardEvaluationDataManifestSchema.parse({ ...template, wakeId });
}

function parseAndValidateCellData(input: {
  readonly cell: D4SmokeCell;
  readonly candidateBytes: Uint8Array;
  readonly auditBytes: Uint8Array;
  readonly samplingPlanBytes: Uint8Array;
}): ValidatedD4SmokeCellData {
  const candidateRaw = parseJsonBytes(input.candidateBytes, `${input.cell.id}:candidate`);
  const auditRaw = parseJsonBytes(input.auditBytes, `${input.cell.id}:audit`);
  const candidateResult = d4SmokeCandidateCellSchema.safeParse(candidateRaw);
  if (!candidateResult.success) {
    throw new D4SmokeManifestError(
      'content_shape_invalid',
      `${input.cell.id}:candidate: ${formatZodError(candidateResult.error)}`,
    );
  }
  const auditResult = d4SmokeCellAuditSchema.safeParse(auditRaw);
  if (!auditResult.success) {
    throw new D4SmokeManifestError(
      'content_shape_invalid',
      `${input.cell.id}:audit: ${formatZodError(auditResult.error)}`,
    );
  }
  const candidate = candidateResult.data;
  const audit = auditResult.data;
  if (containsHoldout(candidate) || containsHoldout(audit)) {
    throw new D4SmokeManifestError('holdout_forbidden', `${input.cell.id}: frozen evidence contains holdout`);
  }
  if (audit.cellId !== input.cell.id) {
    throw new D4SmokeManifestError('content_shape_invalid', `${input.cell.id}: audit identity differs`);
  }
  validateCandidateCellData(input.cell, candidate);

  const contentByRef: Record<string, Uint8Array> = {};
  bindFrozenContent(
    contentByRef,
    input.cell.evidence.candidatePayload,
    input.candidateBytes,
    `${input.cell.id}:candidate`,
  );
  bindFrozenContent(contentByRef, input.cell.evidence.audit, input.auditBytes, `${input.cell.id}:audit`);
  bindFrozenContent(
    contentByRef,
    input.cell.evidence.samplingPlan,
    input.samplingPlanBytes,
    `${input.cell.id}:sampling-plan`,
  );
  const universeBytes = canonicalD4SmokeEmbeddedBytes(audit.universeEvidence);
  bindFrozenContent(
    contentByRef,
    input.cell.evidence.sourceReceipt,
    canonicalD4SmokeEmbeddedBytes(audit.sourceReceipt),
    `${input.cell.id}:source-receipt`,
  );
  bindFrozenContent(
    contentByRef,
    input.cell.evidence.splitEvidence,
    canonicalD4SmokeEmbeddedBytes(audit.splitEvidence),
    `${input.cell.id}:split-evidence`,
  );
  if (
    !isDeepStrictEqual(input.cell.evidence.selectedRaw, audit.sourceReceipt.selectedRaw)
    || !isDeepStrictEqual(input.cell.evidence.selectedDerived, audit.sourceReceipt.selectedDerived)
  ) {
    throw new D4SmokeManifestError(
      'content_shape_invalid',
      `${input.cell.id}: raw/derived receipt identities differ from frozen audit`,
    );
  }
  for (const manifest of audit.decisionManifests) {
    bindFrozenContent(
      contentByRef,
      manifest.universe.source,
      universeBytes,
      `${input.cell.id}:universe`,
    );
  }
  for (const [actionIndex, action] of audit.splitEvidence.actions.entries()) {
    bindFrozenContent(
      contentByRef,
      action.content,
      canonicalD4SmokeEmbeddedBytes(action.artifact),
      `${input.cell.id}:corporate-action:${actionIndex + 1}`,
    );
  }

  const decisionSnapshots: Readonly<Record<string, unknown>>[] = [];
  let previousAsOf = -Infinity;
  for (const [decisionIndex, manifest] of audit.decisionManifests.entries()) {
    const placeholder = d4SmokeWakeIdPlaceholder(decisionIndex);
    if (manifest.wakeId !== placeholder) {
      throw new D4SmokeManifestError(
        'content_shape_invalid',
        `${input.cell.id}: decision ${decisionIndex + 1} wakeId must be ${placeholder}`,
      );
    }
    const snapshot = d4SmokeCandidateDecisionSnapshot(candidate, decisionIndex);
    const snapshotBytes = canonicalD4SmokeEmbeddedBytes(snapshot);
    bindFrozenContent(
      contentByRef,
      manifest.snapshot,
      snapshotBytes,
      `${input.cell.id}:decision:${decisionIndex + 1}:snapshot`,
    );
    if (!isDeepStrictEqual(manifest.dataset.content, manifest.snapshot)) {
      throw new D4SmokeManifestError(
        'content_shape_invalid',
        `${input.cell.id}: decision ${decisionIndex + 1} dataset must bind its frozen snapshot`,
      );
    }
    if (!isDeepStrictEqual(manifest.sampling.plan, input.cell.evidence.samplingPlan)) {
      throw new D4SmokeManifestError(
        'content_shape_invalid',
        `${input.cell.id}: decision ${decisionIndex + 1} sampling plan identity differs`,
      );
    }
    const expectedDataset = {
      provider: input.cell.instrument.provider,
      name: input.cell.instrument.datasetName,
      rawSymbol: input.cell.instrument.symbol,
      assetClass: input.cell.instrument.assetClass,
      timezone: input.cell.instrument.timezone,
      exchangeCalendar: input.cell.instrument.exchangeCalendar,
    };
    const actualDataset = {
      provider: manifest.dataset.provider,
      name: manifest.dataset.name,
      rawSymbol: manifest.dataset.rawSymbol,
      assetClass: manifest.dataset.assetClass,
      timezone: manifest.dataset.timezone,
      exchangeCalendar: manifest.dataset.exchangeCalendar,
    };
    if (!isDeepStrictEqual(actualDataset, expectedDataset)) {
      throw new D4SmokeManifestError(
        'content_shape_invalid',
        `${input.cell.id}: decision ${decisionIndex + 1} D3 dataset identity differs from stage instrument`,
      );
    }
    if (candidate.interval !== input.cell.temporal.barInterval) {
      throw new D4SmokeManifestError(
        'content_shape_invalid',
        `${input.cell.id}: decision ${decisionIndex + 1} interval differs from stage temporal profile`,
      );
    }
    if (manifest.adjustment.mode !== input.cell.instrument.d3AdjustmentMode) {
      throw new D4SmokeManifestError(
        'content_shape_invalid',
        `${input.cell.id}: decision ${decisionIndex + 1} D3 adjustment mode differs`,
      );
    }
    const asOf = Date.parse(manifest.asOf);
    if (asOf <= previousAsOf) {
      throw new D4SmokeManifestError(
        'content_shape_invalid',
        `${input.cell.id}: decision manifests are not strictly chronological`,
      );
    }
    previousAsOf = asOf;
    for (const identity of stewardEvaluationManifestContentIdentities(manifest)) {
      if (!Object.prototype.hasOwnProperty.call(contentByRef, identity.ref)) {
        throw new D4SmokeManifestError(
          'content_unverified',
          `${input.cell.id}: decision ${decisionIndex + 1}: ${identity.ref}`,
        );
      }
    }
    const validation = validateStewardEvaluationDataManifest(
      manifest,
      contentByRef,
      placeholder,
    );
    if (!validation.valid) {
      throw new D4SmokeManifestError(
        'content_shape_invalid',
        `${input.cell.id}: decision ${decisionIndex + 1}: ${validation.violations
          .map((violation) => `${violation.code}:${violation.detail}`)
          .join('; ')}`,
      );
    }
    decisionSnapshots.push(snapshot);
  }
  const firstManifest = audit.decisionManifests[0]!;
  const lastManifest = audit.decisionManifests.at(-1)!;
  if (
    firstManifest.asOf !== input.cell.asOf.decisionStart
    || lastManifest.asOf !== input.cell.asOf.decisionEnd
    || firstManifest.split.outcomeEnd !== input.cell.asOf.outcomeEnd
    || lastManifest.split.outcomeEnd !== input.cell.asOf.outcomeEnd
  ) {
    throw new D4SmokeManifestError(
      'content_shape_invalid',
      `${input.cell.id}: D3 as-of range differs from the frozen cell`,
    );
  }
  return {
    candidate,
    audit,
    decisionSnapshots,
    decisionManifests: audit.decisionManifests,
    contentByRef,
  };
}

function parseJsonBytes(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    throw new D4SmokeManifestError('content_shape_invalid', `${label}: invalid UTF-8 JSON`, { cause: error });
  }
}

function bindFrozenContent(
  contentByRef: Record<string, Uint8Array>,
  identity: { readonly ref: string; readonly sha256: string },
  content: Uint8Array,
  label: string,
): void {
  const bytes = Buffer.from(content);
  if (sha256StewardEvaluationContent(bytes) !== identity.sha256) {
    throw new D4SmokeManifestError(
      'content_hash_mismatch',
      `${label}: ${identity.ref}`,
    );
  }
  const existing = contentByRef[identity.ref];
  if (existing !== undefined && !Buffer.from(existing).equals(bytes)) {
    throw new D4SmokeManifestError('content_hash_mismatch', `${label}: conflicting bytes for ${identity.ref}`);
  }
  contentByRef[identity.ref] = bytes;
}

function validateRuntimeTreeIdentity(identity: D4SmokeRuntimeTreeIdentity): void {
  const paths = identity.entries.map((entry) => entry.path);
  if (!isDeepStrictEqual(identity.files, D4_SMOKE_RUNTIME_TREE_FILES)
    || !isDeepStrictEqual(paths, D4_SMOKE_RUNTIME_TREE_FILES)) {
    throw new D4SmokeManifestError('runtime_tree_drift', 'runtime-tree file selection is not the frozen closure');
  }
  const expectedOrder = [...paths].sort((left, right) => left.localeCompare(right));
  if (!isDeepStrictEqual(paths, expectedOrder) || new Set(paths).size !== paths.length) {
    throw new D4SmokeManifestError('runtime_tree_drift', 'runtime-tree entries must be unique and sorted');
  }
  for (const path of paths) {
    if (!isD4SmokeRuntimeTreePath(path)) {
      throw new D4SmokeManifestError('runtime_tree_drift', `unexpected runtime-tree path ${path}`);
    }
  }
  const actualSha256 = createHash('sha256').update(canonicalD4SmokeRuntimeTreeBytes({
    schema: identity.schema,
    version: identity.version,
    files: identity.files,
    entries: identity.entries,
  })).digest('hex');
  if (actualSha256 !== identity.sha256) {
    throw new D4SmokeManifestError(
      'runtime_tree_drift',
      `runtime-tree aggregate declares ${identity.sha256}, computed ${actualSha256}`,
    );
  }
}

async function listD4SmokeRuntimeTreePaths(repoRoot: string, revision?: string): Promise<string[]> {
  void repoRoot;
  void revision;
  return [...D4_SMOKE_RUNTIME_TREE_FILES];
}

function isD4SmokeRuntimeTreePath(path: string): boolean {
  return (D4_SMOKE_RUNTIME_TREE_FILES as readonly string[]).includes(path);
}

async function readRuntimeTreeWorktreeFile(repoRoot: string, path: string): Promise<Buffer> {
  const absolutePath = resolve(repoRoot, path);
  const rel = relative(repoRoot, absolutePath);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new D4SmokeManifestError('runtime_tree_drift', `${path} escapes the repository root`);
  }
  const metadata = await lstat(absolutePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new D4SmokeManifestError('runtime_tree_drift', `${path} is not a regular worktree file`);
  }
  return readFile(absolutePath);
}

async function readRuntimeTreeRevisionFile(
  repoRoot: string,
  revision: string,
  path: string,
): Promise<Buffer> {
  const result = await execFileAsync('git', ['show', `${revision}:${path}`], {
    cwd: repoRoot,
    encoding: 'buffer',
    timeout: 10_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return Buffer.from(result.stdout);
}

function containsHoldout(value: unknown): boolean {
  return JSON.stringify(value).toLowerCase().includes('holdout');
}

function formatZodError(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
}
