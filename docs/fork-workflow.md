# Fork Workflow — a-green-hand-jack/OpenAlice

> Status: standing process doc for the maintained fork. Approved by the
> maintainer 2026-07-04 (supersedes the upstream "prefer cloud sessions
> over local worktrees" guidance — in fork mode, worktrees are the
> standard vehicle for non-trivial changes).
> Companion docs: `docs/steward-plan.zh.md` (what to build, in order),
> `docs/terminal-runbook.md` (how to drive and verify the app from the
> terminal — lands via issue #5).

## Branch model

- **Maintainer identity** — `jieke` is the maintainer operating the
  `a-green-hand-jack/OpenAlice` fork. In local git, `origin` is that
  fork and `upstream` is `TraderAlice/OpenAlice`.
- **`jieke/dev`** — the primary development integration branch. It was
  originally cut from `upstream/master`, and new feature/fix PRs target
  this branch first. CI (`.github/workflows/ci.yml`: build-and-test +
  dev-smoke matrix) runs on every PR.
- **`master` (fork)** — the stabilized fork line. It is kept in sync
  with `upstream/master` and periodically receives mature batches from
  `jieke/dev`; it is not the default target for feature/fix PRs.
- **`feat/issue-N-<slug>`** — one branch per GitHub issue, developed in
  an isolated worktree under `.worktrees/issue-N/`.
- **Upstream sync** — a dedicated sync path updates fork `master` from
  `upstream/master`, then brings `origin/master` back into `jieke/dev`.
  Never mix upstream sync with feature work.
- **Stabilization merge** — when a coherent feature group or plan stage
  is complete, merge `jieke/dev` into fork `master` through an explicit
  stabilization PR or maintainer-approved merge.

Branch safety rules from CLAUDE.md still apply: never commit directly
to `master` or `jieke/dev`, merge with `--merge` (never `--squash` by
default), and never force-push long-lived branches. After merge, clean
up obsolete feature branches and their worktrees deliberately; never
delete `master`, `jieke/dev`, `dev`, `local`, or archived branches.

## The per-issue pipeline

Every change — code or docs — moves through the same stations:

1. **Issue** — filed on the fork with What / Why / Acceptance sections.
   Acceptance criteria are checkable, not aspirational.
2. **Branch / worktree** — create `feat/issue-N-<slug>` from current
   `jieke/dev` in an isolated `.worktrees/issue-N/` checkout.
3. **Work order** — the orchestrator session translates the issue into
   a concrete brief (files, anchors, constraints, verification steps),
   citing ANATOMY.md maps and `docs/steward-plan.zh.md` invariants
   where they apply.
4. **Implement** — a sub-agent (codex or another implementation agent)
   works inside the issue's worktree. Self-verification is part of implementation:
   `npx tsc --noEmit`, `pnpm test`, plus the scoped checks the diff
   demands (see Verification matrix below).
5. **PR to `jieke/dev`** — PR body: Summary / Test plan / Boundary
   touch (+ `Closes #N`). Do not point new feature/fix PRs directly at
   `master`.
6. **Review / audit** — a different sub-agent or the main agent reads
   the full diff, spot-checks real behavior through the terminal
   runbook when relevant, and reviews against the issue intent,
   steward-plan invariants (I1–I9), and ANATOMY citation sync.
   Findings are fixed before merge.
7. **Merge and cleanup** — merge only with CI green and review clean.
   Then sync the relevant checkout, remove `.worktrees/issue-N`, and
   delete stale local/remote feature branches once their PR merge commit
   preserves the history.

## Worktree recipe

```bash
# From the main checkout, always branch off fresh jieke/dev:
git fetch origin upstream
git checkout jieke/dev
git pull origin jieke/dev
git worktree add -b feat/issue-N-<slug> .worktrees/issue-N jieke/dev

cd .worktrees/issue-N
pnpm install --filter='!@traderalice/desktop'     # ~748M per worktree

# Sandbox — NEVER run against the real ~/.openalice store:
export OPENALICE_HOME=$PWD/.sandbox-home          # data/ + sealing.key
export AQ_LAUNCHER_ROOT=$PWD/.sandbox-ws          # workspace launcher root
```

Why the sandbox is non-negotiable: `data/` is one global store shared
by every checkout, and **migrations run against whatever store the
process sees** — an experimental branch without `OPENALICE_HOME` pinned
can mutate real user data.

Running a second dev stack in parallel needs port remaps (guardian env
precedence lives in `scripts/guardian/shared.ts`):

```bash
OPENALICE_WEB_PORT=48331 OPENALICE_MCP_PORT=48332 \
OPENALICE_UTA_PORT=48333 OPENALICE_UI_PORT=6173 \
pnpm dev
```

## Sync and conflict policy

Keep the three long-lived refs distinct:

- **`upstream/master` → `origin/master`**: dedicated upstream-sync work
  only. Prefer merge commits or PRs so fork history remains inspectable;
  never reset or force-push `origin/master` to look like upstream.
- **`origin/master` → `jieke/dev`**: after fork `master` absorbs
  upstream, merge that updated `master` into `jieke/dev` so feature
  branches are built against current upstream plus fork-stable work.
- **`jieke/dev` → `origin/master`**: only after a coherent feature group
  or plan stage is reviewed, tested, and ready to become the fork's
  stable line.

Conflict rule: upstream-sync conflicts are resolved separately from
feature diffs. Fork-local doctrine files (`AGENTS.md`, `CLAUDE.md`,
this file, and other fork workflow docs) default to the fork's policy.
Conflicts in trading, UTA, auth, config, migrations, credentials, or
workflow automation are high-risk: stop, summarize the competing changes,
and get maintainer direction before inventing a resolution.

## Milestone tags

Use git tags as durable stage markers. Tag after a coherent feature set
lands or a plan stage is complete, preferably on the `master` merge
commit that made it stable. If the milestone is intentionally dev-only,
tag the `jieke/dev` merge commit with a clearly dev-scoped name.

Tags should be annotated and say what landed, which issues/PRs are
covered, and what verification was run. Do not move or replace an
existing tag without explicit maintainer approval.

## Verification matrix

| Diff touches | Required before PR |
|---|---|
| anything | `npx tsc --noEmit` + `pnpm test` |
| `ui/` | `cd ui && npx tsc -b`; walk affected surface in `pnpm -F open-alice-ui dev:demo`, watch for `[demo] unmocked` warnings |
| `packages/<pkg>` | `pnpm -F @traderalice/<pkg> typecheck` |
| guardian / startup / ports / UTA restart | `pnpm test:smoke` |
| trading paths | relevant S1–S12 scenarios via `alice-uta` CLI on mock/paper accounts (`docs/uta-live-testing.md`); one regression spec per fixed bug |

Never gate on `services/uta` standalone typecheck (known broken,
ANG-65). Never wire `pnpm test:e2e` / live scenarios into automated
gates — they read real credentials from the global store and hit live
venues.

## Agent task discipline

- No long-running foreground servers (vite, `pnpm dev`) inside
  automated tasks — they hang the task. Use `pnpm test:smoke`, or
  background-start + curl probe + kill.
- Implementation tasks state their write scope up front; anything out
  of scope found along the way becomes a new issue, not a bigger diff.
- Temporary output goes to ignored paths (`reports/`, `tmp/`,
  `.worktrees/`), never the repo root.

## Anti-drift (ANATOMY) hooks

Phase A scaffolding lands via issue #4 (root + `src/` ANATOMY.md, drift
checker, CI gate, PR template). From then on the **same-commit rule**
applies: a PR that moves/renames/splits/deletes cited code, changes
module ownership, alters cross-module calls, or adds persistent state
must update the citing ANATOMY.md files in the same PR. Per-directory
maps are added lazily — whichever directory a PR touches gets its
ANATOMY.md written or refreshed in that PR (Phase B).
