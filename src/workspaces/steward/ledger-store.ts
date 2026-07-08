import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  parseStewardDecisionLedgerEntry,
  type StewardDecisionLedgerEntry,
} from './types.js';
import { stewardLedgerPath } from './paths.js';

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

/** The full result of parsing a ledger file: every line that parsed, plus
 *  every line that didn't (with why). {@link StewardLedgerStore.read} exposes
 *  only `entries` (its established, unchanged return shape); callers that
 *  want visibility into skipped lines use
 *  {@link StewardLedgerStore.readDiagnostics} instead. */
export interface ReadLedgerDiagnostics {
  readonly entries: StewardDecisionLedgerEntry[];
  readonly invalid: InvalidLedgerLine[];
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
      if (isENOENT(err)) return { entries: [], invalid: [] };
      throw err;
    }

    const { entries: allEntries, invalid } = parseLedgerLines(raw);
    let entries = allEntries;
    if (opts.wakeId) entries = entries.filter((entry) => entry.wakeId === opts.wakeId);
    if (opts.limit !== undefined && opts.limit > 0) entries = entries.slice(-opts.limit);
    return { entries, invalid };
  }

  async findByWakeId(wakeId: string): Promise<StewardDecisionLedgerEntry | null> {
    const matches = await this.read({ wakeId });
    return matches.at(-1) ?? null;
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
 *  skipped rather than aborting the rest of the file. */
function parseLedgerLines(raw: string): ReadLedgerDiagnostics {
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const entries: StewardDecisionLedgerEntry[] = [];
  const invalid: InvalidLedgerLine[] = [];
  lines.forEach((line, index) => {
    try {
      entries.push(parseStewardDecisionLedgerEntry(JSON.parse(line)));
    } catch (err) {
      invalid.push({ line: index + 1, error: (err as Error).message });
    }
  });
  return { entries, invalid };
}

function isENOENT(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT';
}
