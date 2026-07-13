#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  D4_AUDIT_SCHEMA,
  D4_CELL_SCHEMA,
  D4_DATA_ROOT,
  D4_FROZEN_AT,
  D4_PROFILES,
  D4_SOURCE_RECEIPT_SCHEMA,
  aggregateFourHourBars,
  anonymizeBars,
  canonicalBarsBytes,
  d4CanonicalRoster,
  d4DecisionSlices,
  d4ProfileTotalBars,
  decisionSnapshotBytes,
  fetchSourceBars,
  fetchSplitEvidence,
  reverseFutureSplitAdjustments,
  selectRegimeWindow,
  sha256,
  sourceBarsForDerivedWindow,
  stableJson,
} from './d4-smoke-data.mjs';
import {
  D4_SMOKE_AUTHORIZATION,
  D4_SMOKE_BASELINE_COMMIT,
  D4_SMOKE_BEHAVIOR_VERSION,
  D4_SMOKE_CANDIDATES,
  D4_SMOKE_CREDENTIAL_SOURCES,
  D4_SMOKE_FORBIDDEN_CAPABILITIES,
  D4_SMOKE_INSTRUCTION_REF,
  D4_SMOKE_INSTRUCTION_SHA256,
  D4_SMOKE_PROFILES,
  D4_SMOKE_REPETITIONS,
  D4_SMOKE_RUNTIME_POLICY_REF,
  D4_SMOKE_RUNTIME_POLICY_SHA256,
  D4_SMOKE_SYNTHETIC_ACCOUNT_ID,
  buildD4SmokeStageManifest,
  computeD4SmokeRuntimeTreeIdentity,
  d4SmokeWakeIdPlaceholder,
  validateD4SmokeStage,
} from '../../src/workspaces/steward/d4-smoke-stage-manifest.ts';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const OUTPUT_ROOT = resolve(REPO_ROOT, D4_DATA_ROOT);
const STAGE_PATH = join(OUTPUT_ROOT, 'stage-manifest.json');
const SAMPLING_PATH = join(OUTPUT_ROOT, 'sampling-plan.json');
const STAGE_SHA_PATH = join(OUTPUT_ROOT, 'stage-manifest.sha256');
const CRITIC_RECEIPT_PATH = join(OUTPUT_ROOT, 'critic-approval.json');
const QUOTA_ROOT = join(OUTPUT_ROOT, 'quota');
const QUOTA_FORECAST_PATH = join(QUOTA_ROOT, 'forecast-observations.json');
const QUOTA_CODEX_BEFORE_PATH = join(QUOTA_ROOT, 'codex-before.json');
const QUOTA_CODEX_AFTER_PATH = join(QUOTA_ROOT, 'codex-after.json');
const QUOTA_CLAUDE_BEFORE_PATH = join(QUOTA_ROOT, 'claude-before.json');
const QUOTA_CLAUDE_AFTER_PATH = join(QUOTA_ROOT, 'claude-after.json');

const SAMPLING_PLAN = {
  schema: 'steward-d4-sampling-plan/1',
  version: 1,
  authorization: 'AUTH-D4-DEV',
  frozenAt: D4_FROZEN_AT,
  split: 'dev',
  window: 'a',
  sourcePolicy: 'public-no-incremental-cost',
  adjustment: {
    provider: 'Yahoo quote OHLCV is retrospectively split-adjusted; Binance spot bars use native units.',
    candidate: 'Rebased candidate OHLCV is declared unadjusted only after a per-decision byte-invariance proof removes every not-yet-effective split factor.',
    boundary: 'A selected cell may not straddle a split effective timestamp.',
  },
  selection: {
    bull: 'Choose the exact-length consecutive derived window with the greatest log(lastClose/firstClose); ties keep the earliest source index.',
    bear: 'Choose the exact-length consecutive derived window with the smallest log(lastClose/firstClose); ties keep the earliest source index.',
  },
  boundary: {
    formula: 'T = L + D * C',
    sourceBarIndexing: 'zero-based',
    decisionOrdinal: 'd = 0..D-1',
    candidateVisiblePrefix: '[0, L + d * C)',
    decisionAsOfIndex: 'L + d * C - 1',
    outcomeOnlyTail: 'the final C bars [L + (D - 1) * C, T) are never candidate-visible',
  },
  transform: {
    fourHour: 'Aggregate only complete UTC-aligned groups of four strictly consecutive one-hour bars; drop partial/gapped groups.',
    priceAnonymization: 'Rebase OHLC to first selected close = 100 and round to six decimals.',
    volumeAnonymization: 'Rebase volume to first positive selected volume = 100; all-zero series remain zero; round to six decimals.',
    chronology: 'Source timestamps and symbols stay in audit files; candidate cells contain only zero-based fictional bar indices.',
  },
};

