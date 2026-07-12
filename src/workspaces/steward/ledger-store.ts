import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { canonicalDecisionFingerprint } from './ledger-receipt.js';
import { withLedgerWrite } from './ledger-writer.js';
import {
  parseStewardDecisionLedgerEntry,
  parseStewardDecisionLedgerEntryLenient,
  type StewardDecisionLedgerEntry,
} from './types.js';
import { stewardLedgerPath } from './paths.js';

/**
 * The first-wins line for a wakeId (issue #134). "First-wins" here is the FIRST
 * JSON-parseable object line with that wakeId, regardless of whether it also
 * passes the (lenient) schema — chosen so the TypeScript supervisor and the
 * generated JS validator select the SAME line even when a JSON-valid but
 * schema-invalid line precedes a valid one. `fingerprint` is the canonical
 * semantic fingerprint of that line; `valid` says whether it schema-parsed
 * (only a valid first-wins line drives a status transition); `entry` is the
 * parsed entry when valid, else null.
 */
export interface LedgerFirstWins {
  /** 1-based line number of the first-wins line. */
  readonly line: number;
  readonly fingerprint: string;
  readonly valid: boolean;
  readonly entry: StewardDecisionLedgerEntry | null;
}

/**
 * A ledger line whose top-level `wakeId` disagrees with a `wake:` evidence
 * self-reference inside it (issue #139). This is the signature of a misfiled
 * entry: the steward wrote the entry under the wrong top-level wakeId (e.g. it
 * copied a prior wake's UUID suffix) while its evidence still referenced the
 * real active wake. Surfacing it lets the supervisor tell the correct active
 * wake, promptly, that its completion was filed under the wrong id — instead of
 * silently waiting out the whole deadline.
 */
export interface LedgerIdentityMismatch {
  /** 1-based line number. */
  readonly line: number;
  /** The (wrong) top-level wakeId the entry was filed under. */
  readonly entryWakeId: string;
  /** The wakeId the entry's `wake:` evidence self-reference actually names. */
  readonly referencedWakeId: string;
}

/**
 * The whole ledger parsed ONCE (issue #134, no O(n²) re-reads): the ordered
 * list of schema-valid entries (for cost/state), the invalid lines, the
 * duplicate wakeIds, the first-wins index used for reconciliation and
 * integrity, and the identity mismatches (issue #139). Supervisor ticks build
 * this a single time and reuse it for every wake.
 */
export interface LedgerIndex extends ReadLedgerDiagnostics {
  readonly firstWins: ReadonlyMap<string, LedgerFirstWins>;
  readonly identityMismatches: LedgerIdentityMismatch[];
}

export interface ReadLedgerOptions {
  readonly wakeId?: string;
  readonly limit?: number;
}

/** One ledger line that failed to parse even after the numeric-coercion
 *  tolerance in `stewardCostSchema` — e.g. invalid JSON, or a required field
 *  missing entirely. Reported, never thrown: see {@link StewardLedgerStore.read}. */
export interface InvalidLedgerLine {
  /** 1-based line number within the ledger file. */
  readonly line: number;
  readonly error: string;
}

/** A wakeId that appears on more than one parsed ledger line. Issue #125 D3
 *  makes exactly one terminal entry per wakeId the rule: the FIRST entry wins
 *  (corruption-evident — a later append can never alter the recorded decision) and
 *  every later duplicate is surfaced here as a violation. Reported, never
 *  thrown, so the supervisor/reports can see it; the validator errors on it. */
export interface DuplicateWakeEntry {
  readonly wakeId: string;
  /** 1-based line of the winning (first) entry for this wakeId. */
  readonly firstLine: number;
  /** 1-based line of the later duplicate that is being ignored. */
  readonly duplicateLine: number;
}

/** The full result of parsing a ledger file: every line that parsed, plus
 *  every line that didn't (with why), plus every wakeId that appeared more than
 *  once (D3). {@link StewardLedgerStore.read} exposes only `entries` (its
 *  established, unchanged return shape); callers that want visibility into
 *  skipped lines or duplicate wakes use
 *  {@link StewardLedgerStore.readDiagnostics} instead. */
