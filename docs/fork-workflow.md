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
# From the main checkout, do not switch the current branch:
git fetch origin upstream
git worktree add -b feat/issue-N-<slug> .worktrees/issue-N origin/jieke/dev

cd .worktrees/issue-N
pnpm install --filter='!@traderalice/desktop'     # ~748M per worktree

# Sandbox — NEVER run against the real ~/.openalice store:
export OPENALICE_HOME=$PWD/.sandbox-home          # data/ + sealing.key
export AQ_LAUNCHER_ROOT=$PWD/.sandbox-ws          # workspace launcher root
```

Do not branch from a stale or locally-ahead `jieke/dev` by accident.
If local `jieke/dev` has unpushed commits, either push/merge them first
or intentionally name the local commit SHA in the work order. Default
worktrees come from `origin/jieke/dev` so another local agent's checkout
state cannot leak into the new branch.

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

## Worktree bootstrap contract

Opening a worktree is not just `git worktree add`. Treat it as a small
environment build with tracked inputs and local-only outputs.

1. **Preflight** — before creating anything, run `git status -sb` and
   `git worktree list` in the main checkout. If a worktree or branch for
   the issue already exists, resume it instead of creating a duplicate.
   If the main checkout is dirty or locally ahead/behind, do not "fix"
   it as part of worktree setup unless the work order says so.
   Always create worktrees from the main checkout's repo root, never
   from inside another worktree.
2. **Tracked source only** — the new worktree starts from
   `origin/jieke/dev` plus the issue branch. Never copy uncommitted files
   from another checkout unless the work order explicitly says which
   files and why.
   One worktree belongs to one issue; after merge, do not recycle it for
   a new issue with a new branch.
3. **Node dependencies** — run the documented install command in the
   worktree. Use `pnpm install --filter='!@traderalice/desktop'` for
   normal agent work and full `pnpm install` only when the Electron
   package is in scope. Do not symlink or copy `node_modules` between
   worktrees; pnpm's store already deduplicates safely. Do not commit
   lockfile changes caused only by a routine install; lockfile changes
   belong to dependency-change PRs.
4. **Python / uv surfaces** — only create Python state when the touched
   subsystem actually needs it (`pyproject.toml`, `requirements*.txt`,
   notebooks, scripts, or benchmark tooling). Use `uv venv` /
   `uv run` / `uv pip sync` inside the worktree; never install project
   dependencies into system Python. If sandbox cache permissions get in
   the way, set `UV_CACHE_DIR=/tmp/uv-cache` for that command.
5. **OpenAlice state sandbox** — app runs, smoke tests, migrations, and
   live-ish drills must set `OPENALICE_HOME=$PWD/.sandbox-home` and
   `AQ_LAUNCHER_ROOT=$PWD/.sandbox-ws`. Never copy real
   `~/.openalice/data`, `sealing.key`, `provider-keys.json`, broker
   credentials, or account files into a worktree.
6. **Provider-key isolation** — `OPENALICE_HOME` does not move
   user-global provider keys. If a task touches credential injection,
   AI-provider settings, or provider-key loading, also set
   `OPENALICE_GLOBAL_DIR=$PWD/.sandbox-global` and use fake/test keys
   only.
7. **Port isolation** — if any dev stack may already be running, assign
   the worktree its own port profile before `pnpm dev` or browser tests.
   Record the chosen ports in the work order. Do not reuse another
   worktree's ports while its server may still be alive.
8. **Local datasets and caches** — any large local asset, dataset, model
   cache, or generated mirror lives outside git or under an ignored
   path. Restore it from a documented command, env var, or symlink rule.
   If a task discovers an undocumented asset requirement, add or update
   a checked-in setup note/script in the same PR instead of leaving it in
   agent memory.
9. **External repos / mirrors** — satellite checkouts, generated
   template mirrors, downloaded benchmarks, and other non-repo inputs
   must be pinned by URL plus commit/version in the work order or setup
   doc. Keep them under ignored paths and never vendor them into this
   repo unless the issue explicitly asks for that.
10. **Secrets and env files** — do not copy `.env`, real broker config,
    session cookies, admin tokens, or shell history from another
    checkout. If an env file is needed, create a worktree-local ignored
    file from a checked-in example and use placeholders.
11. **Generated artifacts** — build outputs, reports, screenshots,
    traces, coverage, logs, temporary downloads, and recorder output go
    under ignored paths. If a tool writes generated files into tracked
    locations, stop and either configure the output path or document why
    the generated file is intentionally part of the PR.
12. **Sub-agent handoff** — the implementation prompt must include the
    issue number, worktree path, branch name, base ref/SHA, sandbox env
    exports, port profile, restored local assets, intended write scope,
    and required verification commands. Do not make a sub-agent infer
    bootstrap state from the parent session's memory.
13. **Readiness check** — before handing the worktree to an
    implementation agent, record: `git status -sb`, the branch/base,
    dependency install command used, sandbox env paths, any dataset/cache
    links restored, and the first verification command the agent should
    run.

Generated state belongs in ignored paths such as `node_modules/`,
`.venv/`, `.uv-cache/`, `.sandbox-home/`, `.sandbox-ws/`,
`.sandbox-global/`, `reports/`, `tmp/`, or an explicit subsystem cache.
If `git status --short` shows generated files, fix the ignore/setup rule
before starting feature work.

Cleanup is part of the same contract. After the PR merges and the merge
commit is visible on the target branch, use `git worktree remove
.worktrees/issue-N` from the main checkout, then delete the stale local
and remote feature branch. Do not remove worktrees with `rm -rf`: it can
leave Git's worktree metadata and branch checkout locks behind. If
cleanup fails, run `git worktree list` and report the exact blocker
instead of half-cleaning.

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
