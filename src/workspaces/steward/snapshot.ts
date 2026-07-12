import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

import { canonicalDecisionFingerprint, canonicalizeJson } from './ledger-receipt.js';
import { stewardLedgerPath, stewardSnapshotPath, stewardSnapshotRelPath } from './paths.js';
import {
  INFORMATION_SNAPSHOT_SCHEMA_VERSION,
  WAKE_ENVELOPE_SCHEMA_VERSION,
  parseStewardDecisionLedgerEntryLenient,
  stewardInformationSnapshotSchema,
  stewardThesisIdentity,
  stewardWakeEnvelopeInputSchema,
  stewardWakeEnvelopeSchema,
  type StewardDecisionLedgerEntryV3,
  type StewardInformationSnapshot,
  type StewardInformationSnapshotBinding,
  type StewardWakeEnvelope,
  type StewardWakeEnvelopeInput,
} from './types.js';

export class StewardSnapshotConflictError extends Error {
  constructor(path: string) {
    super(`steward snapshot already exists: ${path}`);
    this.name = 'StewardSnapshotConflictError';
  }
}

export interface PublishStewardSnapshotInput {
  readonly wakeId: string;
  readonly asOf: string;
  readonly envelope: StewardWakeEnvelopeInput;
}

export interface PublishStewardSnapshotResult {
  readonly snapshot: StewardInformationSnapshot;
  readonly binding: StewardInformationSnapshotBinding;
  readonly envelope: StewardWakeEnvelope;
}

type StewardOpenThesis = Extract<
  StewardInformationSnapshot['history'],
  { provided: true }
>['openTheses'][number];
type StewardTimeHorizon = NonNullable<StewardDecisionLedgerEntryV3['intent']>['timeHorizon'];

export function canonicalInformationSnapshotHash(snapshot: unknown): string {
  return sha256Canonical(snapshot);
}

export function validateStewardSnapshotTemporalIntegrity(
  snapshot: StewardInformationSnapshot,
): string[] {
  const errors: string[] = [];
  const categories = [
    ['market', snapshot.market],
    ['portfolio', snapshot.portfolio],
    ['risk', snapshot.risk],
    ['events', snapshot.events],
    ['history', snapshot.history],
  ] as const;
  for (const [categoryName, category] of categories) {
    if (!category.provided) continue;
    for (const ref of category.refs) {
      if (Date.parse(ref.asOf) > Date.parse(snapshot.asOf)) {
        errors.push(`future_ref:${categoryName}:${ref.ref}`);
      }
    }
  }
  return errors;
}

export function validateStewardDecisionSnapshotBinding(
  entry: StewardDecisionLedgerEntryV3,
  snapshot: StewardInformationSnapshot,
): string[] {
  const errors: string[] = [];
  if (entry.wakeId !== snapshot.wakeId) errors.push('wake_id_mismatch');
  if (entry.accountId !== snapshot.accountId) errors.push('account_id_mismatch');
  if (entry.intent && entry.intent.snapshotId !== snapshot.snapshotId) errors.push('snapshot_id_mismatch');
  if (entry.intent && entry.intent.snapshotSha256 !== canonicalInformationSnapshotHash(snapshot)) {
    errors.push('snapshot_hash_mismatch');
  }
  return errors;
}

