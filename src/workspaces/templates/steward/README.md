---
version: 0.1.0
---

# Steward

A persistent trading steward workspace. It is built for one long-lived agent
session that receives structured wake envelopes, checks UTA state, and writes a
decision ledger entry for each wake.

## What this workspace does

This template lays out the first source-controlled steward surface:

- `.alice/steward/README.md` is the workspace-local operating manual and
  wrapper prompt anchor.
- `.alice/steward/config.json` pins the steward defaults, including Codex as
  the first core agent and the initial monthly budget assumptions.
- `.alice/steward/context-manifest.json` is generated during workspace context
  injection and records the hashes of the wrapper prompt, root instructions, and
  injected skills.
- `.alice/steward/wakes/` receives wake envelopes from the launcher.
- `.alice/steward/ledger/decisions.jsonl` is the per-wake completion boundary.

The steward is not a general coding workspace. For trading wakes, its world is
the structured workspace context plus the `alice*` and `traderhub` CLIs on PATH.
OpenAlice source code is not part of the trading context.

## When to spawn this

- You want to test the persistent steward behavior contract before adding wake
  injection and supervisor code.
- You want a workspace that makes trading-agent inputs versioned and reviewable
  from the first commit.
- You want Codex to behave as a trading steward rather than a fresh coding
  agent over the OpenAlice repository.

## What you'll see in Inbox

Later implementation PRs will use Inbox for supervisor warnings, blocked wakes,
and human-readable summaries. PR A only creates the workspace shape and
versioned context manifest; it does not inject wakes or run the supervisor.

## Parameters

- **Tag** - short identifier for this steward workspace.

Codex is the template's default core agent. The launcher may still enable other
installed CLI runtimes for operator convenience, but the steward config starts
with `agent: "codex"`.
