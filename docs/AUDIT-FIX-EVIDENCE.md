# Evidence for the six audited defects — and what the fixes do not prove

Commit `5906234` said "Fix six audited defects". That claim was stronger than the
evidence behind it. All six changes are real and all thirteen tests pass, but
"fixed" was doing work that only two of the six can support: **two of the six sit
on code paths the current EA cannot reach, two are unit-verified on a branch the
lab has never taken on real data, and only two are both active and directly
exercised.** This file is the correction. It is written per defect, with the real
path, whether anything reaches it today, the test that reproduces it, and what
kind of verification that test actually is.

`docs/AUDIT.md` is deliberately not updated — it is a point-in-time snapshot.
This file corrects the *claim made about the fixes*, not the audit.

## Method

The tests in `tests/test_audit_fixes.py` were run against the pre-fix source in a
detached worktree at `94e3a3f`, then against the current head:

| Source | Command | Result |
|---|---|---|
| `94e3a3f` (pre-fix) | `pytest tests/test_audit_fixes.py -q` | **9 failed, 4 passed** |
| `6bb96e7` (current) | `pytest tests/test_audit_fixes.py -q` | **13 passed** |
| `6bb96e7` (current) | `pytest tests/ -q` | **166 passed** |

Nine tests failing on the old source is what makes them regression tests rather
than assertions written to match code that already existed. The four that passed
at `94e3a3f` cover behaviour that was already correct and is now pinned.

## Two kinds of test, and the difference matters

- **Behavioural** — the test calls the function and asserts on what it returns.
  A wrong implementation fails it. All the Python-side tests are behavioural.
- **Source-text** — the test reads a `.mqh` file and asserts that certain
  identifiers appear in it. It catches the fix being deleted. It does **not**
  catch the fix being wrong. Both MQL5 tests (D1, D2) are of this kind, because
  MQL5 cannot be compiled or executed in this environment.

Calling a source-text assertion a "reproducing test" without that qualifier is
the overstatement this file exists to correct.

## D1 — risk after a stop change

- **Path:** `MQL5/Include/Alikhande/OrderExecutor.mqh` — `ModifyStops()` (~L750),
  with `SetMaxRiskPercent()`, `RiskAtStop()`, `RiskPctAtStop()`, `m_risk_warn`;
  wired in `MQL5/Experts/Alikhande/AlikhandeEA.mq5` via `SetMaxRiskPercent(InpRiskPercent)`.
- **Reachable today: NO.** `grep -rn ModifyStops MQL5/` returns the definition and
  its own log strings — **no caller anywhere in the repository.**
  `ManageOpenPositions()` (`AlikhandeEA.mq5:317`) checks for an unprotected
  position and then stops; its own comment records that the trailing/break-even
  hook does nothing. `ISignal::ManageOpen` is declared (`ISignal.mqh:97`) and
  never called.
- **Test:** `test_d1_moving_a_stop_re_derives_the_risk_it_implies` — **source-text**.
- **Unproven:** never compiled; the risk arithmetic has never executed; no caller
  exercises it. This is a guard placed ahead of a feature that does not exist yet.

## D2 — a pending order reported as a fill

- **Path:** `OrderExecutor.mqh` — `RC_PENDING_PLACED` (enum L33, classified L180,
  handled L453), `OrderResult.pending`, and `CountOwnedPending()` /
  `CountOwnedExposure()` / `CancelAllOwnedPending()` reading `OrdersTotal()`.
- **Reachable today: NO.** The only submissions are `m_trade.Buy` / `m_trade.Sell`
  (`OrderExecutor.mqh:446-447`) — market orders. The handler's own comment says
  the market path in this EA cannot currently produce retcode 10008. It fires only
  if a pending-order strategy is added, or if the broker converts the request.
- **Test:** `test_d2_pending_orders_are_not_reported_as_filled_positions` —
  **source-text**. There is also an in-terminal assertion,
  `MQL5/Scripts/Alikhande/RunTests.mq5:419`, which checks the classification
  properly — but that suite **has never been compiled or run.**
- **Unproven:** never compiled; 10008 has never been produced; the `OrdersTotal()`
  ownership loop has never executed.

## D3 — the lab could not record a success

- **Path:** `research/alkresearch/screen.py` — `build_null_hypothesis()`, and
  `screen()` now calling `run.status_for_record()` and passing `null_hypothesis`
  and `h0_ruled_out_by`.
