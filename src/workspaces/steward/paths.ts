import { join } from 'node:path';

export const STEWARD_ROOT_REL = '.alice/steward';
export const STEWARD_WAKES_REL = `${STEWARD_ROOT_REL}/wakes`;
export const STEWARD_LEDGER_REL = `${STEWARD_ROOT_REL}/ledger/decisions.jsonl`;

export function stewardRootPath(workspaceDir: string): string {
  return join(workspaceDir, '.alice', 'steward');
}

export function stewardWakesDir(workspaceDir: string): string {
  return join(stewardRootPath(workspaceDir), 'wakes');
}

export function stewardLedgerPath(workspaceDir: string): string {
  return join(stewardRootPath(workspaceDir), 'ledger', 'decisions.jsonl');
}

export function stewardWakeFilename(wakeId: string): string {
  return `${encodeURIComponent(wakeId)}.json`;
}

export function stewardWakePath(workspaceDir: string, wakeId: string): string {
  return join(stewardWakesDir(workspaceDir), stewardWakeFilename(wakeId));
}