async function main() {
  const mode = process.argv[2] ?? '--verify';
  if (mode === '--build') {
    await buildPackage();
  } else if (mode === '--verify') {
    await verifyCheckedInPackage({ requireApproval: false });
  } else if (mode === '--verify-approved') {
    await verifyCheckedInPackage({ requireApproval: true });
  } else if (mode === '--verify-source') {
    await verifyCheckedInPackage({ requireApproval: false });
    await verifyFrozenSources();
  } else {
    throw new Error('usage: build-d4-smoke-data.mjs --build|--verify|--verify-approved|--verify-source');
  }
}

async function buildPackage() {
  if (existsSync(STAGE_PATH) && !process.argv.includes('--replace-unapproved')) {
    throw new Error('refusing to replace the checked-in stage manifest; use --verify or explicitly pass --replace-unapproved before critic approval');
  }
  mkdirSync(OUTPUT_ROOT, { recursive: true });
  writeJson(SAMPLING_PATH, SAMPLING_PLAN);
  writeQuotaEvidence();
  const samplingIdentity = fileIdentity(SAMPLING_PATH);
  const cells = [];
  const splitEvidenceCache = new Map();

  for (const [ordinal, item] of d4CanonicalRoster().entries()) {
    process.stderr.write(`[d4-data] ${ordinal + 1}/12 ${item.cellId}\n`);
    const profile = D4_PROFILES[item.profile];
    const fetched = await fetchSourceBars(item, profile);
    const derivedBars = item.profile === 'bear' ? aggregateFourHourBars(fetched.bars) : fetched.bars;
    const totalBars = d4ProfileTotalBars(profile);
    const selection = selectRegimeWindow(derivedBars, totalBars, item.profile);
    const selectedDerived = derivedBars.slice(selection.start, selection.endExclusive);
    const selectedSource = sourceBarsForDerivedWindow(fetched.bars, selectedDerived);
    const decisions = d4DecisionSlices(profile);
    const candidate = candidateCell(item, profile, selectedDerived, decisions);
    const candidatePath = join(OUTPUT_ROOT, 'candidate', `${item.cellId}.json`);
    writeJson(candidatePath, candidate);
    const candidateIdentity = fileIdentity(candidatePath);

    const auditPath = join(OUTPUT_ROOT, 'audit', `${item.cellId}.json`);
    const auditRef = repoRelative(auditPath);
    const instrumentKey = `${item.provider}:${item.symbol}`;
    let fetchedSplits = splitEvidenceCache.get(instrumentKey);
    if (fetchedSplits === undefined) {
      fetchedSplits = await fetchSplitEvidence(item);
      splitEvidenceCache.set(instrumentKey, fetchedSplits);
    }
    const splitEvidence = buildSplitEvidence(item, fetchedSplits, auditRef);
    assertNoSelectedSplitBoundary(selectedDerived, splitEvidence.actions, item.cellId);
    const futureSplitInvariance = buildFutureSplitInvariance(
      candidate,
      decisions,
      selectedDerived,
      splitEvidence.actions,
    );
    const splitEvidenceIdentity = embeddedIdentity(`${auditRef}#split-evidence`, splitEvidence);
    const receipt = sourceReceipt(
      item,
      profile,
      fetched,
      derivedBars,
      selectedSource,
      selectedDerived,
      selection,
      splitEvidenceIdentity,
      futureSplitInvariance,
    );
    const receiptIdentity = embeddedIdentity(`${auditRef}#source-receipt`, receipt);
    const universeEvidence = {
      cellId: item.cellId,
      selectionBasis: 'point_in_time',
      instrumentObservedFrom: selectedSource[0].timestamp,
      instrumentObservedThrough: selectedSource.at(-1).availableAt,
      evidence: 'The frozen single-instrument universe was selected before model calls and is evidenced by the pinned provider-bar receipt.',
      sourceReceipt: receiptIdentity,
    };
    const universeIdentity = embeddedIdentity(`${auditRef}#universe`, universeEvidence);
    const ranges = asOfRanges(selectedDerived, decisions);
    const leakageGroups = [`market:${item.market}`, `instrument:${item.provider}:${item.symbol}`];
    const decisionManifests = decisions.map((decision) => decisionManifest({
      item,
      profile,
      candidate,
      decision,
      selectedDerived,
      samplingIdentity,
      universeIdentity,
      ranges,
      leakageGroups,
      splitActions: splitEvidence.actions,
    }));
    const audit = {
      schema: D4_AUDIT_SCHEMA,
      version: 1,
      cellId: item.cellId,
      split: 'dev',
      sourceReceipt: receipt,
      splitEvidence,
      futureSplitInvariance,
      universeEvidence,
      decisionManifests,
    };
    writeJson(auditPath, audit);
    const auditIdentity = fileIdentity(auditPath);
    cells.push({
      id: item.cellId,
      split: 'dev',
      stratum: `${item.market}:${item.profile}`,
      market: item.market,
      profile: item.profile,
      window: 'a',
      pairingKey: item.cellId,
      temporal: D4_SMOKE_PROFILES[item.profile],
      instrument: {
        provider: item.provider,
        symbol: item.symbol,
        datasetName: `${profile.barInterval}-ohlcv-anonymized`,
        assetClass: item.assetClass,
        timezone: item.timezone,
        exchangeCalendar: item.exchangeCalendar,
        providerAdjustmentMode: fetched.providerAdjustmentMode,
        candidateAdjustmentMode: 'unadjusted_split_invariant_rebase',
        d3AdjustmentMode: 'unadjusted',
      },
      asOf: {
        decisionStart: ranges.decisionStart,
        decisionEnd: ranges.decisionEnd,
        outcomeEnd: ranges.outcomeEnd,
      },
      evidence: {
        candidatePayload: candidateIdentity,
        audit: auditIdentity,
        sourceReceipt: receiptIdentity,
        splitEvidence: splitEvidenceIdentity,
        samplingPlan: samplingIdentity,
        selectedRaw: receipt.selectedRaw,
        selectedDerived: receipt.selectedDerived,
      },
    });
  }

  const quotaForecastEvidence = fileIdentity(QUOTA_FORECAST_PATH);
  const runtimeTree = await computeD4SmokeRuntimeTreeIdentity({ repoRoot: REPO_ROOT });
  const artifact = buildD4SmokeStageManifest({
    authorization: D4_SMOKE_AUTHORIZATION,
    stage: 'Smoke',
    split: 'dev',
    baseline: {
      commit: D4_SMOKE_BASELINE_COMMIT,
      behaviorVersion: D4_SMOKE_BEHAVIOR_VERSION,
      instruction: { ref: D4_SMOKE_INSTRUCTION_REF, sha256: D4_SMOKE_INSTRUCTION_SHA256 },
      runtimePolicy: { ref: D4_SMOKE_RUNTIME_POLICY_REF, sha256: D4_SMOKE_RUNTIME_POLICY_SHA256 },
      quotaForecastEvidence,
      runtimeTree,
    },
    proposalOnly: {
      authzLevel: 'read_only',
      accountId: D4_SMOKE_SYNTHETIC_ACCOUNT_ID,
      configuredUta: false,
      outputs: ['decision_intent', 'information_snapshot'],
      forbiddenCapabilities: [...D4_SMOKE_FORBIDDEN_CAPABILITIES],
    },
    credentialSources: [...D4_SMOKE_CREDENTIAL_SOURCES],
    candidates: [...D4_SMOKE_CANDIDATES],
    repetitions: [...D4_SMOKE_REPETITIONS],
    cells,
  });
  writeFileSync(STAGE_PATH, artifact.bytes);
  writeFileSync(STAGE_SHA_PATH, `${artifact.sha256}  stage-manifest.json\n`);
  await verifyCheckedInPackage({ requireApproval: false });
  process.stderr.write(`[d4-data] wrote ${repoRelative(STAGE_PATH)} sha256=${artifact.sha256}\n`);
}

