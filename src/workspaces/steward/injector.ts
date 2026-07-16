import type { SessionPool } from '../session-pool.js';
import type { StewardWakeRecord } from './types.js';
import { STEWARD_DRAFTS_REL, STEWARD_LEDGER_REL, STEWARD_WAKES_REL, stewardWakeFilename } from './paths.js';

export function formatStewardWakeMessage(
  record: StewardWakeRecord,
  options: { readonly validatorPath?: string } = {},
): string {
  const wakePath = `${STEWARD_WAKES_REL}/${stewardWakeFilename(record.wakeId)}`;
  const validatorPath = options.validatorPath ?? '.alice/steward/validate-ledger.mjs';
  return [
    `<STEWARD_WAKE id="${escapeAttr(record.wakeId)}" deadline="${escapeAttr(record.deadline)}">`,
    `Read ${wakePath} and the immutable Snapshot M1 file named by envelope.snapshotRef.path. This wake uses Decision Ledger v3; it supersedes any older v2/propose_trade ledger text retained in a persistent session.`,
    'Run the fixed UTA checklist: account, positions, orders, risk, market, and history.',
    `Write one decision JSON object to ${STEWARD_DRAFTS_REL}/${stewardWakeFilename(record.wakeId)} with your Write/Edit tool (NEVER edit ${STEWARD_LEDGER_REL}), then run: node ${validatorPath} ${record.wakeId}`,
    'Write version 3 with decision no_trade | propose_change | reduce_risk | blocked, intent (required for change/risk, null otherwise), and thesisDispositions addressed by wakeId+instrument. When intent is non-null, copy the bound snapshot id/hash into it. Whether and how to act on the intent — and what belongs in actions/pendingHash — is defined by your workspace instruction.',
    'The decision must include top-level wakeId (this wake), completion.reason, exactly one wake:<this wakeId> self-reference, checklist, and cost. Validation commits it and is the only supported ledger writer.',
    'Do not inspect OpenAlice source. Do not call push.',
    '</STEWARD_WAKE>',
    '',
  ].join('\n');
}

/**
 * Paste/submit gap between the message-body write and the follow-up Enter.
 *
 * This is NOT just an Ink paste-debounce tuning knob — for a freshly
 * spawned session (the common case: `ensureStewardSession` spawns, then
 * immediately injects) the two writes race the CLI's own startup. If the
 * body lands before the child has switched its tty into raw mode and
 * started actually reading stdin, the OS pty layer has nowhere to deliver
 * it yet; when the follow-up `\r` is written too soon after, both chunks
 * get coalesced into the SAME read() once the app finally starts polling,
 * and a multi-character read (body + `\r` together) is indistinguishable
 * from a paste — the trailing `\r` is swallowed into it instead of being
 * recognized as a standalone Enter keystroke. Only once the two writes
 * land as genuinely separate reads does the lone `\r` register as Enter.
 *
 * Empirically measured against a live `claude` (Claude Code) session,
 * repeated fresh-spawn trials writing the real multi-line wake body then
 * a bare `\r` after N ms (see issue #91 investigation): 300ms and 1200ms
 * reliably failed (message left sitting unsubmitted in the composer,
 * confirmed via attached-terminal capture AND an empty
 * `~/.claude/projects/.../*.jsonl` transcript — no turn ever started);
 * 1500ms was flaky (1 pass / 1 fail across trials); 2000ms, 2500ms, and
 * 3000ms passed consistently. 3000ms is chosen for margin over the
 * observed ~2000ms threshold — this sandboxed test host runs the CLI
 * alongside several other concurrent dev processes, so a production
 * machine's startup-to-raw-mode time should usually be faster, not
 * slower. The 25ms Codex gap from the superseded PR #72 is unrelated to
 * this race (that route wrote AFTER an already-running Codex session).
 */
export const STEWARD_WAKE_SUBMIT_DELAY_MS = 3000;

export async function injectStewardWake(input: {
  readonly pool: SessionPool;
  readonly sessionId: string;
  readonly record: StewardWakeRecord;
}): Promise<boolean> {
  const wroteBody = input.pool.writeToSession(
    input.sessionId,
    formatStewardWakeMessage(input.record),
    { source: 'steward-supervisor' },
  );
  if (!wroteBody) return false;

  await new Promise((resolve) => setTimeout(resolve, STEWARD_WAKE_SUBMIT_DELAY_MS));

  return input.pool.writeToSession(input.sessionId, '\r', { source: 'steward-supervisor' });
}

function escapeAttr(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
