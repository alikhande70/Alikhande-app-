# ADR-0021 evaluation cutoff guard — build report addendum

Date: 2026-08-28
Branch: `gpt/trading-brain-build`

## Change

Self-audit found a point-in-time leakage gap in `evaluateScanPopulation()`: future outcome evidence was already filtered by `evaluationCutoff`, but a scan whose own `knowledgeTime` was later than that cutoff could still enter a historical report.

The evaluator now fails closed when any Mission/scan has `knowledgeTime > evaluationCutoff`. This prevents a historical evaluation from silently incorporating decisions that did not yet exist at the report cutoff.

A regression test covers the post-cutoff scan case. Existing separation remains unchanged: decision quality is distinct from future outcome, rejected/insufficient-data scans remain population evidence, realised trade R remains separate from market counterfactual R, and no winner or promotion side effect is introduced.

## Verification

Implementation/test head before this documentation commit: `5d2acf576f24ba082037aeea232ba21fc7cb9f1f`.

GitHub Actions workflow `verify` run 645 completed successfully on that exact implementation/test head, covering repository lint, TypeScript checks and tests.

## Verification ladder impact

- ADR-0021 point-in-time leakage protection: **strengthened** — both scan knowledge-time and outcome recorded-time are bounded by the historical evaluation cutoff.
- Champion/challenger promotion: **unchanged** — explicit operator action remains required; no automatic promotion exists.
- MT5/Windows/LiteFinance Demo proof: **unchanged / external**.
- Real-money execution: **not enabled or claimed**.

## Remaining ADR-0021 work

1. Wire whole durable Desk/Mission populations and same-Mission paired evidence into the evaluator without creating parallel truth.
2. Define versioned future-outcome labels directly from market data with explicit horizon/instrument semantics.
3. Add pre-registered paired statistical inference and uncertainty appropriate to the chosen outcome metric.
4. Red-team the full Mission → outcome → evaluation persistence path for temporal leakage and duplicate/replay inflation.
