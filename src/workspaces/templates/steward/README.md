---
version: 0.1.0
---

# Steward

A production-like trading steward workspace. It is meant to host one long-lived
agent session, usually Codex, that keeps context across market/event wakes and
uses OpenAlice's UTA guardrails to make real paper-trading decisions.

## What This Workspace Does

The steward does not run as a one-shot `codex exec` task per trade point. A
market/event selector writes a durable event under `.alice/steward/events/`,
then wakes the same live PTY session. The session reads the event, observes the
account and market through the `alice*` / `traderhub` CLIs, decides whether to
act, and records the result in git.

Trading actions go through `alice-uta`. Paper orders may auto-push only after
UTA policy and guards allow them; live orders stay behind human approval. The
agent must not bypass UTA or use broker-native shortcuts.

## Expected Event Shape

Selectors can write JSON or Markdown. JSON should prefer this loose shape:

```json
{
  "id": "2026-07-07T14-30-00Z-nvda-bar-close",
  "kind": "bar_close",
  "accountId": "mock-paper",
  "symbols": ["NVDA"],
  "summary": "Daily bar closed above the 20-day range.",
  "constraints": { "blind": false, "maxNewExposurePct": 20 }
}
```

The wake message may include the path, but the durable file is the source of
truth. If a wake arrives without a path, inspect `.alice/steward/events/` for
unhandled recent events before deciding that there is nothing to do.

## When To Spawn This

- You want a persistent paper-trading steward, not an ad hoc research chat.
- You want to test production behavior: real account state, real UTA policy,
  real guard results, and a durable audit trail.
- You are ready for the selector/watchdog model: external code decides when to
  wake the session; the session decides what, if anything, to trade.

## What You'll See In Inbox

The steward pushes material decisions, blocked decisions, and notable guard or
policy denials. Routine no-trade wakes can remain in `journal/` unless the
event itself is important.

## Parameters

- **Tag** - short identifier for this steward.

All available CLI runtimes are enabled. The new-session button defaults to
Codex so the first live session can become the persistent steward.