async function verifyCheckedInPackage({ requireApproval }) {
  const instructionPath = resolve(REPO_ROOT, D4_SMOKE_INSTRUCTION_REF);
  if (sha256(readFileSync(instructionPath)) !== D4_SMOKE_INSTRUCTION_SHA256) {
    throw new Error('v9-RUNTIME instruction content drift');
  }
  const manifestBytes = readFileSync(STAGE_PATH);
  const manifest = JSON.parse(manifestBytes);
  const expectedSidecar = `${sha256(manifestBytes)}  stage-manifest.json\n`;
  if (readFileSync(STAGE_SHA_PATH, 'utf8') !== expectedSidecar) throw new Error('stage manifest sidecar hash mismatch');
  const receiptExists = existsSync(CRITIC_RECEIPT_PATH);
  if (requireApproval && !receiptExists) throw new Error('detached critic approval receipt is required');
  const receipt = receiptExists
    ? JSON.parse(readFileSync(CRITIC_RECEIPT_PATH, 'utf8'))
    : {
        schema: 'steward-d4-critic-receipt/1',
        version: 1,
        manifestSha256: sha256(manifestBytes),
        reviewerIdentity: 'unapproved-local-shape-validation',
        verdict: 'APPROVE',
        reviewedCommit: 'deadbee',
      };
  const contentByRef = readStageContent(manifest);
  await validateD4SmokeStage({
    manifestBytes,
    receipt,
    repoRoot: REPO_ROOT,
    contentByRef,
    ...(receiptExists ? {} : {
      gitVerifier: async () => ({
        head: 'unapproved',
        reviewedCommitIsAncestor: true,
        reviewedManifestMatches: true,
        headManifestMatches: true,
        reviewedRuntimeTreeMatches: true,
        headRuntimeTreeMatches: true,
        worktreeRuntimeTreeMatches: true,
      }),
    }),
  });
  for (const cell of manifest.content.cells) {
    for (const field of ['candidatePayload', 'audit', 'samplingPlan']) verifyFileIdentity(cell.evidence[field]);
    const audit = JSON.parse(readFileSync(resolve(REPO_ROOT, cell.evidence.audit.ref), 'utf8'));
    if (audit.schema !== D4_AUDIT_SCHEMA || audit.cellId !== cell.id) throw new Error(`audit mismatch: ${cell.id}`);
    verifyEmbeddedIdentity(cell.evidence.sourceReceipt, audit.sourceReceipt);
    verifyEmbeddedIdentity(cell.evidence.splitEvidence, audit.splitEvidence);
    if (stableJson(audit.sourceReceipt.splitEvidence) !== stableJson(cell.evidence.splitEvidence) ||
        stableJson(audit.sourceReceipt.futureSplitInvariance) !== stableJson(audit.futureSplitInvariance)) {
      throw new Error(`split evidence projection mismatch: ${cell.id}`);
    }
    for (const action of audit.splitEvidence.actions) verifyEmbeddedIdentity(action.content, action.artifact);
    if (stableJson(cell.evidence.selectedRaw) !== stableJson(audit.sourceReceipt.selectedRaw) ||
        stableJson(cell.evidence.selectedDerived) !== stableJson(audit.sourceReceipt.selectedDerived)) {
      throw new Error(`source receipt projection mismatch: ${cell.id}`);
    }
    for (const identity of audit.sourceReceipt.recipe.implementation) verifyFileIdentity(identity);
  }
  process.stderr.write(`[d4-data] verified ${manifest.content.cells.length} checked-in cells (${receiptExists ? 'approved' : 'unapproved'})\n`);
}

