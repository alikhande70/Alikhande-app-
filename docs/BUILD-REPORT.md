# Build report — GPT implementation branch

This report records work actually implemented on `gpt/trading-brain-build`. Architecture documents describe intent; this file describes delivery state. The preserved Claude branch is not modified by this work.

## Current state — 2026-08-26

The project is still in the MT5 execution-truth phase. Trading Mission, Trading Brain, memory, evaluation and intelligence UX remain deliberately sequenced after this foundation.

### Implemented and repository-verified

- Versioned loopback protocol between the Windows execution side and `KeelAgent.mq5`.
- Authenticated agent hello, heartbeat, bounded UTF-8 framing, event sequence de-duplication and disconnect ambiguity handling.
- MT5 64-bit identifiers remain decimal strings across the JavaScript boundary.
- Durable EA command receipt before any preflight or future broker-facing action.
- Request ids restored across EA restart; duplicate mutating requests require reconciliation rather than re-execution.
- Reference command lifecycle: `RECEIVED → CHECKED → SENT → RESULT`, with restart-after-`SENT` classified as requiring reconciliation.
- Independent EA parsing/validation for `place_order` requests.
- Demo-only `OrderCheck` preflight with durable `CHECKED` and preflight `RESULT` journal records.
- Successful `OrderCheck` is not treated as execution. `OrderSend` and `OrderSendAsync` remain absent.
- Desk-side authoritative snapshot validator is fail-closed: missing broker-state collections, invalid 64-bit ids, invalid decimal wire values, unsupported enum values and invalid timestamps are rejected.
- EA-side read-only authoritative **current-state snapshot** reads account state, current positions, current orders and current quotes for represented symbols.
- Snapshot construction fails closed if broker truth cannot be read completely or the bounded transport size is exceeded. Incomplete state is never converted into empty truth.
- Snapshot requests are request-correlated: an unrelated or stale snapshot cannot satisfy a current request.
- EA-side **bounded reconciliation** now reads four distinct MT5 truth surfaces:
  - current positions;
  - current orders;
  - historical orders selected with an explicit `HistorySelect` interval;
  - historical deals selected from the same bounded history interval.
- Reconcile responses report the history interval that was actually selected, and a negative observation is usable only when current positions, current orders and history were all scanned successfully and the history range covers the ambiguous send window plus guard.
- Historical order evidence now carries explicit order-state semantics (`PENDING_SUBMIT`, `WORKING`, `PARTIAL`, `FILLED`, `CANCEL_PENDING`, `CANCELLED`, `REJECTED`, `EXPIRED`, `UNKNOWN`).
- **P0 false-fill defect closed fail-safe:** an old MT5 order carrying the expected magic no longer proves execution by itself. `REJECTED`, `CANCELLED` or `EXPIRED` order-only evidence cannot be reconstructed as `FILLED`. Actual deal/position evidence is required to confirm execution when the order is no longer active.
- Reconcile responses now cross a strict runtime-validation boundary on the Windows side. Malformed candidate kind/side, missing or unknown order state, illegal order state on deal/position evidence, invalid decimal strings, invalid/out-of-range uint64 ids, missing scan flags or inverted history windows are rejected before they can affect broker truth.
- Tests cover the false-fill regression directly, including rejected/cancelled/expired historical order-only evidence and malformed order evidence.

### Self-audit findings still open

1. **Order-only terminal state is currently fail-closed, not positively resolved.** A historical `REJECTED`/`CANCELLED`/`EXPIRED` order with the expected magic now remains `indeterminate` rather than being misreported as a fill. The next refinement should propagate trustworthy terminal order state through `LookupResult` so the higher-level order state machine can resolve it positively without weakening execution proof.
2. **Crash/restart chaos coverage must expand around reconciliation.** Required cases include host crash during reconcile, EA restart after durable receipt, duplicate reconcile request, response loss, stale/out-of-order response and terminal reconnect while resolution is active.
3. **Canonical instrument mapping is not complete.** The EA currently keeps broker symbols as their own canonical value in its snapshot. Broker suffix/prefix mapping must be driven by configured symbol metadata rather than guessed.
4. **Instrument metadata is intentionally not fabricated.** EA snapshots currently do not claim contract/tick/volume metadata that has not been truthfully mapped from MT5.
5. **No-send boundary remains intentional.** Demo `OrderSend` stays disabled until reconciliation/recovery semantics and chaos tests are strong enough, followed by MetaEditor compilation and real LiteFinance Demo validation.

