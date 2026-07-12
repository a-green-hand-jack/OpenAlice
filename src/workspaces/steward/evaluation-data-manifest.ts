import { createHash } from 'node:crypto';

import { z } from 'zod';

export const STEWARD_EVALUATION_DATA_MANIFEST_VERSION = 1;
export const STEWARD_EVALUATION_DATA_MANIFEST_SCHEMA = 'steward-eval-data-manifest/1' as const;

const nonEmptyStringSchema = z.string().trim().min(1);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const isoTimestampSchema = z.string().datetime({ offset: true });
const safeCountSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const stewardEvaluationContentIdentitySchema = z.object({
  ref: nonEmptyStringSchema,
  sha256: sha256Schema,
}).strict();

const sourceItemSchema = stewardEvaluationContentIdentitySchema.extend({
  observedAt: isoTimestampSchema,
  availableAt: isoTimestampSchema,
}).strict();

const sourceSliceSchema = z.object({
  required: z.boolean(),
  provided: z.boolean(),
  items: z.array(sourceItemSchema),
  note: nonEmptyStringSchema.nullable(),
}).strict();

const publicationSchema = stewardEvaluationContentIdentitySchema.extend({
  kind: z.enum(['report', 'scheduled_event']),
  eventAt: isoTimestampSchema,
  publishedAt: isoTimestampSchema,
}).strict();

const corporateActionSchema = stewardEvaluationContentIdentitySchema.extend({
  kind: z.enum(['split', 'dividend', 'merger', 'spinoff']),
  announcedAt: isoTimestampSchema,
  effectiveAt: isoTimestampSchema,
  appliedToData: z.boolean(),
}).strict();

export const stewardEvaluationDataManifestSchema = z.object({
  schema: z.literal(STEWARD_EVALUATION_DATA_MANIFEST_SCHEMA),
  version: z.literal(STEWARD_EVALUATION_DATA_MANIFEST_VERSION),
  wakeId: nonEmptyStringSchema,
  datasetId: nonEmptyStringSchema,
  asOf: isoTimestampSchema,
  snapshot: stewardEvaluationContentIdentitySchema,
  dataset: z.object({
    provider: nonEmptyStringSchema,
    name: nonEmptyStringSchema,
    rawSymbol: nonEmptyStringSchema,
    assetClass: nonEmptyStringSchema,
    timezone: nonEmptyStringSchema,
    exchangeCalendar: nonEmptyStringSchema,
    content: stewardEvaluationContentIdentitySchema,
  }).strict(),
  adjustment: z.object({
    mode: z.enum(['adjusted', 'unadjusted']),
    corporateActionRefs: z.array(nonEmptyStringSchema),
  }).strict(),
  sources: z.object({
    market: sourceSliceSchema,
    portfolio: sourceSliceSchema,
    risk: sourceSliceSchema,
    events: sourceSliceSchema,
    history: sourceSliceSchema,
  }).strict(),
  publications: z.array(publicationSchema),
  corporateActions: z.array(corporateActionSchema),
  universe: z.object({
    selectionBasis: z.enum(['point_in_time', 'current_members']),
    membershipAsOf: isoTimestampSchema,
    effectiveFrom: isoTimestampSchema,
    effectiveTo: isoTimestampSchema.nullable(),
    source: stewardEvaluationContentIdentitySchema,
  }).strict(),
  sampling: z.object({
    kind: z.enum(['continuous_walk_forward', 'regime_labeled']),
    frozenAt: isoTimestampSchema,
    plan: stewardEvaluationContentIdentitySchema,
  }).strict(),
  audit: z.object({
    manifestCreatedAt: isoTimestampSchema,
    evaluationStartedAt: isoTimestampSchema,
  }).strict(),
  split: z.object({
    name: z.enum(['dev', 'validation', 'holdout']),
    identity: nonEmptyStringSchema,
    leakageGroups: z.array(nonEmptyStringSchema).min(1),
    inputStart: isoTimestampSchema,
    decisionStart: isoTimestampSchema,
    decisionEnd: isoTimestampSchema,
    outcomeEnd: isoTimestampSchema,
    embargoMs: safeCountSchema,
  }).strict(),
}).strict();