async function verifyFrozenSources() {
  const manifest = JSON.parse(readFileSync(STAGE_PATH, 'utf8'));
  const splitEvidenceCache = new Map();
  for (const cell of manifest.content.cells) {
    process.stderr.write(`[d4-data] source verify ${cell.id}\n`);
    const audit = JSON.parse(readFileSync(resolve(REPO_ROOT, cell.evidence.audit.ref), 'utf8'));
    const receipt = audit.sourceReceipt;
    const profile = D4_PROFILES[cell.profile];
    const fetched = await fetchSourceBars(cell.instrument, profile);
    const derived = cell.profile === 'bear' ? aggregateFourHourBars(fetched.bars) : fetched.bars;
    const selection = selectRegimeWindow(derived, d4ProfileTotalBars(profile), cell.profile);
    const selectedDerived = derived.slice(selection.start, selection.endExclusive);
    const selectedRaw = sourceBarsForDerivedWindow(fetched.bars, selectedDerived);
    const instrumentKey = `${cell.instrument.provider}:${cell.instrument.symbol}`;
    let fetchedSplits = splitEvidenceCache.get(instrumentKey);
    if (fetchedSplits === undefined) {
      fetchedSplits = await fetchSplitEvidence(cell.instrument);
      splitEvidenceCache.set(instrumentKey, fetchedSplits);
    }
    const auditRef = cell.evidence.audit.ref;
    const splitEvidence = buildSplitEvidence({ ...cell.instrument, cellId: cell.id }, fetchedSplits, auditRef);
    if (stableJson(splitEvidence) !== stableJson(audit.splitEvidence)) {
      throw new Error(`frozen split evidence drift: ${cell.id}`);
    }
    assertNoSelectedSplitBoundary(selectedDerived, splitEvidence.actions, cell.id);
    const candidate = JSON.parse(readFileSync(resolve(REPO_ROOT, cell.evidence.candidatePayload.ref), 'utf8'));
    const futureSplitInvariance = buildFutureSplitInvariance(
      candidate,
      candidate.decisions,
      selectedDerived,
      splitEvidence.actions,
    );
    if (stableJson(futureSplitInvariance) !== stableJson(receipt.futureSplitInvariance)) {
      throw new Error(`future split proof drift: ${cell.id}`);
    }
    const identities = {
      acquisition: barsIdentity(`remote:${cell.id}:acquisition`, fetched.bars),
      derivedPool: barsIdentity(`derived:${cell.id}:pool`, derived),
      selectedRaw: barsIdentity(`remote:${cell.id}:selected`, selectedRaw),
      selectedDerived: barsIdentity(`derived:${cell.id}:selected`, selectedDerived),
    };
    for (const [field, identity] of Object.entries(identities)) {
      if (stableJson(identity) !== stableJson(receipt[field])) throw new Error(`frozen source drift: ${cell.id}.${field}`);
    }
    if (selection.start !== receipt.selection.derivedPoolIndexStart ||
        selection.endExclusive !== receipt.selection.derivedPoolIndexEndExclusive ||
        selection.score !== receipt.selection.logReturn) throw new Error(`selection drift: ${cell.id}`);
  }
  process.stderr.write('[d4-data] frozen public sources match every receipt\n');
}

