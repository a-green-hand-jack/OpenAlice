# D4 Smoke dev data package

`stage-manifest.json` is the canonical order and immutable identity for the
12-cell Smoke roster. Its checked-in SHA-256 is in `stage-manifest.sha256`.

- `candidate/` contains only rebased OHLCV, fictional bar indices, and the
  frozen decision boundaries. It contains no provider symbol or timestamp.
- `audit/` contains orchestrator-only source receipts, real chronology,
  point-in-time universe evidence, and one D3 evaluation data manifest per
  decision.
- `sampling-plan.json` freezes the selection and transform recipe.
- `quota/` binds the zero-cost G2 reachability calibration used for the
  conservative complete-layer forecast. Claude's earlier native `/usage`
  result is explicitly normalized into the later SDK usage-control shape.
- `critic-approval.json` is added only after an independent clean-room critic
  approves the exact committed manifest hash.

For lookback `L`, cadence `C`, and `D = 12` decisions, each source cell has
exactly `T = L + D * C` bars. Zero-based decision `d` sees only the half-open
prefix `[0, L + d * C)`. The final `C` bars are outcome-only and never appear
in a candidate-visible decision snapshot.

The full cell file is orchestrator input, not a file to mount in a candidate
sandbox or pass to a model. A runner must materialize the decision snapshot
named by the audit manifest and expose only its frozen prefix.

Raw provider data is not redistributed. Each audit file records its canonical
byte count and SHA-256. The public/no-cost recipe refetches, normalizes, and
fails closed on any byte, selection, or transform drift:

Yahoo chart `quote` OHLCV is explicitly treated as retrospectively
split-adjusted. Each audit freezes split events through the package cutoff,
rejects a selected window that straddles an effective split, and records a
per-decision proof that removing every not-yet-effective split factor leaves
the rebased candidate bytes unchanged. D3 manifests expose only actions known
by their conservative effective-time availability bound and mark them as not
applied to the split-invariant candidate snapshot.

```bash
pnpm exec tsx tools/campaigns/build-d4-smoke-data.mjs --verify
pnpm exec tsx tools/campaigns/build-d4-smoke-data.mjs --verify-source
pnpm exec tsx tools/campaigns/build-d4-smoke-data.mjs --verify-approved
```

The package is data-only. These commands do not invoke a model, account,
broker, or UTA.