export interface ReadLedgerDiagnostics {
  readonly entries: StewardDecisionLedgerEntry[];
  readonly invalid: InvalidLedgerLine[];
  readonly duplicates: DuplicateWakeEntry[];
}

export class StewardLedgerStore {
  constructor(private readonly workspaceDir: string) {}

  async append(entry: StewardDecisionLedgerEntry): Promise<StewardDecisionLedgerEntry> {
    const parsed = parseStewardDecisionLedgerEntry(entry);
    await mkdir(dirname(this.path()), { recursive: true });
    // Issue #140: append through the SAME cross-process lock + atomic
    // (temp+fsync+rename) write the generated validator uses, so a concurrent
    // reader never sees a partial file and a concurrent writer can't be lost.
    await withLedgerWrite(this.workspaceDir, (raw) => {
      const prefix = raw.length === 0 || raw.endsWith('\n') ? raw : `${raw}\n`;
      return `${prefix}${JSON.stringify(parsed)}\n`;
    });
    return parsed;
  }

  /**
   * Read every parseable decision-ledger entry, filtered by `opts`. A single
   * malformed line (invalid JSON, or a required field missing) is skipped
   * rather than thrown — one bad line must never prevent every OTHER valid
   * line in the file from being read, since this is the same unfiltered
   * whole-file parse that `supervisor.tick()`'s deadline/liveness checks and
   * cost aggregation all transitively depend on for every wake in the
   * workspace, not just the one that wrote the bad entry. Use
   * {@link readDiagnostics} for visibility into which lines were skipped.
   */
  async read(opts: ReadLedgerOptions = {}): Promise<StewardDecisionLedgerEntry[]> {
    const { entries } = await this.readDiagnostics(opts);
    return entries;
  }

  /** Like {@link read}, but also reports the lines that failed to parse
   *  (`invalid`), unfiltered by `opts.wakeId`/`opts.limit` — those filters
   *  only make sense against successfully parsed entries. */
  async readDiagnostics(opts: ReadLedgerOptions = {}): Promise<ReadLedgerDiagnostics> {
    const { entries: allEntries, invalid, duplicates } = await this.readIndex();
    let entries = allEntries;
    if (opts.wakeId) entries = entries.filter((entry) => entry.wakeId === opts.wakeId);
    if (opts.limit !== undefined && opts.limit > 0) entries = entries.slice(-opts.limit);
    return { entries, invalid, duplicates };
  }

  /**
   * Parse the ledger ONCE and return everything a supervisor tick needs (issue
   * #134): valid `entries` (file order), `invalid` lines, `duplicates`, and the
   * `firstWins` index (wakeId → first-wins line + fingerprint). A single read
   * replaces the previous per-wake `findByWakeId` scans (no O(n²)).
   */
  async readIndex(): Promise<LedgerIndex> {
    let raw: string;
    try {
      raw = await readFile(this.path(), 'utf8');
    } catch (err) {
      if (isENOENT(err)) return { entries: [], invalid: [], duplicates: [], firstWins: new Map(), identityMismatches: [] };
      throw err;
    }
    return parseLedgerIndex(raw);
  }

  /**
   * The single terminal entry for `wakeId`, or null. Issue #125 D3: FIRST-wins
   * — the earliest entry in file order is authoritative and later duplicates
   * are ignored here (and surfaced via {@link readDiagnostics}), so a post-hoc
   * append can never alter the recorded decision.
   */
  async findByWakeId(wakeId: string): Promise<StewardDecisionLedgerEntry | null> {
    const matches = await this.read({ wakeId });
    return matches.at(0) ?? null;
  }

  path(): string {
    return stewardLedgerPath(this.workspaceDir);
  }
}

export function createStewardLedgerStore(workspaceDir: string): StewardLedgerStore {
  return new StewardLedgerStore(workspaceDir);
}

