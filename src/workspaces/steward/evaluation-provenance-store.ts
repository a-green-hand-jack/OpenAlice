import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { TextDecoder } from 'node:util';

import { z } from 'zod';

import {
  sha256StewardEvaluationContent,
  stewardEvaluationContentIdentitySchema,
  stewardEvaluationDataManifestSchema,
  stewardEvaluationManifestContentIdentities,
  validateStewardEvaluationManifestSet,
  type StewardEvaluationContent,
  type StewardEvaluationContentIdentity,
  type StewardEvaluationDataManifest,
  type StewardEvaluationManifestSetValidation,
} from './evaluation-data-manifest.js';
import { stewardEvaluationProvenanceDir } from './paths.js';

const CONTENT_REF_SCHEMA = 'steward-eval-content-ref/1' as const;
const CONTENT_REF_VERSION = 1 as const;
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const contentRefRecordSchema = z.object({
  schema: z.literal(CONTENT_REF_SCHEMA),
  version: z.literal(CONTENT_REF_VERSION),
  ref: z.string().trim().min(1),
  sha256: sha256Schema,
  byteLength: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();

type ContentRefRecord = z.infer<typeof contentRefRecordSchema>;

export type StewardEvaluationProvenanceErrorCode =
  | 'content_ref_conflict'
  | 'content_ref_missing'
  | 'content_record_corrupt'
  | 'content_blob_missing'
  | 'content_hash_mismatch'
  | 'manifest_conflict'
  | 'manifest_missing'
  | 'manifest_corrupt'
  | 'manifest_wake_mismatch'
  | 'manifest_binding_mismatch';

export class StewardEvaluationProvenanceError extends Error {
  constructor(
    readonly code: StewardEvaluationProvenanceErrorCode,
    detail: string,
  ) {
    super(`steward evaluation provenance ${code}: ${detail}`);
    this.name = 'StewardEvaluationProvenanceError';
  }
}

export interface ResolvedStewardEvaluationManifest {
  readonly manifest: StewardEvaluationDataManifest;
  readonly bytes: Uint8Array;
  readonly contentByRef: Readonly<Record<string, Uint8Array>>;
}

/** Launcher-owned immutable provenance store. Logical refs are bound once to
 * exact bytes; blobs are physically addressed by sha256, while per-wake
 * manifest files preserve the exact published JSON bytes. */
export class StewardEvaluationProvenanceStore {
  constructor(private readonly workspaceDir: string) {}

  rootPath(): string {
    return stewardEvaluationProvenanceDir(this.workspaceDir);
  }

  objectPath(sha256: string): string {
    return join(this.rootPath(), 'objects', sha256Schema.parse(sha256));
  }

  refPath(ref: string): string {
    const key = createHash('sha256').update(ref).digest('hex');
    return join(this.rootPath(), 'refs', `${key}.json`);
  }

  manifestPath(wakeId: string): string {
    const parsedWakeId = z.string().trim().min(1).parse(wakeId);
    return join(this.rootPath(), 'manifests', `${encodeURIComponent(parsedWakeId)}.json`);
  }

  async publishContent(
    ref: string,
    content: StewardEvaluationContent,
  ): Promise<StewardEvaluationContentIdentity> {
    const bytes = toBytes(content);
    const identity = stewardEvaluationContentIdentitySchema.parse({
      ref,
      sha256: sha256StewardEvaluationContent(bytes),
    });
    const existing = await this.readRefRecord(identity.ref, true);
    if (existing !== null) {
      return this.adoptExistingContent(identity, bytes, existing);
    }

    await this.publishObject(identity.sha256, bytes);
    const record = contentRefRecordSchema.parse({
      schema: CONTENT_REF_SCHEMA,
      version: CONTENT_REF_VERSION,
      ref: identity.ref,
      sha256: identity.sha256,
      byteLength: bytes.byteLength,
    });
    const recordBytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
    const published = await publishFileExclusive(this.refPath(identity.ref), recordBytes);
    if (!published) {
      const winner = await this.readRefRecord(identity.ref, false);
      return this.adoptExistingContent(identity, bytes, winner);
    }

    const readBack = await this.readContent(identity);
    if (!Buffer.from(readBack).equals(bytes)) {
      throw new StewardEvaluationProvenanceError(
        'content_hash_mismatch',
        `${identity.ref} changed during publication`,
      );
    }
    return identity;
  }

  async readContent(identityInput: unknown): Promise<Uint8Array> {
    const identity = stewardEvaluationContentIdentitySchema.parse(identityInput);
    const record = await this.readRefRecord(identity.ref, false);
    if (record.sha256 !== identity.sha256) {
      throw new StewardEvaluationProvenanceError(
        'content_ref_conflict',
        `${identity.ref} is bound to ${record.sha256}, not ${identity.sha256}`,
      );
    }

    let bytes: Buffer;
    try {
      bytes = await readFile(this.objectPath(record.sha256));
    } catch (error) {
      if (isCode(error, 'ENOENT')) {
        throw new StewardEvaluationProvenanceError(
          'content_blob_missing',
          `${identity.ref} -> ${record.sha256}`,
        );
      }
      throw error;
    }
    if (
      bytes.byteLength !== record.byteLength
      || sha256StewardEvaluationContent(bytes) !== record.sha256
    ) {
      throw new StewardEvaluationProvenanceError(
        'content_hash_mismatch',
        `${identity.ref} -> ${record.sha256}`,
      );
    }
    return new Uint8Array(bytes);
  }

  async publishManifest(
    wakeId: string,
    content: StewardEvaluationContent,
  ): Promise<ResolvedStewardEvaluationManifest> {
    const bytes = toBytes(content);
    const manifest = parseManifestBytes(bytes, this.manifestPath(wakeId));
    assertWakeBinding(wakeId, manifest);
    await this.resolveManifest(manifest, wakeId);

    const path = this.manifestPath(wakeId);
    const published = await publishFileExclusive(path, bytes);
    if (!published) {
      let existing: Buffer;
      try {
        existing = await readFile(path);
      } catch (error) {
        if (isCode(error, 'ENOENT')) {
          throw new StewardEvaluationProvenanceError(
            'manifest_conflict',
            `${path} publication winner disappeared`,
          );
        }
        throw error;
      }
      if (!existing.equals(bytes)) {
        throw new StewardEvaluationProvenanceError(
          'manifest_conflict',
          `${path} already contains different bytes`,
        );
      }
    }
    return this.loadManifest(wakeId);
  }

  async loadManifest(wakeId: string): Promise<ResolvedStewardEvaluationManifest> {
    const path = this.manifestPath(wakeId);
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch (error) {
      if (isCode(error, 'ENOENT')) {
        throw new StewardEvaluationProvenanceError('manifest_missing', path);
      }
      throw error;
    }
    const manifest = parseManifestBytes(bytes, path);
    assertWakeBinding(wakeId, manifest);
    const contentByRef = await this.resolveManifest(manifest, wakeId);
    return { manifest, bytes: new Uint8Array(bytes), contentByRef };
  }

  async validateManifestSet(
    wakeIds: readonly string[],
  ): Promise<StewardEvaluationManifestSetValidation> {
    const manifests: StewardEvaluationDataManifest[] = [];
    const contentByRef = Object.create(null) as Record<string, Uint8Array>;
    for (const wakeId of wakeIds) {
      const resolved = await this.loadManifest(wakeId);
      manifests.push(resolved.manifest);
      for (const [ref, bytes] of Object.entries(resolved.contentByRef)) {
        contentByRef[ref] = bytes;
      }
    }
    return validateStewardEvaluationManifestSet(manifests, contentByRef);
  }

  private async resolveManifest(
    manifestInput: unknown,
    expectedWakeId: string,
  ): Promise<Readonly<Record<string, Uint8Array>>> {
    const manifest = stewardEvaluationDataManifestSchema.parse(manifestInput);
    assertWakeBinding(expectedWakeId, manifest);
    const contentByRef = Object.create(null) as Record<string, Uint8Array>;
    const identityByRef = new Map<string, string>();
    for (const identity of stewardEvaluationManifestContentIdentities(manifest)) {
      const existing = identityByRef.get(identity.ref);
      if (existing !== undefined && existing !== identity.sha256) {
        throw new StewardEvaluationProvenanceError(
          'content_ref_conflict',
          `${identity.ref} has multiple hashes in wake ${manifest.wakeId}`,
        );
      }
      identityByRef.set(identity.ref, identity.sha256);
      if (!Object.prototype.hasOwnProperty.call(contentByRef, identity.ref)) {
        contentByRef[identity.ref] = await this.readContent(identity);
      }
    }
    return Object.freeze(contentByRef);
  }

  private async publishObject(sha256: string, bytes: Buffer): Promise<void> {
    const path = this.objectPath(sha256);
    if (await publishFileExclusive(path, bytes)) return;
    let existing: Buffer;
    try {
      existing = await readFile(path);
    } catch (error) {
      if (isCode(error, 'ENOENT')) {
        throw new StewardEvaluationProvenanceError(
          'content_blob_missing',
          `${path} publication winner disappeared`,
        );
      }
      throw error;
    }
    if (!existing.equals(bytes)) {
      throw new StewardEvaluationProvenanceError(
        'content_hash_mismatch',
        `${path} contains different bytes for ${sha256}`,
      );
    }
  }

  private async adoptExistingContent(
    identity: StewardEvaluationContentIdentity,
    bytes: Buffer,
    existing: ContentRefRecord,
  ): Promise<StewardEvaluationContentIdentity> {
    if (existing.ref !== identity.ref || existing.sha256 !== identity.sha256) {
      throw new StewardEvaluationProvenanceError(
        'content_ref_conflict',
        `${identity.ref} is already bound to ${existing.sha256}`,
      );
    }
    const readBack = await this.readContent(identity);
    if (!Buffer.from(readBack).equals(bytes)) {
      throw new StewardEvaluationProvenanceError(
        'content_ref_conflict',
        `${identity.ref} exact retry bytes differ`,
      );
    }
    return identity;
  }

  private async readRefRecord(ref: string, allowMissing: true): Promise<ContentRefRecord | null>;
  private async readRefRecord(ref: string, allowMissing: false): Promise<ContentRefRecord>;
  private async readRefRecord(ref: string, allowMissing: boolean): Promise<ContentRefRecord | null> {
    const path = this.refPath(ref);
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch (error) {
      if (isCode(error, 'ENOENT')) {
        if (allowMissing) return null;
        throw new StewardEvaluationProvenanceError('content_ref_missing', `${ref} (${path})`);
      }
      throw error;
    }
    try {
      const record = contentRefRecordSchema.parse(JSON.parse(decodeUtf8(bytes)));
      if (record.ref !== ref) {
        throw new Error(`ref index collision: expected ${ref}, received ${record.ref}`);
      }
      return record;
    } catch (error) {
      throw new StewardEvaluationProvenanceError(
        'content_record_corrupt',
        `${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export function createStewardEvaluationProvenanceStore(
  workspaceDir: string,
): StewardEvaluationProvenanceStore {
  return new StewardEvaluationProvenanceStore(workspaceDir);
}

export function assertStoredManifestMatchesCandidate(
  stored: StewardEvaluationDataManifest,
  candidateInput: unknown,
): void {
  const candidate = stewardEvaluationDataManifestSchema.parse(candidateInput);
  if (JSON.stringify(stored) !== JSON.stringify(candidate)) {
    throw new StewardEvaluationProvenanceError(
      'manifest_binding_mismatch',
      `wake ${stored.wakeId} evaluation input differs from the persisted manifest`,
    );
  }
}

function parseManifestBytes(bytes: Uint8Array, path: string): StewardEvaluationDataManifest {
  try {
    return stewardEvaluationDataManifestSchema.parse(JSON.parse(decodeUtf8(bytes)));
  } catch (error) {
    throw new StewardEvaluationProvenanceError(
      'manifest_corrupt',
      `${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function assertWakeBinding(wakeId: string, manifest: StewardEvaluationDataManifest): void {
  if (manifest.wakeId !== wakeId) {
    throw new StewardEvaluationProvenanceError(
      'manifest_wake_mismatch',
      `path wake ${wakeId}, manifest wake ${manifest.wakeId}`,
    );
  }
}

function toBytes(content: StewardEvaluationContent): Buffer {
  return typeof content === 'string'
    ? Buffer.from(content, 'utf8')
    : Buffer.from(content);
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

async function publishFileExclusive(path: string, bytes: Uint8Array): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tmp, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(tmp, path);
    } catch (error) {
      if (isCode(error, 'EEXIST')) return false;
      throw error;
    }
    await syncDirectory(dirname(path));
    return true;
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
    // Directory fsync is not portable; each file is already fsync'd.
  }
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === 'object'
    && error !== null
    && (error as NodeJS.ErrnoException).code === code;
}
