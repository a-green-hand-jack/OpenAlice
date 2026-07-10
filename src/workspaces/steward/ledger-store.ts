import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { canonicalDecisionFingerprint } from './ledger-receipt.js';
import {
  parseStewardDecisionLedgerEntry,
  parseStewardDecisionLedgerEntryLenient,
  type StewardDecisionLedgerEntry,
} from './types.js';
import { stewardLedgerPath } from './paths.js';

/** The first-wins ledger entry for a wakeId together with the canonical
 *  fingerprint (issue #134) of that exact entry. The fingerprint is derived
 *  from the SAME parsed line the entry came from, so the receipt the supervisor
 *  records and the entry it reconciles can never come from different lines. */
export interface FirstWinsEntry {
  readonly entry: StewardDecisionLedgerEntry;
  readonly fingerprint: string;
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
 *  (tamper-evident — a later append can never alter the recorded decision) and
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
    const path = this.path();
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(parsed)}\n`, 'utf8');
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
    let raw: string;
    try {
      raw = await readFile(this.path(), 'utf8');
    } catch (err) {
      if (isENOENT(err)) return { entries: [], invalid: [], duplicates: [] };
      throw err;
    }

    const { entries: allEntries, invalid, duplicates } = parseLedgerLines(raw);
    let entries = allEntries;
    if (opts.wakeId) entries = entries.filter((entry) => entry.wakeId === opts.wakeId);
    if (opts.limit !== undefined && opts.limit > 0) entries = entries.slice(-opts.limit);
    return { entries, invalid, duplicates };
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

  /**
   * The first-wins entry for `wakeId` AND its canonical fingerprint (issue
   * #134), or null when no parseable entry exists. Selects the SAME line
   * {@link findByWakeId} would (the earliest line that is valid JSON and parses
   * leniently), then fingerprints that line's parsed value, so the recorded
   * receipt and the reconciled entry are always the same line. Used by the
   * supervisor to capture a receipt on the first terminal transition and to
   * detect a later disappearance/mutation of that entry.
   */
  async firstWinsWithFingerprint(wakeId: string): Promise<FirstWinsEntry | null> {
    let raw: string;
    try {
      raw = await readFile(this.path(), 'utf8');
    } catch (err) {
      if (isENOENT(err)) return null;
      throw err;
    }
    const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
    for (const line of lines) {
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (!obj || typeof obj !== 'object' || (obj as { wakeId?: unknown }).wakeId !== wakeId) continue;
      let entry: StewardDecisionLedgerEntry;
      try {
        entry = parseStewardDecisionLedgerEntryLenient(obj);
      } catch {
        continue;
      }
      return { entry, fingerprint: canonicalDecisionFingerprint(obj) };
    }
    return null;
  }

  path(): string {
    return stewardLedgerPath(this.workspaceDir);
  }
}

export function createStewardLedgerStore(workspaceDir: string): StewardLedgerStore {
  return new StewardLedgerStore(workspaceDir);
}

/** Pure line-by-line parse of a raw ledger file's contents: every line that
 *  parses lands in `entries` (in file order); every line that doesn't lands
 *  in `invalid` with its 1-based line number and the parse error, and is
 *  skipped rather than aborting the rest of the file. Reads are LENIENT (issue
 *  #125): a strict-v2 entry OR a legacy-v1 entry both parse. Every wakeId seen
 *  more than once is recorded in `duplicates` (D3, first-wins). */
function parseLedgerLines(raw: string): ReadLedgerDiagnostics {
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const entries: StewardDecisionLedgerEntry[] = [];
  const invalid: InvalidLedgerLine[] = [];
  const duplicates: DuplicateWakeEntry[] = [];
  const firstLineForWake = new Map<string, number>();
  lines.forEach((line, index) => {
    try {
      const entry = parseStewardDecisionLedgerEntryLenient(JSON.parse(line));
      const lineNo = index + 1;
      const firstLine = firstLineForWake.get(entry.wakeId);
      if (firstLine === undefined) {
        firstLineForWake.set(entry.wakeId, lineNo);
      } else {
        duplicates.push({ wakeId: entry.wakeId, firstLine, duplicateLine: lineNo });
      }
      entries.push(entry);
    } catch (err) {
      invalid.push({ line: index + 1, error: (err as Error).message });
    }
  });
  return { entries, invalid, duplicates };
}

function isENOENT(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT';
}