function candidateCell(item, profile, selectedDerived, decisions) {
  return {
    schema: D4_CELL_SCHEMA,
    version: 1,
    cellId: item.cellId,
    split: 'dev',
    window: 'a',
    profile: item.profile,
    axes: axes(profile),
    codename: `INSTRUMENT-${String(Math.floor(
      d4CanonicalRoster().findIndex((entry) => entry.cellId === item.cellId) / 2,
    ) + 1).padStart(2, '0')}`,
    interval: profile.barInterval,
    priceBasis: 'first selected close rebased to 100; source symbol, price scale, and timestamps withheld',
    timeBasis: 'zero-based fictional bar index',
    boundary: SAMPLING_PLAN.boundary,
    decisions,
    bars: anonymizeBars(selectedDerived),
  };
}

function sourceReceipt(
  item,
  profile,
  fetched,
  derivedBars,
  selectedRaw,
  selectedDerived,
  selection,
  splitEvidenceIdentity,
  futureSplitInvariance,
) {
  return {
    schema: D4_SOURCE_RECEIPT_SCHEMA,
    version: 1,
    createdAt: D4_FROZEN_AT,
    redistribution: 'receipt-only',
    provider: item.provider,
    symbol: item.symbol,
    assetClass: item.assetClass,
    timezone: item.timezone,
    exchangeCalendar: item.exchangeCalendar,
    providerAdjustmentMode: fetched.providerAdjustmentMode,
    candidateAdjustmentMode: 'unadjusted_split_invariant_rebase',
    splitEvidence: splitEvidenceIdentity,
    futureSplitInvariance,
    request: fetched.request,
    acquisition: barsIdentity(`remote:${item.cellId}:acquisition`, fetched.bars),
    derivedPool: barsIdentity(`derived:${item.cellId}:pool`, derivedBars),
    selectedRaw: barsIdentity(`remote:${item.cellId}:selected`, selectedRaw),
    selectedDerived: barsIdentity(`derived:${item.cellId}:selected`, selectedDerived),
    selection: {
      profile: item.profile,
      exactBarCount: d4ProfileTotalBars(profile),
      derivedPoolIndexStart: selection.start,
      derivedPoolIndexEndExclusive: selection.endExclusive,
      logReturn: selection.score,
      firstTimestamp: selectedDerived[0].timestamp,
      finalAvailableAt: selectedDerived.at(-1).availableAt,
    },
    recipe: {
      command: 'pnpm exec tsx tools/campaigns/build-d4-smoke-data.mjs --verify-source',
      failClosed: 'Any request, canonical byte identity, exact selection index, or transform drift is an error.',
      implementation: [
        fileIdentity(resolve(REPO_ROOT, 'tools/campaigns/d4-smoke-data.mjs')),
        fileIdentity(resolve(REPO_ROOT, 'tools/campaigns/build-d4-smoke-data.mjs')),
      ],
    },
  };
}

function buildSplitEvidence(item, fetchedSplits, auditRef) {
  const actions = fetchedSplits.events.map((event, index) => {
    const announcementEvidence = splitAnnouncementEvidence(item, event);
    const artifact = {
      schema: 'steward-d4-split-action-evidence/1',
      provider: item.provider,
      symbol: item.symbol,
      effectiveAt: event.effectiveAt,
      numerator: event.numerator,
      denominator: event.denominator,
      splitRatio: event.splitRatio,
      announcedAt: announcementEvidence?.availableNoLaterThan ?? event.effectiveAt,
      announcementEvidence,
      availabilityPolicy: announcementEvidence === null
        ? 'Provider evidence proves the action no later than effectiveAt; earlier announcement access is not claimed.'
        : 'Primary issuer evidence supplies a conservative end-of-publication-date availability bound.',
    };
    return {
      artifact,
      content: embeddedIdentity(
        `${auditRef}#split-${String(index + 1).padStart(2, '0')}`,
        artifact,
      ),
    };
  });
  return {
    schema: 'steward-d4-split-evidence/1',
    version: 1,
    cellId: item.cellId,
    provider: item.provider,
    symbol: item.symbol,
    providerAdjustmentMode: fetchedSplits.providerAdjustmentMode,
    cutoff: fetchedSplits.cutoff,
    request: fetchedSplits.request,
    note: fetchedSplits.note,
    actions,
  };
}

