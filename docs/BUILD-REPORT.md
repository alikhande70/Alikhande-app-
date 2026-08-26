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
- EA-side read-only authoritative **current-state snapshot** now reads:
  - account identity and account financial state;
  - current positions using `PositionsTotal` / `PositionGetTicket`;
  - current orders using `OrdersTotal` / `OrderGetTicket`;
  - current quotes for symbols represented by those positions/orders.
- Snapshot construction fails closed if the terminal is disconnected, account identity is incomplete, a position/order/quote read fails, or the response exceeds the bounded transport size. It does not convert incomplete broker state into empty truth.
- Snapshot responses now carry the originating `requestId`.
- The desk has a dedicated typed `snapshot()` request path. A snapshot resolves only from the validated response carrying the matching `requestId`; unrelated snapshots cannot satisfy the request.
- If the EA reports that current truth is unavailable, the snapshot promise rejects rather than returning a fabricated state.
- Reconciliation remains disabled until bounded order/deal history coverage is implemented.

### Self-audit findings still open

1. **Historical reconciliation is the next blocker.** Current positions and current orders are insufficient to resolve an ambiguous send after an order has left active state. Reconcile must use a bounded `HistorySelect` window and explicitly report the history coverage that was actually scanned.
2. **Historical order evidence needs state semantics.** The existing fallback in the desk must not blindly represent every historical order carrying the expected magic as `FILLED`. Rejected/cancelled/expired order evidence must remain distinguishable from deal/position fill evidence before history-backed reconcile is enabled.
3. **Canonical instrument mapping is not complete.** The EA currently keeps broker symbols as their own canonical value in its snapshot. Broker suffix/prefix mapping must be driven by configured symbol metadata rather than guessed.
4. **Instrument metadata is intentionally not fabricated.** EA snapshots currently emit `instruments: []` until truthful contract/tick/volume metadata mapping is completed.
5. **No-send boundary remains intentional.** Demo `OrderSend` is still disabled until snapshot + history-backed reconciliation and recovery paths are simulation/chaos tested.

### Latest verification

- CI `verify` run 73 completed **successfully** for commit `ec69b6b048d6ce9b1b37824e1843f632c15d0fae` after lint, TypeScript and the full repository test suite passed.
- Tests now cover snapshot request correlation, unrelated snapshot rejection for correlation purposes, truth-unavailable rejection, disconnect cleanup, malformed snapshot rejection, 64-bit identifier handling, decimal-format enforcement and the no-send EA source boundary.
- The authoritative snapshot producer itself is guarded by source-contract tests in this environment.

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
| 2. Implementation | **IN PROGRESS** | Broker adapter, agent bridge, durable preflight, current-state snapshot built. Historical reconcile, demo send, cancel/modify/close and final host assembly remain. |
| 3. Repository unit/static tests | **IN PROGRESS / GREEN** | Latest CI green; compiled MQL5 is not covered by Linux CI. |
| 4. Integration simulation | **IN PROGRESS** | Protocol/session/recovery paths tested; full simulated terminal + history reconcile still required. |
| 5. Chaos/failure tests | **PARTIAL** | Disconnect/duplicate/ambiguous-send contracts exist; crash boundaries and spool replay need broader coverage. |
| 6. MetaEditor compile | **NOT VERIFIED** | Requires Windows + MetaEditor. |
| 7. Real MT5 terminal | **NOT VERIFIED** | Requires target terminal. |
| 8. LiteFinance Demo | **NOT VERIFIED** | Requires demo account/terminal. |
| 9. End-to-end demo proof | **NOT VERIFIED** | Must follow stages 6–8. |

## Next highest-priority sequence

1. Extend reconciliation evidence so historical order state is represented honestly and cannot be misreported as a fill.
2. Implement EA-side bounded `HistorySelect` reconciliation over current positions, current orders, historical orders and historical deals.
3. Add a typed, request-correlated reconcile response and strict desk-side runtime validation of that observation.
4. Prove that a negative reconcile verdict is possible only when positions, orders and history were all scanned and the reported history window covers the original send window plus guard.
5. Add simulated crash/restart/duplicate/response-loss tests around reconciliation.
6. Complete canonical symbol/instrument metadata mapping without guessing broker suffixes.
7. Only after those gates pass, introduce a **demo-only** `SENT` + `OrderSend` boundary and classify the immediate MT5 result without inferring fill.
8. Compile in MetaEditor and then validate on LiteFinance Demo before any later intelligence phase can claim an end-to-end truth foundation.
