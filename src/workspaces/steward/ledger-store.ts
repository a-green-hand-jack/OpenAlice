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

export class StewardLedgerStore {
  constructor(private readonly workspaceDir: string) {}

  async append(entry: StewardDecisionLedgerEntry): Promise<StewardDecisionLedgerEntry> {
    const parsed = parseStewardDecisionLedgerEntry(entry);
    const path = this.path();
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(parsed)}\n`, 'utf8');
    return parsed;
  }

  async read(opts: ReadLedgerOptions = {}): Promise<StewardDecisionLedgerEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this.path(), 'utf8');
    } catch (err) {
      if (isENOENT(err)) return [];
      throw err;
    }

    let entries = raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line, index) => parseLedgerLine(line, index + 1));
    if (opts.wakeId) entries = entries.filter((entry) => entry.wakeId === opts.wakeId);
    if (opts.limit !== undefined && opts.limit > 0) entries = entries.slice(-opts.limit);
    return entries;
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

function parseLedgerLine(line: string, lineNumber: number): StewardDecisionLedgerEntry {
  try {
    return parseStewardDecisionLedgerEntry(JSON.parse(line));
  } catch (err) {
    throw new Error(`invalid steward decision ledger line ${lineNumber}: ${(err as Error).message}`);
  }
}

function isENOENT(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT';
}
