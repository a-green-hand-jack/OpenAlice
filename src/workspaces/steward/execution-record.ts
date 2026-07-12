import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

import { z } from 'zod';

import { canonicalIntentFingerprint, canonicalizeJson } from './ledger-receipt.js';
import { stewardExecutionRecordPath } from './paths.js';
import {
  stewardSizingOutcomeSchema,
  stewardSizingSourceVersionsSchema,
  type StewardSizingOutcome,
  type StewardSizingSourceVersions,
} from './sizing.js';

export const STEWARD_EXECUTION_RECORD_SCHEMA_VERSION = 1;

const nonEmptyStringSchema = z.string().trim().min(1);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

const executionRecordShape = {
  version: z.literal(STEWARD_EXECUTION_RECORD_SCHEMA_VERSION),
  recordId: nonEmptyStringSchema,
  decisionWakeId: nonEmptyStringSchema,
  accountId: nonEmptyStringSchema,
  snapshotId: z.string().startsWith('snap:'),
  snapshotSha256: sha256Schema,
  intentFingerprint: sha256Schema,
  sourceStateVersions: stewardSizingSourceVersionsSchema,
  sizingOutcome: stewardSizingOutcomeSchema,
  // D2 core is deliberately pre-dispatch. Venue mutation and reconciliation
  // widening belong to the later admission/dispatch lane.
  venueOutcomes: z.tuple([]),
  reconciliation: z.object({
    status: z.literal('not_dispatched'),
    note: z.literal('D2 deterministic core has not dispatched this proposal.'),
  }).strict(),
  uncertainty: z.null(),
  recordFingerprint: sha256Schema,
};

export const stewardExecutionRecordSchema = z.object(executionRecordShape).strict().superRefine((record, ctx) => {
  const expectedRecordId = deterministicStewardExecutionRecordId(record.decisionWakeId, record.intentFingerprint);
  if (record.recordId !== expectedRecordId) {
    ctx.addIssue({ code: 'custom', path: ['recordId'], message: 'recordId does not match wake and raw intent fingerprint' });
  }
  const outcome = record.sizingOutcome;
  const linkageChecks = [
    ['decisionWakeId', record.decisionWakeId, outcome.decisionWakeId],
    ['accountId', record.accountId, outcome.accountId],
    ['snapshotId', record.snapshotId, outcome.snapshotId],
    ['snapshotSha256', record.snapshotSha256, outcome.snapshotSha256],
    ['intentFingerprint', record.intentFingerprint, outcome.intentFingerprint],
  ] as const;
  linkageChecks.forEach(([field, expected, actual]) => {
    if (expected !== actual) {
      ctx.addIssue({ code: 'custom', path: ['sizingOutcome', field], message: `${field} differs from Execution Record` });
    }
  });
  if (!canonicalEqual(record.sourceStateVersions, outcome.sourceStateVersions)) {
    ctx.addIssue({
      code: 'custom',
      path: ['sizingOutcome', 'sourceStateVersions'],
      message: 'sourceStateVersions differ from Execution Record',
    });
  }
  const expectedFingerprint = canonicalExecutionRecordFingerprint(record);
  if (record.recordFingerprint !== expectedFingerprint) {
    ctx.addIssue({ code: 'custom', path: ['recordFingerprint'], message: 'Execution Record fingerprint mismatch' });
  }
});
export type StewardExecutionRecord = z.infer<typeof stewardExecutionRecordSchema>;

export interface BuildStewardExecutionRecordInput {
  readonly decisionWakeId: string;
  readonly accountId: string;
  readonly rawIntent: unknown;
  readonly snapshot: {
    readonly snapshotId: string;
    readonly snapshotSha256: string;
  };
  readonly sizingOutcome: StewardSizingOutcome;
}

export function deterministicStewardExecutionRecordId(decisionWakeId: string, intentFingerprint: string): string {
  return `execution:${decisionWakeId}:${intentFingerprint}`;
}

/** Fingerprint all persisted record fields except the fingerprint itself. */
export function canonicalExecutionRecordFingerprint(record: unknown): string {
  const source = record && typeof record === 'object'
    ? record as Record<string, unknown>
    : {};
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key !== 'recordFingerprint') payload[key] = value;
  }
  return createHash('sha256')
    .update(JSON.stringify(canonicalizeJson(payload)))
    .digest('hex');
}

/** Build a deterministic pre-dispatch audit record. The caller must pass the
 * raw on-disk intent so linkage cannot be normalized through a parsed schema. */