export type StewardEvaluationDataManifest = z.infer<typeof stewardEvaluationDataManifestSchema>;
export type StewardEvaluationContent = string | Uint8Array;
export type StewardEvaluationContentIdentity = z.infer<typeof stewardEvaluationContentIdentitySchema>;

export type StewardEvaluationManifestViolationCode =
  | 'manifest_shape_invalid'
  | 'wake_id_mismatch'
  | 'split_time_order_invalid'
  | 'wake_as_of_outside_split'
  | 'future_wake_as_of'
  | 'sampling_audit_order_invalid'
  | 'content_missing'
  | 'content_hash_mismatch'
  | 'source_availability_inconsistent'
  | 'source_unavailable_reason_missing'
  | 'required_source_unavailable'
  | 'source_chronology_invalid'
  | 'future_source_observation'
  | 'future_source_availability'
  | 'publication_chronology_invalid'
  | 'future_publication'
  | 'corporate_action_chronology_invalid'
  | 'corporate_action_future_leak'
  | 'corporate_action_reference_missing'
  | 'corporate_action_reference_inconsistent'
  | 'corporate_action_adjustment_inconsistent'
  | 'survivorship_bias'
  | 'future_universe_membership'
  | 'outside_universe_membership'
  | 'split_identity_conflict'
  | 'duplicate_content_across_splits'
  | 'split_embargo_overlap';

export interface StewardEvaluationManifestViolation {
  readonly datasetId: string;
  readonly wakeId: string;
  readonly code: StewardEvaluationManifestViolationCode;
  readonly detail: string;
}

export interface StewardEvaluationManifestValidation {
  readonly valid: boolean;
  readonly manifest: StewardEvaluationDataManifest | null;
  readonly violations: readonly StewardEvaluationManifestViolation[];
}

export interface StewardEvaluationManifestSetValidation {
  readonly valid: boolean;
  readonly violations: readonly StewardEvaluationManifestViolation[];
  readonly overlaps: readonly {
    readonly leftDatasetId: string;
    readonly rightDatasetId: string;
    readonly identities: readonly string[];
  }[];
}

const SOURCE_CATEGORIES = ['market', 'portfolio', 'risk', 'events', 'history'] as const;

