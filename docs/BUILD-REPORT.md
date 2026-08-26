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

### Newly implemented on the current head — verification pending

- Trustworthy order-only terminal history can resolve an ambiguous send **positively** to `REJECTED`, `CANCELLED` or `EXPIRED` when the expected MT5 magic identifies one consistent terminal order and no deal/position execution evidence exists.
- A historical `FILLED` order **without** deal/position evidence remains indeterminate; order state alone is still not accepted as proof of execution.
- Conflicting terminal order evidence for the same magic remains indeterminate rather than being guessed through.
- Focused core tests cover `UNKNOWN → REJECTED/CANCELLED/EXPIRED` recovery with zero fabricated fill quantity.
- **New P0 recovery fix:** a durable `RESULT` carrying `outcome: ambiguous` after the irreversible `SENT` boundary is no longer classified as resolved after restart. It now remains `must_reconcile`, so an uncertain broker call cannot be converted into success/rejection by the command journal alone.
- Added targeted recovery tests for:
  - host crash while a reconcile request is outstanding;
  - a late response from the pre-crash request arriving after a new host session starts;
  - duplicate concurrent reconcile requests resolving independently by request id;
  - an out-of-order snapshot with the correct request id being ignored until a newer broker-truth sequence arrives;
  - `SENT → ambiguous RESULT → restart` remaining non-retryable and reconciliation-required.
- Opened draft PR #1 (`gpt/trading-brain-build` → `main`) as the long-running integration/review surface. It is explicitly not merge-ready and must remain draft until the verification ladder is complete.

### Self-audit findings still open

1. **Recovery chaos coverage is improved but not complete.** The current head now covers host crash/response loss/stale response/request correlation. Still required: a fuller EA-spool replay simulation, terminal reconnect while an unknown resolver job is active, and durable duplicate-command recovery across an actual agent restart boundary.
2. **Canonical instrument mapping is not complete.** The EA currently keeps broker symbols as their own canonical value in its snapshot. Broker suffix/prefix mapping must be driven by configured symbol metadata rather than guessed.
3. **Instrument metadata is intentionally not fabricated.** EA snapshots currently do not claim contract/tick/volume metadata that has not been truthfully mapped from MT5.
4. **No-send boundary remains intentional.** Demo `OrderSend` stays disabled until reconciliation/recovery semantics and chaos tests are strong enough, followed by MetaEditor compilation and real LiteFinance Demo validation.

### Latest verification

- The repository verification workflow is `pnpm verify` (Biome lint + TypeScript + full repository tests).
- The last fully verified baseline before the terminal-resolution/recovery changes was green.
- The newest connector-authored commits did **not** create a new push-triggered GitHub Actions run. A draft PR was opened to provide an independent `pull_request` trigger, but at the time of this report GitHub still shows no workflow run for current head `b5f0707f942000a18582dc00e1d02a472ae7dc97`.
- Therefore the current head is **IMPLEMENTED AND SELF-AUDITED, BUT NOT YET REPOSITORY-VERIFIED**. It must not be described as green until an exact-head workflow succeeds or an equivalent isolated `pnpm verify` run is captured.
- A remote isolated-shell verification attempt was also unavailable in this non-interactive run, so no substitute verification is claimed.

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
| 2. Implementation | **IN PROGRESS** | Broker adapter, agent bridge, durable preflight, current snapshot, bounded history reconcile, strict reconcile validation, positive non-fill terminal recovery, and targeted crash/stale-response hardening built. Canonical mapping, demo send, cancel/modify/close and final host assembly remain. |
| 3. Repository unit/static tests | **IN PROGRESS** | Workflow exists, but current connector-authored head has no exact-head Actions run yet. Current changes remain unverified until `pnpm verify` executes on the exact head. MQL compilation is not covered by Linux CI. |
| 4. Integration simulation | **IN PROGRESS** | Protocol/session/recovery/reconcile components tested in repository suites; current head adds host-crash and request-correlation scenarios but awaits exact-head execution. |
| 5. Chaos/failure tests | **PARTIAL** | Broad paper-broker chaos exists. Targeted MT5 recovery coverage now includes crash, late/stale response, duplicate concurrent reconcile isolation and out-of-order snapshot rejection. EA spool replay/restart and reconnect-during-resolution still need deeper coverage. |
| 6. MetaEditor compile | **NOT VERIFIED** | Requires Windows + MetaEditor. |
| 7. Real MT5 terminal | **NOT VERIFIED** | Requires target terminal. |
| 8. LiteFinance Demo | **NOT VERIFIED** | Requires demo account/terminal. |
| 9. End-to-end demo proof | **NOT VERIFIED** | Must follow stages 6–8. |

## Next highest-priority sequence

1. Obtain an exact-head `pnpm verify` result for the current branch/PR; repair any lint/type/test failure before adding broker-facing execution work.
2. Complete canonical symbol/instrument metadata mapping without guessing broker suffixes or contract metadata.
3. Add the remaining restart/spool-replay/reconnect recovery tests and re-audit the full `RECEIVED → CHECKED → SENT → RESULT → RECONCILED` path for duplicate execution and false absence.
4. Only after those gates pass, introduce a **demo-only** durable `SENT` + `OrderSend` boundary and classify the immediate MT5 result without inferring fill.
5. Compile in MetaEditor and then validate on LiteFinance Demo before any intelligence phase can claim an end-to-end broker-truth foundation.