function splitAnnouncementEvidence(item, event) {
  if (item.provider === 'yahoo-chart-public' && item.symbol === 'NVDA' &&
      event.splitRatio === '10:1' && event.effectiveAt === '2024-06-10T13:30:00.000Z') {
    return {
      publisher: 'NVIDIA Newsroom',
      publishedDate: '2024-05-22',
      availableNoLaterThan: '2024-05-23T00:00:00.000Z',
      ref: 'https://nvidianews.nvidia.com/news/nvidia-announces-financial-results-for-first-quarter-fiscal-2025',
      statement: 'Ten-for-one forward stock split; split-adjusted trading expected at market open on June 10, 2024.',
    };
  }
  return null;
}

function assertNoSelectedSplitBoundary(selectedDerived, splitActions, cellId) {
  const start = Date.parse(selectedDerived[0].timestamp);
  const end = Date.parse(selectedDerived.at(-1).availableAt);
  const crossing = splitActions.find((action) => {
    const effectiveAt = Date.parse(action.artifact.effectiveAt);
    return effectiveAt > start && effectiveAt < end;
  });
  if (crossing) {
    throw new Error(`selected window straddles split action: ${cellId} ${crossing.artifact.effectiveAt}`);
  }
}

function buildFutureSplitInvariance(candidate, decisions, selectedDerived, splitActions) {
  const splitEvents = splitActions.map((action) => action.artifact);
  return decisions.map((decision) => {
    const asOf = selectedDerived[decision.asOfBarIndex].availableAt;
    const visibleSource = selectedDerived.slice(0, decision.visibleEndExclusive);
    const providerVisibleBars = candidate.bars.slice(0, decision.visibleEndExclusive);
    const deadjustedVisibleBars = anonymizeBars(
      reverseFutureSplitAdjustments(visibleSource, splitEvents, asOf),
    );
    const providerVisibleBarsSha256 = sha256(`${stableJson(providerVisibleBars)}\n`);
    const deadjustedVisibleBarsSha256 = sha256(`${stableJson(deadjustedVisibleBars)}\n`);
    if (providerVisibleBarsSha256 !== deadjustedVisibleBarsSha256) {
      throw new Error(`future split changes candidate bytes: ${candidate.cellId} decision ${decision.ordinal}`);
    }
    return {
      decisionOrdinal: decision.ordinal,
      asOf,
      futureSplitRefs: splitActions
        .filter((action) => Date.parse(action.artifact.effectiveAt) > Date.parse(asOf))
        .map((action) => action.content.ref),
      providerVisibleBarsSha256,
      deadjustedVisibleBarsSha256,
      invariant: true,
    };
  });
}

