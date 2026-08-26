# Build report — GPT implementation branch

This report records work actually implemented on `gpt/trading-brain-build`. Architecture documents describe intent; this file describes delivery state. The preserved Claude branch is not modified by this work.

## Current state — 2026-08-26

The project is still in the MT5 execution-truth phase. Trading Mission, Trading Brain, memory, evaluation and intelligence UX remain deliberately sequenced after this foundation.

### Implemented and repository-verified before the current pending CI head

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
- EA-side **bounded reconciliation** reads four distinct MT5 truth surfaces:
  - current positions;
  - current orders;
  - historical orders selected with an explicit `HistorySelect` interval;
  - historical deals selected from the same bounded history interval.
- Reconcile responses report the history interval actually selected, and a negative observation is usable only when current positions, current orders and history were all scanned successfully and the history range covers the ambiguous send window plus guard.
- Historical order evidence carries explicit order-state semantics (`PENDING_SUBMIT`, `WORKING`, `PARTIAL`, `FILLED`, `CANCEL_PENDING`, `CANCELLED`, `REJECTED`, `EXPIRED`, `UNKNOWN`).
- **P0 false-fill defect closed fail-safe:** an old MT5 order carrying the expected magic no longer proves execution by itself. Actual deal/position evidence is required to confirm execution when the order is no longer active.
- Reconcile responses cross a strict runtime-validation boundary on the Windows side. Malformed candidate kind/side, missing or unknown order state, illegal order state on deal/position evidence, invalid decimal strings, invalid/out-of-range uint64 ids, missing scan flags or inverted history windows are rejected before they can affect broker truth.

### Newly implemented on the current head — CI verification pending

- Trustworthy order-only terminal history can now resolve an ambiguous send **positively** to `REJECTED`, `CANCELLED` or `EXPIRED` when the expected MT5 magic identifies one consistent terminal order and no deal/position execution evidence exists.
- A historical `FILLED` order **without** deal/position evidence remains indeterminate; order state alone is still not accepted as proof of execution.
- Conflicting terminal order evidence for the same magic remains indeterminate rather than being guessed through.
- The existing public broker lookup contract did not need expansion: `found: true` means the venue definitely has evidence for the order, while `BrokerOrder.state` carries the actual terminal state. This reuses the existing `resolution.found` path in the core reducer.
- Focused tests now cover `UNKNOWN → REJECTED/CANCELLED/EXPIRED` recovery with zero fabricated fill quantity.
- A self-review caught an unsafe test-file replacement that would have removed existing coverage. That commit was removed from the branch before proceeding, and the new recovery test was re-added as an independent file so the previous test suite remains intact.

### Self-audit findings still open

1. **Crash/restart chaos coverage must expand around reconciliation.** Required cases include host crash during reconcile, EA restart after durable receipt, duplicate reconcile request, response loss, stale/out-of-order response and terminal reconnect while resolution is active.
2. **Canonical instrument mapping is not complete.** The EA currently keeps broker symbols as their own canonical value in its snapshot. Broker suffix/prefix mapping must be driven by configured symbol metadata rather than guessed.
3. **Instrument metadata is intentionally not fabricated.** EA snapshots currently do not claim contract/tick/volume metadata that has not been truthfully mapped from MT5.
4. **No-send boundary remains intentional.** Demo `OrderSend` stays disabled until reconciliation/recovery semantics and chaos tests are strong enough, followed by MetaEditor compilation and real LiteFinance Demo validation.

### Latest verification

- The branch is under GitHub Actions verification with `pnpm verify` (lint + TypeScript + full repository tests).
- The last fully verified baseline before this terminal-resolution change was green.
- GitHub Actions for the new terminal-resolution commits are currently pending/queued. Therefore the new head is **IMPLEMENTED BUT NOT YET REPOSITORY-VERIFIED** and must not be called green until its exact workflow run succeeds.
- The pending change includes direct observation-layer tests, adapter tests and a core reducer recovery test for rejected/cancelled/expired terminal outcomes.

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
| 2. Implementation | **IN PROGRESS** | Broker adapter, agent bridge, durable preflight, current snapshot, bounded history reconcile, strict reconcile validation and positive non-fill terminal recovery built. Chaos hardening, canonical mapping, demo send, cancel/modify/close and final host assembly remain. |
| 3. Repository unit/static tests | **IN PROGRESS** | CI runs lint + TypeScript + full tests for pushed changes. The exact terminal-resolution head is awaiting GitHub Actions execution and is not yet marked verified. MQL compilation is not covered by Linux CI. |
| 4. Integration simulation | **IN PROGRESS** | Protocol/session/recovery/reconcile components tested; full simulated terminal lifecycle and response-loss matrix still required. |
| 5. Chaos/failure tests | **PARTIAL** | Existing chaos suite already covers ambiguous execution, disconnects, duplicated/dropped fill events, duplicate intent submission and eventual reconciliation convergence. Crash boundaries, stale/out-of-order reconciliation and spool replay need broader targeted coverage. |
| 6. MetaEditor compile | **NOT VERIFIED** | Requires Windows + MetaEditor. |
| 7. Real MT5 terminal | **NOT VERIFIED** | Requires target terminal. |
| 8. LiteFinance Demo | **NOT VERIFIED** | Requires demo account/terminal. |
| 9. End-to-end demo proof | **NOT VERIFIED** | Must follow stages 6–8. |

## Next highest-priority sequence

1. Wait for the exact current head to run through GitHub Actions; repair any lint/type/test failure before adding broker-facing execution work.
2. Add targeted simulated crash/restart/duplicate/response-loss/stale-response tests around reconciliation and unknown-order recovery, without duplicating the broad chaos coverage that already exists.
3. Complete canonical symbol/instrument metadata mapping without guessing broker suffixes or contract metadata.
4. Re-audit the entire `RECEIVED → CHECKED → SENT → RESULT → RECONCILED` path for duplicate execution and false absence.
5. Only after those gates pass, introduce a **demo-only** durable `SENT` + `OrderSend` boundary and classify the immediate MT5 result without inferring fill.
6. Compile in MetaEditor and then validate on LiteFinance Demo before any intelligence phase can claim an end-to-end broker-truth foundation.