- **Reachable today: PARTIALLY.** `screen()` runs on every screening pass, but the
  branch that records a surviving candidate has never been taken. All nine ledger
  records are `ELIMINATED` at `T0_SCREEN`; every candidate died at an early gate.
- **Test:** `test_d3_screen_can_record_a_candidate_that_passed_every_gate` —
  **behavioural**, on a constructed passing run.
- **Unproven:** no real screening run has ever produced a `CANDIDATE` record.
  The success path is unit-verified and has never run end to end.

## D4 — champion crowned on a single backtest

- **Path:** `research/alkresearch/ledger.py` — `CHAMPION_TIER = Tier.T2_FORWARD`,
  `_enforce_evidence_gate()`, `Ledger.can_promote_champion()`.
- **Reachable today: YES.** The Evidence Gate runs on every `append()`. This is
  the live refusal path, not a dormant one.
- **Tests:** `test_d4_a_tier1_backtest_alone_cannot_crown_a_champion`,
  `test_d4_champion_needs_a_prior_tier1_record_for_the_same_strategy`,
  `test_d4_tier1_still_supports_challenger`,
  `test_d4_champion_on_demo_forward_with_a_prior_backtest_is_allowed` — all
  **behavioural**.
- **Note:** an existing test, `test_tier1_evidence_can_support_champion`, asserted
  the defective behaviour. It was corrected, not worked around.
- **Unproven:** no promotion has ever been attempted on real evidence, because no
  Tier-1 evidence exists — MetaTrader 5 has not been run.

## D5 — a gate that never ran counted as passed

- **Path:** `research/alkresearch/tournament.py` — `skipped_gates`, `incomplete`,
  `status_for_record()`.
- **Reachable today: PARTIALLY.** `status_for_record()` is called on every run,
  but its new outcome — `SCREENED`, for a run with skipped gates — has never been
  recorded, because every candidate is eliminated before a gate gets skipped.
- **Tests:** `test_d5_a_run_with_skipped_gates_is_not_reported_as_passing`,
  `test_d5_a_run_with_every_gate_run_is_complete`,
  `test_d5_an_incomplete_run_cannot_reach_candidate` — all **behavioural**.
- **Deliberate:** `BLOCKED` is not treated as incomplete. G9 requiring MetaTrader 5
  is a known wall, not a gate that was quietly skipped.
- **Unproven:** `SCREENED` has never appeared in the ledger.

## D6 — trade adjudication mixed units

- **Path:** `research/alkresearch/forensics.py` — `FLAT_R`, `classify_outcome()`
  (L215), called from `forensics.py:286`.
- **Reachable today: YES in code, but with NO INPUT.** There is no trade data of
  any kind in the repository — no MT5 account history, no Strategy Tester export,
  no journal. `research/validation/analyze_trades.py` is the parser waiting for it.
- **Tests:** `test_d6_currency_profit_is_not_graded_on_the_r_threshold`,
  `test_d6_an_r_multiple_still_uses_the_r_threshold`,
  `test_d6_an_r_multiple_wins_over_a_contradicting_profit` — all **behavioural**.
- **Unproven:** never run on a real trade.

## Summary

| Defect | Path active today | Test kind | Compiled | Run on real data |
|---|---|---|---|---|
| D1 risk after stop change | **No caller** | source-text | No | No |
| D2 pending order as fill | **Unreachable** | source-text | No | No |
| D3 recording a success | Partial — branch never taken | behavioural | n/a | No |
| D4 champion evidence gate | **Yes, live** | behavioural | n/a | No — no Tier-1 evidence exists |
| D5 skipped gate counted as pass | Partial — status never emitted | behavioural | n/a | No |
| D6 trade adjudication | **Yes, live** | behavioural | n/a | No — no trade data exists |

The accurate sentence is: **six defects were identified and changed, each with a
test that fails on the pre-fix source; two of those tests are text assertions on
uncompiled MQL5, two guard a code path nothing currently calls, and none of the
six has been exercised against real broker or trade data.**

## What would change each verdict

| To promote | Needs |
|---|---|
| D1, D2 to compiled | MetaEditor on Windows; then `RunTests.mq5` executed in the terminal |
| D1 to reachable | A trailing/break-even implementation that actually calls `ModifyStops` |
| D2 to reachable | A pending-order strategy, or an observed broker conversion to 10008 |
| D3, D5 to exercised | One candidate that survives to a late gate on real screening data |
| D4 to exercised | A Strategy Tester run on the owner's broker instrument (Tier-1) |
| D6 to exercised | One real trade export or journal file |