function decisionManifest(context) {
  const { item, profile, candidate, decision, selectedDerived,
    samplingIdentity, universeIdentity, ranges, leakageGroups, splitActions } = context;
  const asOfBar = selectedDerived[decision.asOfBarIndex];
  const snapshotBytes = decisionSnapshotBytes(candidate, decision);
  const snapshot = {
    ref: sha256(`d4-snapshot|${item.cellId}|${decision.ordinal}`).slice(0, 40),
    sha256: sha256(snapshotBytes),
  };
  const wakeId = d4SmokeWakeIdPlaceholder(decision.ordinal - 1);
  const corporateActions = splitActions
    .filter((action) => Date.parse(action.artifact.effectiveAt) <= Date.parse(asOfBar.availableAt))
    .map((action) => ({
      ...action.content,
      kind: 'split',
      announcedAt: action.artifact.announcedAt,
      effectiveAt: action.artifact.effectiveAt,
      appliedToData: false,
    }));
  const unavailable = (note) => ({ required: false, provided: false, items: [], note });
  return {
    schema: 'steward-eval-data-manifest/1',
    version: 1,
    wakeId,
    datasetId: item.cellId,
    asOf: asOfBar.availableAt,
    snapshot,
    dataset: {
      provider: item.provider,
      name: `${profile.barInterval}-ohlcv-anonymized`,
      rawSymbol: item.symbol,
      assetClass: item.assetClass,
      timezone: item.timezone,
      exchangeCalendar: item.exchangeCalendar,
      content: snapshot,
    },
    adjustment: { mode: 'unadjusted', corporateActionRefs: [] },
    sources: {
      market: {
        required: true,
        provided: true,
        items: [{ ...snapshot, observedAt: asOfBar.availableAt, availableAt: asOfBar.availableAt }],
        note: null,
      },
      portfolio: unavailable('Runtime sandbox supplies the fresh portfolio snapshot.'),
      risk: unavailable('Runtime sandbox supplies the frozen deterministic risk context.'),
      events: unavailable('This price-only Smoke cell supplies no publication or event stream.'),
      history: unavailable('Runtime sandbox supplies only history created within this cell execution.'),
    },
    publications: [],
    corporateActions,
    universe: {
      selectionBasis: 'point_in_time',
      membershipAsOf: selectedDerived[0].timestamp,
      effectiveFrom: selectedDerived[0].timestamp,
      effectiveTo: null,
      source: universeIdentity,
    },
    sampling: {
      kind: 'regime_labeled',
      frozenAt: D4_FROZEN_AT,
      plan: samplingIdentity,
    },
    audit: {
      manifestCreatedAt: D4_FROZEN_AT,
      evaluationStartedAt: D4_FROZEN_AT,
    },
    split: {
      name: 'dev',
      identity: `split:dev:${item.cellId}`,
      leakageGroups,
      inputStart: ranges.inputStart,
      decisionStart: ranges.decisionStart,
      decisionEnd: ranges.decisionEnd,
      outcomeEnd: ranges.outcomeEnd,
      embargoMs: profile.barInterval === '1d' ? 24 * 60 * 60 * 1000 : 4 * 60 * 60 * 1000,
    },
  };
}

function asOfRanges(selectedDerived, decisions) {
  return {
    inputStart: selectedDerived[0].timestamp,
    decisionStart: selectedDerived[decisions[0].asOfBarIndex].availableAt,
    decisionEnd: selectedDerived[decisions.at(-1).asOfBarIndex].availableAt,
    outcomeEnd: selectedDerived.at(-1).availableAt,
  };
}

function writeQuotaEvidence() {
  const codexBucket = (limitId, usedPercent, resetsAt, credits) => ({
    limitId,
    limitName: limitId === 'codex_bengalfox' ? 'GPT-5.3-Codex-Spark' : null,
    primary: { usedPercent, windowDurationMins: 10_080, resetsAt },
    secondary: null,
    credits,
    individualLimit: null,
    planType: 'pro',
    rateLimitReachedType: null,
  });
  const codexSnapshot = (sparkReset) => {
    const general = codexBucket('codex', 22, 1784487541, {
      hasCredits: false,
      unlimited: false,
      balance: '0',
    });
    const spark = codexBucket('codex_bengalfox', 0, sparkReset, null);
    return {
      rateLimits: general,
      rateLimitsByLimitId: { codex: general, codex_bengalfox: spark },
      rateLimitResetCredits: { availableCount: 0, credits: [] },
      provenance: {
        control: 'Codex app-server account/rateLimits/read',
        calibration: 'G2 reachability probes: four general-window model turns and one Spark-window model turn',
        incrementalSpendUsd: 0,
      },
    };
  };
  const claudeSnapshot = (capturedAt) => ({
    session: {
      total_cost_usd: 0,
      total_api_duration_ms: 0,
      model_usage: {},
      num_turns: 0,
    },
    subscription_type: 'max',
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 16, resets_at: '2026-07-13T13:00:00.000Z' },
      seven_day: { utilization: 59, resets_at: '2026-07-18T03:00:00.000Z' },
      model_scoped: [{
        display_name: 'Fable',
        utilization: 54,
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
        used: { amount_minor: 0 },
        can_purchase_credits: false,
      },
    },
    provenance: {
      control: 'Claude Code native /usage JSON result',
      capturedAt,
      normalization: 'Integer utilization and reset text from the native result are projected into the later SDK usage-control response shape required by the frozen runner.',
      nativeResult: {
        total_cost_usd: 0,
        num_turns: 0,
        modelUsage: {},
        currentSession: '16% used; resets Jul 13, 4pm (Asia/Riyadh)',
        currentWeekAllModels: '59% used; resets Jul 18, 6am (Asia/Riyadh)',
        currentWeekFable: '54% used; resets Jul 18, 6am (Asia/Riyadh)',
      },
      calibration: 'G2 reachability probes: four all-model/short-window model turns, including one Fable-window model turn',
      incrementalSpendUsd: 0,
    },
  });

  writeJson(QUOTA_CODEX_BEFORE_PATH, codexSnapshot(1784535591));
  writeJson(QUOTA_CODEX_AFTER_PATH, codexSnapshot(1784535763));
  writeJson(QUOTA_CLAUDE_BEFORE_PATH, claudeSnapshot('2026-07-13T08:20:27.776Z'));
  writeJson(QUOTA_CLAUDE_AFTER_PATH, claudeSnapshot('2026-07-13T08:23:06.841Z'));

  writeJson(QUOTA_FORECAST_PATH, {
    schema: 'steward-d4-quota-forecast-observations/1',
    version: 1,
    sourceIdentity: 'native-subscription-controls',
    observations: [
      {
        id: 'g2-codex-reachability-calibration',
        provider: 'codex',
        charges: [
          { id: 'codex-general-weekly', chargedTurnCount: 4, resolutionPercent: 1 },
          { id: 'codex-spark', chargedTurnCount: 1, resolutionPercent: 1 },
        ],
        before: {
          capturedAt: '2026-07-13T08:19:51.752Z',
          raw: fileIdentity(QUOTA_CODEX_BEFORE_PATH),
        },
        after: {
          capturedAt: '2026-07-13T08:23:16.303Z',
          raw: fileIdentity(QUOTA_CODEX_AFTER_PATH),
        },
      },
      {
        id: 'g2-claude-reachability-calibration',
        provider: 'claude',
        charges: [
          { id: 'claude-all-model-weekly', chargedTurnCount: 4, resolutionPercent: 1 },
          { id: 'claude-fable-weekly', chargedTurnCount: 1, resolutionPercent: 1 },
          { id: 'claude-current-short', chargedTurnCount: 4, resolutionPercent: 1 },
        ],
        before: {
          capturedAt: '2026-07-13T08:20:27.776Z',
          raw: fileIdentity(QUOTA_CLAUDE_BEFORE_PATH),
        },
        after: {
          capturedAt: '2026-07-13T08:23:06.841Z',
          raw: fileIdentity(QUOTA_CLAUDE_AFTER_PATH),
        },
      },
    ],
  });
}

