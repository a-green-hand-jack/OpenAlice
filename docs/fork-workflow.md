# Fork Workflow — a-green-hand-jack/OpenAlice

> Status: standing process doc for the maintained fork. Approved by the
> maintainer 2026-07-04 (supersedes the upstream "prefer cloud sessions
> over local worktrees" guidance — in fork mode, worktrees are the
> standard vehicle for non-trivial changes).
> Companion docs: `docs/steward-plan.zh.md` (what to build, in order),
> `docs/terminal-runbook.md` (how to drive and verify the app from the
> terminal — lands via issue #5).

## Branch model

- **`master` (fork)** — the integration base. Every PR targets it. CI
  (`.github/workflows/ci.yml`: build-and-test + dev-smoke matrix) runs
  on every PR.
- **`feat/issue-N-<slug>`** — one branch per GitHub issue, developed in
  an isolated worktree under `.worktrees/issue-N/`.
- **`jieke/dev`** — the maintainer's manual scratch branch. Not part of
  the pipeline; never a PR base.
- **Upstream sync** — a dedicated PR that merges `upstream/master` into
  fork `master`. Never mixed with feature work. Conflicts with
  fork-local doctrine sections (CLAUDE.md / AGENTS.md fork-mode
  section, this file) are resolved in favor of the fork.

Branch safety rules from CLAUDE.md still apply: never commit directly
to master, merge with `--merge` (never `--squash` by default), never
`--delete-branch`, sync the source branch after merge.

## The per-issue pipeline

Every change — code or docs — moves through the same stations:

1. **Issue** — filed on the fork with What / Why / Acceptance sections.
   Acceptance criteria are checkable, not aspirational.
2. **Work order** — the orchestrator session translates the issue into
   a concrete brief (files, anchors, constraints, verification steps),
   citing ANATOMY.md maps and `docs/steward-plan.zh.md` invariants
   where they apply.
3. **Implement** — codex (or another implementation agent) works inside
   the issue's worktree. Self-verification is part of implementation:
   `npx tsc --noEmit`, `pnpm test`, plus the scoped checks the diff
   demands (see Verification matrix below).
4. **Review** — the orchestrator reads the full diff and spot-checks
   real behavior through the terminal runbook (curl / MCP / alice-uta),
   not just test output.
5. **Audit** — an independent sub-agent (cheap model is fine) reviews
   the diff against the issue intent, the steward-plan global
   invariants (I1–I9), and ANATOMY citation sync. Findings are fixed
   before the PR advances. The implementer and the auditor are never
   the same agent.
6. **PR → CI → merge** — PR body: Summary / Test plan / Boundary touch
   (+ `Closes #N`). Merge only with CI green and audit clean.
7. **Post-merge** — main checkout: `git checkout master && git pull`,
   run `pnpm test:smoke` (isolated home), then
   `git worktree remove .worktrees/issue-N`. The branch stays.

## Worktree recipe

```bash
# From the main checkout, always branch off fresh master:
git fetch origin && git checkout master && git pull origin master
git worktree add -b feat/issue-N-<slug> .worktrees/issue-N master

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