export function validateStewardEvaluationDataManifest(
  input: unknown,
  contentByRef: Readonly<Record<string, StewardEvaluationContent>>,
  expectedWakeId?: string,
): StewardEvaluationManifestValidation {
  const parsed = stewardEvaluationDataManifestSchema.safeParse(input);
  if (!parsed.success) {
    const identity = rawManifestIdentity(input);
    return {
      valid: false,
      manifest: null,
      violations: parsed.error.issues.map((issue) => ({
        ...identity,
        code: 'manifest_shape_invalid' as const,
        detail: `${issue.path.join('.') || '(root)'}: ${issue.message}`,
      })),
    };
  }

  const manifest = parsed.data;
  const violations: StewardEvaluationManifestViolation[] = [];
  const add = (code: StewardEvaluationManifestViolationCode, detail: string) => {
    violations.push({
      datasetId: manifest.datasetId,
      wakeId: manifest.wakeId,
      code,
      detail,
    });
  };

  if (expectedWakeId !== undefined && manifest.wakeId !== expectedWakeId) {
    add('wake_id_mismatch', `expected ${expectedWakeId}, received ${manifest.wakeId}`);
  }

  const asOf = Date.parse(manifest.asOf);
  const inputStart = Date.parse(manifest.split.inputStart);
  const decisionStart = Date.parse(manifest.split.decisionStart);
  const decisionEnd = Date.parse(manifest.split.decisionEnd);
  const outcomeEnd = Date.parse(manifest.split.outcomeEnd);
  if (!(inputStart <= decisionStart && decisionStart <= decisionEnd && decisionEnd <= outcomeEnd)) {
    add('split_time_order_invalid', 'expected inputStart <= decisionStart <= decisionEnd <= outcomeEnd');
  }
  if (asOf < decisionStart || asOf > decisionEnd) {
    add('wake_as_of_outside_split', `${manifest.asOf} is outside decisionStart..decisionEnd`);
  }

  const frozenAt = Date.parse(manifest.sampling.frozenAt);
  const manifestCreatedAt = Date.parse(manifest.audit.manifestCreatedAt);
  const evaluationStartedAt = Date.parse(manifest.audit.evaluationStartedAt);
  if (asOf > evaluationStartedAt) {
    add('future_wake_as_of', `${manifest.asOf} is after evaluation start ${manifest.audit.evaluationStartedAt}`);
  }
  if (!(frozenAt <= manifestCreatedAt && manifestCreatedAt <= evaluationStartedAt)) {
    add(
      'sampling_audit_order_invalid',
      'sampling.frozenAt <= audit.manifestCreatedAt <= audit.evaluationStartedAt is required',
    );
  }

  validateContentIdentity(manifest.snapshot, 'snapshot', contentByRef, add);
  validateContentIdentity(manifest.dataset.content, 'dataset.content', contentByRef, add);
  validateContentIdentity(manifest.sampling.plan, 'sampling.plan', contentByRef, add);
  validateContentIdentity(manifest.universe.source, 'universe.source', contentByRef, add);

  for (const category of SOURCE_CATEGORIES) {
    const slice = manifest.sources[category];
    if (slice.provided !== (slice.items.length > 0)) {
      add(
        'source_availability_inconsistent',
        `${category}.provided must match whether items are present`,
      );
    }
    if (!slice.provided && slice.note === null) {
      add('source_unavailable_reason_missing', `${category} requires a note when unavailable`);
    }
    if (slice.required && !slice.provided) {
      add('required_source_unavailable', category);
    }
    for (const [index, item] of slice.items.entries()) {
      const label = `sources.${category}.items.${index}`;
      validateContentIdentity(item, label, contentByRef, add);
      const observedAt = Date.parse(item.observedAt);
      const availableAt = Date.parse(item.availableAt);
      if (observedAt > availableAt) {
        add('source_chronology_invalid', `${label}: observedAt must not be after availableAt`);
      }
      if (observedAt > asOf) {
        add('future_source_observation', `${label}: ${item.observedAt}`);
      }
      if (availableAt > asOf) {
        add('future_source_availability', `${label}: ${item.availableAt}`);
      }
    }
  }

  for (const [index, publication] of manifest.publications.entries()) {
    const label = `publications.${index}`;
    validateContentIdentity(publication, label, contentByRef, add);
    const eventAt = Date.parse(publication.eventAt);
    const publishedAt = Date.parse(publication.publishedAt);
    if (publication.kind === 'report' && eventAt > publishedAt) {
      add('publication_chronology_invalid', `${label}: a report cannot predate its event`);
    }
    if (publishedAt > asOf) {
      add('future_publication', `${label}: ${publication.publishedAt}`);
    }
  }

  const actionByRef = new Map(manifest.corporateActions.map((action) => [action.ref, action]));
  const appliedRefs = new Set(manifest.adjustment.corporateActionRefs);
  if (appliedRefs.size !== manifest.adjustment.corporateActionRefs.length) {
    add('corporate_action_reference_inconsistent', 'adjustment.corporateActionRefs must be unique');
  }
  if (manifest.adjustment.mode === 'unadjusted' && appliedRefs.size > 0) {
    add('corporate_action_adjustment_inconsistent', 'unadjusted data cannot declare applied corporate actions');
  }
  for (const ref of appliedRefs) {
    const action = actionByRef.get(ref);
    if (!action) {
      add('corporate_action_reference_missing', ref);
    } else if (!action.appliedToData) {
      add('corporate_action_reference_inconsistent', `${ref} is referenced as applied but appliedToData is false`);
    }
  }
  for (const [index, action] of manifest.corporateActions.entries()) {
    const label = `corporateActions.${index}`;
    validateContentIdentity(action, label, contentByRef, add);
    const announcedAt = Date.parse(action.announcedAt);
    const effectiveAt = Date.parse(action.effectiveAt);
    if (announcedAt > effectiveAt) {
      add('corporate_action_chronology_invalid', `${label}: announcedAt must not be after effectiveAt`);
    }
    if (announcedAt > asOf) {
      add('corporate_action_future_leak', `${label}: action was not announced at wake as-of`);
    }
    if (action.appliedToData && effectiveAt > asOf) {
      add('corporate_action_future_leak', `${label}: future-effective action was applied to wake data`);
    }
    if (action.appliedToData && !appliedRefs.has(action.ref)) {
      add('corporate_action_reference_inconsistent', `${action.ref} is applied but not linked by adjustment`);
    }
    if (action.appliedToData && manifest.adjustment.mode !== 'adjusted') {
      add('corporate_action_adjustment_inconsistent', `${action.ref} is applied to unadjusted data`);
    }
  }

  if (manifest.universe.selectionBasis !== 'point_in_time') {
    add('survivorship_bias', 'universe selection must use point-in-time membership');
  }
  const membershipAsOf = Date.parse(manifest.universe.membershipAsOf);
  const effectiveFrom = Date.parse(manifest.universe.effectiveFrom);
  const effectiveTo = manifest.universe.effectiveTo === null
    ? null
    : Date.parse(manifest.universe.effectiveTo);
  if (membershipAsOf > asOf) {
    add('future_universe_membership', manifest.universe.membershipAsOf);
  }
  if (effectiveFrom > asOf || (effectiveTo !== null && effectiveTo <= asOf)) {
    add('outside_universe_membership', `membership interval does not include ${manifest.asOf}`);
  }

  return { valid: violations.length === 0, manifest, violations };
}