export function buildStewardExecutionRecord(input: BuildStewardExecutionRecordInput): StewardExecutionRecord {
  const sizingOutcome = stewardSizingOutcomeSchema.parse(input.sizingOutcome);
  const intentFingerprint = canonicalIntentFingerprint(input.rawIntent);
  const linkageViolations = validateBuilderLinkage(input, sizingOutcome, intentFingerprint);
  if (linkageViolations.length > 0) {
    throw new Error(`steward_execution_record_linkage:${linkageViolations.join(',')}`);
  }
  const sourceStateVersions = stewardSizingSourceVersionsSchema.parse(sizingOutcome.sourceStateVersions);
  const withoutFingerprint = {
    version: STEWARD_EXECUTION_RECORD_SCHEMA_VERSION,
    recordId: deterministicStewardExecutionRecordId(input.decisionWakeId, intentFingerprint),
    decisionWakeId: input.decisionWakeId,
    accountId: input.accountId,
    snapshotId: input.snapshot.snapshotId,
    snapshotSha256: input.snapshot.snapshotSha256,
    intentFingerprint,
    sourceStateVersions,
    sizingOutcome,
    venueOutcomes: [] as [],
    reconciliation: {
      status: 'not_dispatched' as const,
      note: 'D2 deterministic core has not dispatched this proposal.' as const,
    },
    uncertainty: null,
  };
  return stewardExecutionRecordSchema.parse({
    ...withoutFingerprint,
    recordFingerprint: canonicalExecutionRecordFingerprint(withoutFingerprint),
  });
}

function validateBuilderLinkage(
  input: BuildStewardExecutionRecordInput,
  outcome: StewardSizingOutcome,
  intentFingerprint: string,
): string[] {
  const violations: string[] = [];
  if (outcome.decisionWakeId !== input.decisionWakeId) violations.push('wake_id_mismatch');
  if (outcome.accountId !== input.accountId) violations.push('account_id_mismatch');
  if (outcome.snapshotId !== input.snapshot.snapshotId) violations.push('snapshot_id_mismatch');
  if (outcome.snapshotSha256 !== input.snapshot.snapshotSha256) violations.push('snapshot_hash_mismatch');
  if (outcome.intentFingerprint !== intentFingerprint) violations.push('intent_fingerprint_mismatch');
  return violations;
}

export class StewardExecutionRecordConflictError extends Error {
  constructor(path: string) {
    super(`steward execution record conflicts with existing immutable record: ${path}`);
    this.name = 'StewardExecutionRecordConflictError';
  }
}

export class StewardExecutionRecordCorruptionError extends Error {
  constructor(path: string, detail: string) {
    super(`steward execution record is corrupt: ${path} (${detail})`);
    this.name = 'StewardExecutionRecordCorruptionError';
  }
}

/** Immutable one-file-per-record store. Concurrent identical publications are
 * idempotent; an identity collision with different or corrupt bytes fails
 * closed and never replaces the first published file. */
export class StewardExecutionRecordStore {
  constructor(private readonly workspaceDir: string) {}

  path(recordId: string): string {
    return stewardExecutionRecordPath(this.workspaceDir, recordId);
  }

  async read(recordId: string): Promise<StewardExecutionRecord | null> {
    const path = this.path(recordId);
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (err) {
      if (isCode(err, 'ENOENT')) return null;
      throw err;
    }
    try {
      return stewardExecutionRecordSchema.parse(JSON.parse(raw));
    } catch (err) {
      throw new StewardExecutionRecordCorruptionError(path, err instanceof Error ? err.message : String(err));
    }
  }

  async publish(recordInput: unknown): Promise<StewardExecutionRecord> {
    const record = stewardExecutionRecordSchema.parse(recordInput);
    const path = this.path(record.recordId);
    const content = `${JSON.stringify(record, null, 2)}\n`;
    try {
      await publishFileExclusive(path, content);
      return record;
    } catch (err) {
      if (!isCode(err, 'EEXIST')) throw err;
    }

    const existing = await this.read(record.recordId);
    if (existing === null) {
      throw new StewardExecutionRecordConflictError(`${path} (publication winner disappeared)`);
    }
    if (!canonicalEqual(existing, record)) throw new StewardExecutionRecordConflictError(path);
    return existing;
  }
}

export function createStewardExecutionRecordStore(workspaceDir: string): StewardExecutionRecordStore {
  return new StewardExecutionRecordStore(workspaceDir);
}

async function publishFileExclusive(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tmp, 'wx');
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(tmp, path);
    await syncDirectory(dirname(path));
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, 'r');
    try {
      await handle.sync().catch(() => undefined);
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is not portable; the file itself was already fsync'd.
  }
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalizeJson(left)) === JSON.stringify(canonicalizeJson(right));
}

function isCode(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === code;
}
