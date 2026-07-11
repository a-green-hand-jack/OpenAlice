import { join } from 'node:path';

export const STEWARD_ROOT_REL = '.alice/steward';
export const STEWARD_WAKES_REL = `${STEWARD_ROOT_REL}/wakes`;
export const STEWARD_LEDGER_REL = `${STEWARD_ROOT_REL}/ledger/decisions.jsonl`;
export const STEWARD_SUPERVISOR_REL = `${STEWARD_ROOT_REL}/supervisor.jsonl`;
export const STEWARD_STATE_REL = `${STEWARD_ROOT_REL}/state.json`;
export const STEWARD_LOCKS_REL = `${STEWARD_ROOT_REL}/locks`;
/** Per-wake finalization markers (issue #136 finalize barrier). Gitignored,
 *  operational — like locks/state. Written atomically by the generated
 *  validate-ledger.mjs once a wake's ledger entry passes all checks. */
export const STEWARD_FINALIZE_REL = `${STEWARD_ROOT_REL}/finalize`;

export function stewardRootPath(workspaceDir: string): string {
  return join(workspaceDir, '.alice', 'steward');
}

export function stewardWakesDir(workspaceDir: string): string {
  return join(stewardRootPath(workspaceDir), 'wakes');
}

export function stewardLedgerPath(workspaceDir: string): string {
  return join(stewardRootPath(workspaceDir), 'ledger', 'decisions.jsonl');
}

export function stewardSupervisorLogPath(workspaceDir: string): string {
  return join(stewardRootPath(workspaceDir), 'supervisor.jsonl');
}

export function stewardStatePath(workspaceDir: string): string {
  return join(stewardRootPath(workspaceDir), 'state.json');
}

export function stewardLocksDir(workspaceDir: string): string {
  return join(stewardRootPath(workspaceDir), 'locks');
}

export function stewardLockFilename(accountId: string): string {
  return `${encodeURIComponent(accountId)}.json`;
}

export function stewardLockPath(workspaceDir: string, accountId: string): string {
  return join(stewardLocksDir(workspaceDir), stewardLockFilename(accountId));
}

export function stewardWakeFilename(wakeId: string): string {
  return `${encodeURIComponent(wakeId)}.json`;
}

export function stewardWakePath(workspaceDir: string, wakeId: string): string {
  return join(stewardWakesDir(workspaceDir), stewardWakeFilename(wakeId));
}

export function stewardFinalizeDir(workspaceDir: string): string {
  return join(stewardRootPath(workspaceDir), 'finalize');
}

/** Per-wake finalization-marker filename. Reuses the same URL-encoding as
 *  wake/lock filenames so an arbitrary wakeId is path-safe (issue #136). */
export function stewardFinalizeFilename(wakeId: string): string {
  return `${encodeURIComponent(wakeId)}.json`;
}

export function stewardFinalizePath(workspaceDir: string, wakeId: string): string {
  return join(stewardFinalizeDir(workspaceDir), stewardFinalizeFilename(wakeId));
}