export function validateStewardEvaluationManifestSet(
  inputs: readonly unknown[],
  contentByRef: Readonly<Record<string, StewardEvaluationContent>>,
): StewardEvaluationManifestSetValidation {
  const violations: StewardEvaluationManifestViolation[] = [];
  const manifests: StewardEvaluationDataManifest[] = [];
  for (const input of inputs) {
    const validation = validateStewardEvaluationDataManifest(input, contentByRef);
    violations.push(...validation.violations);
    if (validation.manifest !== null) manifests.push(validation.manifest);
  }

  const splitIdentities = new Map<string, { datasetId: string; serialized: string }>();
  for (const manifest of manifests) {
    const serialized = JSON.stringify(manifest.split);
    const existing = splitIdentities.get(manifest.split.identity);
    if (existing && (existing.datasetId !== manifest.datasetId || existing.serialized !== serialized)) {
      violations.push(violationFor(
        manifest,
        'split_identity_conflict',
        manifest.split.identity,
      ));
    } else if (!existing) {
      splitIdentities.set(manifest.split.identity, { datasetId: manifest.datasetId, serialized });
    }
  }

  const overlaps: Array<{
    leftDatasetId: string;
    rightDatasetId: string;
    identities: string[];
  }> = [];
  for (let leftIndex = 0; leftIndex < manifests.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < manifests.length; rightIndex += 1) {
      const left = manifests[leftIndex]!;
      const right = manifests[rightIndex]!;
      if (left.split.name === right.split.name) continue;
      if (
        left.dataset.content.ref === right.dataset.content.ref ||
        left.dataset.content.sha256 === right.dataset.content.sha256
      ) {
        violations.push(violationFor(
          left,
          'duplicate_content_across_splits',
          `${left.datasetId}|${right.datasetId}`,
        ));
      }
      const rightIdentities = new Set(derivedLeakageIdentities(right));
      const shared = derivedLeakageIdentities(left).filter((identity) => rightIdentities.has(identity));
      if (shared.length === 0 || !embargoExpandedRangesOverlap(left, right)) continue;
      overlaps.push({
        leftDatasetId: left.datasetId,
        rightDatasetId: right.datasetId,
        identities: shared,
      });
      violations.push(violationFor(
        left,
        'split_embargo_overlap',
        `${left.datasetId}|${right.datasetId}: ${shared.join(',')}`,
      ));
    }
  }

  return { valid: violations.length === 0, violations, overlaps };
}

export function sha256StewardEvaluationContent(value: StewardEvaluationContent): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Enumerate every byte identity named by a strict manifest. Store-backed
 * resolvers use this before invoking the pure chronology/split validators. */