/** Single-pass parse of a raw ledger file's contents (issue #134): builds
 *  the schema-valid `entries` (file order), the `invalid` lines, the `duplicates`
 *  (D3, first-wins over valid entries), AND the `firstWins` index in one sweep.
 *
 *  Reads are LENIENT (issue #125): current v3 and historical v1/v2 entries parse.
 *  Line numbers are 1-based over NON-BLANK lines (kept identical to the previous
 *  parser and to the generated validator). `firstWins` keys on the FIRST
 *  JSON-parseable object line per wakeId even if it is schema-invalid, so the
 *  supervisor and the generated JS validator select the same first-wins line;
 *  its `valid`/`entry` say whether that line can also drive a status transition. */
function parseLedgerIndex(raw: string): LedgerIndex {
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const entries: StewardDecisionLedgerEntry[] = [];
  const invalid: InvalidLedgerLine[] = [];
  const duplicates: DuplicateWakeEntry[] = [];
  const firstWins = new Map<string, LedgerFirstWins>();
  const identityMismatches: LedgerIdentityMismatch[] = [];
  const firstLineForWake = new Map<string, number>();

  lines.forEach((line, index) => {
    const lineNo = index + 1;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch (err) {
      invalid.push({ line: lineNo, error: (err as Error).message });
      return;
    }

    // Issue #139: detect a top-level wakeId that disagrees with a `wake:`
    // evidence self-reference. Computed from the RAW parsed object (independent
    // of schema validity) so a misfiled entry that the #139 self-consistency
    // check rejects is still surfaced to the supervisor for actionable feedback.
    collectIdentityMismatch(obj, lineNo, identityMismatches);

    let entry: StewardDecisionLedgerEntry | null = null;
    let lenientError: string | null = null;
    try {
      entry = parseStewardDecisionLedgerEntryLenient(obj);
    } catch (err) {
      lenientError = (err as Error).message;
    }

    // First-wins index keys on the raw JSON object's wakeId (schema-independent
    // selection), so the TS supervisor and the JS validator agree on the line.
    const rawWakeId =
      obj && typeof obj === 'object' && typeof (obj as { wakeId?: unknown }).wakeId === 'string'
        ? (obj as { wakeId: string }).wakeId
        : undefined;
    if (rawWakeId !== undefined && !firstWins.has(rawWakeId)) {
      firstWins.set(rawWakeId, {
        line: lineNo,
        fingerprint: canonicalDecisionFingerprint(obj),
        valid: entry !== null,
        entry,
      });
    }

    if (entry) {
      const firstLine = firstLineForWake.get(entry.wakeId);
      if (firstLine === undefined) {
        firstLineForWake.set(entry.wakeId, lineNo);
      } else {
        duplicates.push({ wakeId: entry.wakeId, firstLine, duplicateLine: lineNo });
      }
      entries.push(entry);
    } else {
      invalid.push({ line: lineNo, error: lenientError ?? 'invalid ledger entry' });
    }
  });

  return { entries, invalid, duplicates, firstWins, identityMismatches };
}

/** Push a {@link LedgerIdentityMismatch} for every `wake:` evidence reference on
 *  a raw parsed ledger object that names an id other than its own top-level
 *  wakeId (issue #139). No-op on non-objects or entries without a string
 *  wakeId. */
function collectIdentityMismatch(
  obj: unknown,
  lineNo: number,
  out: LedgerIdentityMismatch[],
): void {
  if (!obj || typeof obj !== 'object') return;
  const entryWakeId = (obj as { wakeId?: unknown }).wakeId;
  if (typeof entryWakeId !== 'string') return;
  const completion = (obj as { completion?: unknown }).completion;
  const refs = completion && typeof completion === 'object'
    ? (completion as { evidenceRefs?: unknown }).evidenceRefs
    : undefined;
  if (!Array.isArray(refs)) return;
  const seen = new Set<string>();
  for (const ref of refs) {
    if (typeof ref !== 'string' || !ref.startsWith('wake:')) continue;
    const referencedWakeId = ref.slice('wake:'.length);
    if (!referencedWakeId || referencedWakeId === entryWakeId || seen.has(referencedWakeId)) continue;
    seen.add(referencedWakeId);
    out.push({ line: lineNo, entryWakeId, referencedWakeId });
  }
}

function isENOENT(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT';
}