export function validateStewardThesisDispositionCoverage(
  entry: StewardDecisionLedgerEntryV3,
  snapshot: StewardInformationSnapshot,
): string[] {
  const errors: string[] = [];
  const dispositionCounts = new Map<string, number>();
  for (const disposition of entry.thesisDispositions) {
    const identity = stewardThesisIdentity(disposition);
    const count = (dispositionCounts.get(identity) ?? 0) + 1;
    dispositionCounts.set(identity, count);
    if (count === 2) {
      errors.push(`duplicate_thesis_disposition:${disposition.wakeId}:${disposition.instrument}`);
    }
  }
  if (!snapshot.history.provided) return errors;

  const openByIdentity = new Map(
    snapshot.history.openTheses.map((thesis) => [stewardThesisIdentity(thesis), thesis]),
  );
  const touched = intentInstruments(entry.intent);
  for (const disposition of entry.thesisDispositions) {
    const thesis = openByIdentity.get(stewardThesisIdentity(disposition));
    if (!thesis) {
      errors.push(`unknown_thesis:${disposition.wakeId}:${disposition.instrument}`);
      continue;
    }
    if (disposition.disposition === 'supersede' && !touched.has(thesis.instrument)) {
      errors.push(`supersede_without_replacement:${disposition.wakeId}:${disposition.instrument}`);
    }
    if (disposition.disposition === 'keep' && touched.has(thesis.instrument)) {
      errors.push(`keep_with_replacement:${disposition.wakeId}:${disposition.instrument}`);
    }
    if (Date.parse(thesis.expiresAt) <= Date.parse(entry.at) && disposition.disposition === 'keep') {
      errors.push(`expired_thesis_cannot_keep:${disposition.wakeId}:${disposition.instrument}`);
    }
  }
  for (const thesis of snapshot.history.openTheses) {
    const required = Date.parse(thesis.expiresAt) <= Date.parse(entry.at) || touched.has(thesis.instrument);
    if (!required) continue;
    const count = dispositionCounts.get(stewardThesisIdentity(thesis)) ?? 0;
    if (count !== 1) {
      errors.push(`required_disposition_count:${thesis.wakeId}:${thesis.instrument}:${count}`);
    }
  }
  return errors;
}

/** Build, validate, and atomically publish the launcher-owned M1 snapshot. The
 * target is installed with a hard-link create, so an existing wake snapshot is
 * never overwritten even if two dispatchers race on the same wake id. */
export async function publishStewardInformationSnapshot(
  workspaceDir: string,
  input: PublishStewardSnapshotInput,
): Promise<PublishStewardSnapshotResult> {
  const envelopeInput = stewardWakeEnvelopeInputSchema.parse(input.envelope);
  const snapshot = await buildInformationSnapshot(workspaceDir, input.wakeId, input.asOf, envelopeInput);
  const sha256 = canonicalInformationSnapshotHash(snapshot);
  const path = stewardSnapshotPath(workspaceDir, input.wakeId);
  const content = `${JSON.stringify(snapshot, null, 2)}\n`;
  try {
    await publishFileExclusive(path, content);
  } catch (err) {
    if (!(err instanceof StewardSnapshotConflictError)) throw err;
    return adoptIdenticalPublishedSnapshot(workspaceDir, input, envelopeInput, path);
  }
  const readBack = stewardInformationSnapshotSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  if (canonicalInformationSnapshotHash(readBack) !== sha256) {
    throw new Error(`steward snapshot hash changed during publication: ${path}`);
  }
  return bindPublishedSnapshot(snapshot, envelopeInput, input.wakeId);
}

async function buildInformationSnapshot(
  workspaceDir: string,
  wakeId: string,
  asOf: string,
  envelopeInput: StewardWakeEnvelopeInput,
): Promise<StewardInformationSnapshot> {
  const snapshot = stewardInformationSnapshotSchema.parse({
    version: INFORMATION_SNAPSHOT_SCHEMA_VERSION,
    snapshotId: `snap:${wakeId}`,
    wakeId,
    accountId: envelopeInput.accountId,
    asOf,
    market: snapshotMarket(envelopeInput, asOf),
    portfolio: {
      provided: false,
      note: 'No authorized deterministic portfolio source was supplied to this dispatcher.',
    },
    risk: snapshotRisk(envelopeInput, asOf),
    events: {
      provided: false,
      note: 'No deterministic event reference was supplied to this dispatcher.',
    },
    history: await snapshotHistory(workspaceDir, envelopeInput.accountId, asOf),
  });
  const temporalErrors = validateStewardSnapshotTemporalIntegrity(snapshot);
  if (temporalErrors.length > 0) {
    throw new Error(`steward snapshot temporal validation failed: ${temporalErrors.join(', ')}`);
  }

  return snapshot;
}