### Latest verification

- The branch is under continuous GitHub Actions verification with `pnpm verify` (lint + TypeScript + full repository tests).
- The first CI pass after the historical-order-state change correctly caught style/lint defects in newly added source-contract tests and a formatting defect in the reconcile validator; those were repaired rather than ignored.
- The current verification run for the repaired head is still being observed at the time of this report. Do not treat this document alone as proof of a green latest head; use the workflow status for the exact commit.
- Repository tests now include explicit proof that rejected/cancelled/expired MT5 historical orders cannot masquerade as fills, plus runtime reconcile payload validation.

### External verification boundary

The current environment does not provide a Windows MetaEditor/MT5 terminal or a LiteFinance demo account. Therefore these remain **NOT YET VERIFIED**:

- MQL5 compile in MetaEditor;
- real EA runtime inside MT5;
- actual LiteFinance Demo connectivity;
- broker-side `OrderCheck` behaviour on the target terminal build;
- restart/reconnect behaviour against a real terminal;
- end-to-end app → execution host → EA → MT5 → broker → reconciliation behaviour.

No real-money execution is enabled or claimed.

## Verification ladder

| Stage | Status | Evidence / remaining work |
| --- | --- | --- |
| 1. Architecture reviewed | **DONE** | ADR-0015 through ADR-0022 and design reviews accepted. |
| 2. Implementation | **IN PROGRESS** | Broker adapter, agent bridge, durable preflight, current snapshot, bounded history reconcile and strict reconcile validation built. Positive terminal-order resolution, chaos hardening, demo send, cancel/modify/close and final host assembly remain. |
| 3. Repository unit/static tests | **IN PROGRESS** | CI runs lint + TypeScript + full tests for every pushed change; latest repaired head must be green before advancing the execution gate. MQL compilation is not covered by Linux CI. |
| 4. Integration simulation | **IN PROGRESS** | Protocol/session/recovery/reconcile components tested; full simulated terminal lifecycle and response-loss matrix still required. |
| 5. Chaos/failure tests | **PARTIAL** | Disconnect/duplicate/ambiguous-send contracts exist; crash boundaries, stale/out-of-order reconciliation and spool replay need broader coverage. |
| 6. MetaEditor compile | **NOT VERIFIED** | Requires Windows + MetaEditor. |
| 7. Real MT5 terminal | **NOT VERIFIED** | Requires target terminal. |
| 8. LiteFinance Demo | **NOT VERIFIED** | Requires demo account/terminal. |
| 9. End-to-end demo proof | **NOT VERIFIED** | Must follow stages 6–8. |

## Next highest-priority sequence

1. Confirm the repaired reconciliation branch head is fully green in CI; repair any remaining failure before new execution work.
2. Extend the broker lookup contract so trustworthy historical terminal-order evidence can resolve `REJECTED`/`CANCELLED`/`EXPIRED` positively while deal/position evidence remains the only proof of fill.
3. Add simulated crash/restart/duplicate/response-loss/stale-response tests around reconciliation and unknown-order recovery.
4. Complete canonical symbol/instrument metadata mapping without guessing broker suffixes or contract metadata.
5. Re-audit the entire `RECEIVED → CHECKED → SENT → RESULT → RECONCILED` path for duplicate execution and false absence.
6. Only after those gates pass, introduce a **demo-only** durable `SENT` + `OrderSend` boundary and classify the immediate MT5 result without inferring fill.
7. Compile in MetaEditor and then validate on LiteFinance Demo before any intelligence phase can claim an end-to-end broker-truth foundation.