export function stewardEvaluationManifestContentIdentities(
  input: unknown,
): readonly StewardEvaluationContentIdentity[] {
  const manifest = stewardEvaluationDataManifestSchema.parse(input);
  return [
    manifest.snapshot,
    manifest.dataset.content,
    manifest.sampling.plan,
    manifest.universe.source,
    ...SOURCE_CATEGORIES.flatMap((category) => manifest.sources[category].items),
    ...manifest.publications,
    ...manifest.corporateActions,
  ].map(({ ref, sha256 }) => ({ ref, sha256 }));
}

function validateContentIdentity(
  identity: { readonly ref: string; readonly sha256: string },
  label: string,
  contentByRef: Readonly<Record<string, StewardEvaluationContent>>,
  add: (code: StewardEvaluationManifestViolationCode, detail: string) => void,
): void {
  if (!Object.prototype.hasOwnProperty.call(contentByRef, identity.ref)) {
    add('content_missing', `${label}: ${identity.ref}`);
    return;
  }
  const content = contentByRef[identity.ref];
  if (typeof content !== 'string' && !(content instanceof Uint8Array)) {
    add('content_missing', `${label}: ${identity.ref}`);
    return;
  }
  if (sha256StewardEvaluationContent(content) !== identity.sha256) {
    add('content_hash_mismatch', `${label}: ${identity.ref}`);
  }
}

function violationFor(
  manifest: StewardEvaluationDataManifest,
  code: StewardEvaluationManifestViolationCode,
  detail: string,
): StewardEvaluationManifestViolation {
  return { datasetId: manifest.datasetId, wakeId: manifest.wakeId, code, detail };
}

function rawManifestIdentity(input: unknown): { datasetId: string; wakeId: string } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { datasetId: '(malformed)', wakeId: '(malformed)' };
  }
  const record = input as Record<string, unknown>;
  return {
    datasetId: typeof record['datasetId'] === 'string' && record['datasetId'].trim() !== ''
      ? record['datasetId']
      : '(malformed)',
    wakeId: typeof record['wakeId'] === 'string' && record['wakeId'].trim() !== ''
      ? record['wakeId']
      : '(malformed)',
  };
}

function derivedLeakageIdentities(manifest: StewardEvaluationDataManifest): string[] {
  return [...new Set([
    ...manifest.split.leakageGroups.map((group) => `declared:${group}`),
    ...contentLeakageIdentities('snapshot', manifest.snapshot),
    ...contentLeakageIdentities('dataset-content', manifest.dataset.content),
    `source:${manifest.dataset.provider}|${manifest.dataset.name}|${manifest.dataset.rawSymbol}`,
    ...SOURCE_CATEGORIES.flatMap((category) =>
      manifest.sources[category].items.flatMap((item) =>
        contentLeakageIdentities(`source-${category}`, item))),
    ...manifest.publications.flatMap((publication) => [
      ...contentLeakageIdentities('publication', publication),
      `publication-event:${publication.kind}|${publication.eventAt}|${publication.publishedAt}`,
    ]),
    ...manifest.corporateActions.flatMap((action) => [
      ...contentLeakageIdentities('corporate-action', action),
      `corporate-action-event:${action.kind}|${action.announcedAt}|${action.effectiveAt}`,
    ]),
    ...contentLeakageIdentities('universe', manifest.universe.source),
    ...contentLeakageIdentities('sampling-plan', manifest.sampling.plan),
  ])];
}

function contentLeakageIdentities(
  kind: string,
  identity: { readonly ref: string; readonly sha256: string },
): string[] {
  return [
    `${kind}-ref:${identity.ref}`,
    `${kind}-sha256:${identity.sha256}`,
  ];
}

function embargoExpandedRangesOverlap(
  left: StewardEvaluationDataManifest,
  right: StewardEvaluationDataManifest,
): boolean {
  const leftStart = Date.parse(left.split.inputStart) - left.split.embargoMs;
  const leftEnd = Date.parse(left.split.outcomeEnd) + left.split.embargoMs;
  const rightStart = Date.parse(right.split.inputStart) - right.split.embargoMs;
  const rightEnd = Date.parse(right.split.outcomeEnd) + right.split.embargoMs;
  return leftStart < rightEnd && rightStart < leftEnd;
}