function bindPublishedSnapshot(
  snapshot: StewardInformationSnapshot,
  envelopeInput: StewardWakeEnvelopeInput,
  wakeId: string,
): PublishStewardSnapshotResult {
  const sha256 = canonicalInformationSnapshotHash(snapshot);
  const binding: StewardInformationSnapshotBinding = {
    snapshotId: snapshot.snapshotId,
    sha256,
    path: stewardSnapshotRelPath(wakeId),
    asOf: snapshot.asOf,
  };
  const envelope = stewardWakeEnvelopeSchema.parse({
    ...envelopeInput,
    version: WAKE_ENVELOPE_SCHEMA_VERSION,
    snapshotRef: binding,
  });
  return { snapshot, binding, envelope };
}

async function adoptIdenticalPublishedSnapshot(
  workspaceDir: string,
  input: PublishStewardSnapshotInput,
  envelopeInput: StewardWakeEnvelopeInput,
  path: string,
): Promise<PublishStewardSnapshotResult> {
  let existing: StewardInformationSnapshot;
  try {
    existing = stewardInformationSnapshotSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  } catch (err) {
    throw new StewardSnapshotConflictError(
      `${path} (existing snapshot is unreadable: ${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (
    existing.snapshotId !== `snap:${input.wakeId}`
    || existing.wakeId !== input.wakeId
    || existing.accountId !== envelopeInput.accountId
  ) {
    throw new StewardSnapshotConflictError(`${path} (existing snapshot identity differs)`);
  }
  const expected = await buildInformationSnapshot(
    workspaceDir,
    input.wakeId,
    existing.asOf,
    envelopeInput,
  );
  if (canonicalInformationSnapshotHash(expected) !== canonicalInformationSnapshotHash(existing)) {
    throw new StewardSnapshotConflictError(`${path} (existing snapshot content differs)`);
  }
  return bindPublishedSnapshot(existing, envelopeInput, input.wakeId);
}

function snapshotMarket(envelope: StewardWakeEnvelopeInput, asOf: string): StewardInformationSnapshot['market'] {
  if (envelope.marketContext === undefined) {
    return { provided: false, note: 'No deterministic market context was supplied to this dispatcher.' };
  }
  return {
    provided: true,
    refs: [{
      ref: 'wake-envelope:marketContext',
      sha256: sha256Canonical(envelope.marketContext),
      asOf,
      freshness: 'dispatch_input',
    }],
  };
}

function snapshotRisk(envelope: StewardWakeEnvelopeInput, asOf: string): StewardInformationSnapshot['risk'] {
  const envelopeVersion = envelope.riskContext?.['envelopeVersion'];
  if (!Number.isInteger(envelopeVersion) || (envelopeVersion as number) <= 0) {
    return {
      provided: false,
      envelopeVersion: null,
      note: 'No versioned deterministic risk context was supplied to this dispatcher.',
    };
  }
  return {
    provided: true,
    envelopeVersion: envelopeVersion as number,
    refs: [{ ref: 'wake-envelope:riskContext', sha256: sha256Canonical(envelope.riskContext), asOf }],
  };
}

async function snapshotHistory(
  workspaceDir: string,
  accountId: string,
  asOf: string,
): Promise<StewardInformationSnapshot['history']> {
  const snapshotAt = Date.parse(asOf);
  if (!Number.isFinite(snapshotAt)) throw new Error(`invalid steward snapshot asOf: ${asOf}`);
  let raw: string;
  try {
    raw = await readFile(stewardLedgerPath(workspaceDir), 'utf8');
  } catch (err) {
    if (isCode(err, 'ENOENT')) {
      return { provided: false, note: 'No decision ledger exists in this workspace.' };
    }
    throw err;
  }

  const openByInstrument = new Map<string, StewardOpenThesis>();
  const seenWakeIds = new Set<string>();
  const lines = raw.split('\n');
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex]!;
    if (!line.trim()) continue;
    let rawEntry: unknown;
    try {
      rawEntry = JSON.parse(line);
    } catch (err) {
      throw new Error(`steward snapshot history is incomplete: invalid JSON at ledger line ${lineIndex + 1}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const rawWakeId = rawEntry && typeof rawEntry === 'object'
      ? (rawEntry as { wakeId?: unknown }).wakeId
      : undefined;
    if (typeof rawWakeId !== 'string') {
      throw new Error(`steward snapshot history is incomplete: ledger line ${lineIndex + 1} has no wake identity`);
    }
    if (seenWakeIds.has(rawWakeId)) {
      // Ledger reconciliation is first-wins. A later JSON-object duplicate is
      // diagnostic corruption, but it cannot replace or invalidate the first
      // attributable winner for history derivation.
      continue;
    }
    seenWakeIds.add(rawWakeId);

    let parsed;
    try {
      parsed = parseStewardDecisionLedgerEntryLenient(rawEntry);
    } catch (err) {
      throw new Error(`steward snapshot history is incomplete: invalid ledger schema at line ${lineIndex + 1}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const entryAt = Date.parse(parsed.at);
    if (!Number.isFinite(entryAt)) {
      throw new Error(`steward snapshot history is incomplete: ledger line ${lineIndex + 1} has an invalid at timestamp`);
    }
    if (entryAt > snapshotAt) {
      throw new Error(`steward snapshot history contains future ledger entry ${parsed.wakeId}`);
    }
    if (parsed.version !== 3 || parsed.accountId !== accountId) continue;
    for (const disposition of parsed.thesisDispositions) {
      const current = openByInstrument.get(disposition.instrument);
      if (current?.wakeId !== disposition.wakeId) {
        throw new Error(`steward snapshot history is inconsistent: unknown thesis disposition ${disposition.wakeId}:${disposition.instrument}`);
      }
      if (disposition.disposition !== 'keep') openByInstrument.delete(disposition.instrument);
    }
    if (parsed.decision !== 'propose_change' || parsed.intent === null) continue;
    const targets = parsed.intent.kind === 'single' ? [parsed.intent] : parsed.intent.targets;
    const fingerprint = canonicalDecisionFingerprint(rawEntry);
    const expiresAt = addTimeHorizon(parsed.at, parsed.intent.timeHorizon);
    for (const target of targets) {
      if (openByInstrument.has(target.instrument)) {
        throw new Error(`steward snapshot history is inconsistent: multiple open theses for ${target.instrument}`);
      }
      openByInstrument.set(target.instrument, {
        wakeId: parsed.wakeId,
        fingerprint,
        instrument: target.instrument,
        expiresAt,
      });
    }
  }

  return {
    provided: true,
    openTheses: [...openByInstrument.values()].sort((a, b) =>
      a.instrument.localeCompare(b.instrument) || a.wakeId.localeCompare(b.wakeId)),
    refs: [{ ref: 'ledger:decisions.jsonl', sha256: sha256Bytes(raw), asOf }],
  };
}

function addTimeHorizon(
  at: string,
  horizon: StewardTimeHorizon,
): string {
  const date = new Date(at);
  if (horizon.unit === 'month') {
    date.setUTCMonth(date.getUTCMonth() + horizon.value);
  } else {
    const unitMs = horizon.unit === 'hour' ? 3_600_000 : horizon.unit === 'day' ? 86_400_000 : 604_800_000;
    date.setTime(date.getTime() + unitMs * horizon.value);
  }
  return date.toISOString();
}

function intentInstruments(intent: StewardDecisionLedgerEntryV3['intent']): Set<string> {
  if (intent === null) return new Set();
  return intent.kind === 'single'
    ? new Set([intent.instrument])
    : new Set(intent.targets.map((target) => target.instrument));
}

function sha256Canonical(value: unknown): string {
  return sha256Bytes(JSON.stringify(canonicalizeJson(value)));
}

function sha256Bytes(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
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
  } catch (err) {
    if (isCode(err, 'EEXIST')) throw new StewardSnapshotConflictError(path);
    throw err;
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
    // Directory fsync is unavailable on some platforms.
  }
}

function isCode(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === code;
}