function readStageContent(manifest) {
  const contentByRef = {
    [manifest.content.baseline.instruction.ref]: readFileSync(
      resolve(REPO_ROOT, manifest.content.baseline.instruction.ref),
    ),
    [manifest.content.baseline.runtimePolicy.ref]: readFileSync(
      resolve(REPO_ROOT, manifest.content.baseline.runtimePolicy.ref),
    ),
    [manifest.content.baseline.quotaForecastEvidence.ref]: readFileSync(
      resolve(REPO_ROOT, manifest.content.baseline.quotaForecastEvidence.ref),
    ),
  };
  const forecast = JSON.parse(contentByRef[manifest.content.baseline.quotaForecastEvidence.ref]);
  for (const observation of forecast.observations) {
    for (const snapshot of [observation.before, observation.after]) {
      contentByRef[snapshot.raw.ref] = readFileSync(resolve(REPO_ROOT, snapshot.raw.ref));
    }
  }
  for (const cell of manifest.content.cells) {
    for (const field of ['candidatePayload', 'audit', 'samplingPlan']) {
      const identity = cell.evidence[field];
      contentByRef[identity.ref] = readFileSync(resolve(REPO_ROOT, identity.ref));
    }
  }
  return contentByRef;
}

function axes(profile) {
  return {
    barInterval: profile.barInterval,
    decisionCadenceBars: profile.cadenceBars,
    lookbackBars: profile.lookbackBars,
    episodeDecisions: profile.decisionCount,
  };
}

function barsIdentity(ref, bars) {
  const bytes = canonicalBarsBytes(bars);
  return { ref, sha256: sha256(bytes), canonicalByteLength: Buffer.byteLength(bytes), barCount: bars.length };
}

function embeddedIdentity(ref, value) {
  return { ref, sha256: sha256(`${stableJson(value)}\n`) };
}

function verifyEmbeddedIdentity(identity, value) {
  if (identity.sha256 !== sha256(`${stableJson(value)}\n`)) throw new Error(`embedded identity mismatch: ${identity.ref}`);
}

function fileIdentity(path) {
  return { ref: repoRelative(path), sha256: sha256(readFileSync(path)) };
}

function verifyFileIdentity(identity) {
  const path = resolve(REPO_ROOT, identity.ref);
  if (sha256(readFileSync(path)) !== identity.sha256) throw new Error(`file identity mismatch: ${identity.ref}`);
}

function repoRelative(path) {
  return relative(REPO_ROOT, path).split('\\').join('/');
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`ERROR: ${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
