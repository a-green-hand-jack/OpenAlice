import type { SessionPool } from '../session-pool.js';
import type { StewardWakeRecord } from './types.js';
import { STEWARD_LEDGER_REL, STEWARD_WAKES_REL, stewardWakeFilename } from './paths.js';

export function formatStewardWakeMessage(record: StewardWakeRecord): string {
  const wakePath = `${STEWARD_WAKES_REL}/${stewardWakeFilename(record.wakeId)}`;
  return [
    `<STEWARD_WAKE id="${escapeAttr(record.wakeId)}" deadline="${escapeAttr(record.deadline)}">`,
    `Read ${wakePath}.`,
    'Run the fixed UTA checklist: account, positions, orders, risk, market, and history.',
    `Append exactly one JSON object to ${STEWARD_LEDGER_REL}.`,
    'The ledger entry must include decision, completion.reason, evidenceRefs, checklist, and cost fields.',
    'Do not inspect OpenAlice source. Do not call push.',
    '</STEWARD_WAKE>',
    '',
  ].join('\n');
}

export function injectStewardWake(input: {
  readonly pool: SessionPool;
  readonly sessionId: string;
  readonly record: StewardWakeRecord;
}): boolean {
  return input.pool.writeToSession(
    input.sessionId,
    formatStewardWakeMessage(input.record),
    { source: 'steward-supervisor' },
  );
}

function escapeAttr(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
