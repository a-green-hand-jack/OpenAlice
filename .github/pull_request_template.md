## Summary
<what changed and why - 1-4 bullets, written for a 30-second director-review>

## Test plan
- [ ] tsc --noEmit clean
- [ ] pnpm test passes
- [ ] (whatever manual verifications apply)

## Boundary touch
<flag if this PR touches trading / auth / broker credentials / migrations. Omit if none.>

## Anatomy impact
- [ ] No structural ownership / file move / state / lifecycle / routing change.
- [ ] Updated relevant ANATOMY.md files in this PR.
- [ ] Searched anatomy files for touched filenames and verified citations.
- [ ] Ran pnpm exec tsx tools/check-anatomy-drift.ts --check

## GitHub side effects
- [ ] No external side effects.
- [ ] Human explicitly approved: [specific action].

🤖 Generated with [Claude Code](https://claude.com/claude-code)
