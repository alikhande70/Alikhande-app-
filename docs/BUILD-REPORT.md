# Build report — GPT implementation branch

This report records work actually implemented on `gpt/trading-brain-build`. Architecture documents describe intent; this file describes delivery state. The preserved Claude branch is not modified by this work.

## 2026-08-26 — MT5 authoritative snapshot trust boundary

### Implemented

- Added runtime validation for MT5 host snapshots before they are admitted into the desk's authoritative broker-truth path.
- The validator requires complete account, instrument, position, order and quote collections rather than allowing absent broker-state fields to be interpreted as empty state.
- MT5 ticket, position-id and magic values are validated as unsigned 64-bit decimal strings and remain strings across the JavaScript boundary; identifiers outside the MT5 uint64 domain are rejected.
- Financial wire values must use explicit plain-decimal text; exponent notation is rejected so precision semantics stay explicit.
- Snapshot trade mode, position model, side, asset class and order state are restricted to the protocol's declared values rather than silently widened.
- Snapshot timestamps used for freshness/reconciliation must be finite and non-negative.
- Optional fields are exact: an optional value is either present with a validated value or absent, never present as `undefined`.
- `Mt5AgentBridgeServer` now validates every incoming `snapshot` message before `Mt5AgentSession` can publish it. A malformed snapshot causes protocol failure and session disconnect rather than being treated as broker truth.

### Self-audit decisions

- I did **not** implement the EA snapshot producer in the same change. The receiving trust boundary had to fail closed before authoritative state could be enabled.
- I did **not** treat missing `positions`, `orders` or `quotes` as empty arrays. In a recovery path, incomplete data must mean “truth unavailable”, never “nothing exists”.
- I did **not** convert MT5 64-bit identifiers to JavaScript `Number` even when values would happen to fit for a particular account.
- I did **not** enable `OrderSend`; authoritative snapshot/reconcile remains a prerequisite for crossing the irreversible broker boundary.

### Verification performed

- Added tests covering a valid complete snapshot, identifiers beyond JavaScript's safe-integer range, uint64 overflow rejection, missing position collection rejection, exponent-notation rejection, unknown order-state rejection and negative-time rejection.
- CI first found a formatting defect and then an `exactOptionalPropertyTypes` defect. Both were fixed rather than bypassed.
- CI `verify` run 65 completed **successfully** for commit `8dc21e6507f1ced8ce251def058b6a4b58e9456e` after lint, TypeScript and the full test suite passed.
- MQL5 has still **not** been compiled in MetaEditor in this environment. No MT5 terminal or LiteFinance demo account was used in this stage.

### Verification ladder impact

- Stage 1 — architecture reviewed: **done**.
- Stage 2 — implementation complete: **in progress**. The desk-side snapshot trust boundary is now fail-closed; the EA still needs to produce authoritative snapshot/reconcile evidence.
- Stage 3 — unit tested: **in progress**. Runtime snapshot validation and repository tests are green; compiled MQL5 tests remain external.
- Stages 4–9: **not claimed**.

### Next highest-priority work

1. Build the EA-side authoritative snapshot/reconcile producer from current positions, active orders and bounded history rather than guessed broker state.
2. Include explicit history coverage/freshness so “history unavailable/incomplete” cannot become “no matching order”.
3. Map MT5 symbols to configured canonical instruments without guessing broker suffix/prefix semantics.
4. Link reconciliation evidence to durable request/magic identity without assuming `OnTradeTransaction` event order.
5. Keep `OrderSend` disabled until this recovery truth path is simulation/chaos tested.

## 2026-08-26 — MT5 EA preflight stage C: durable CHECKED/RESULT + demo-only OrderCheck

### Implemented

- Added `mt5/KeelOrderCheck.mqh` and wired it into `mt5/KeelAgent.mq5`.
- The EA now independently parses the `place_order` payload rather than trusting the desk validator alone.
- The EA constructs `MqlTradeRequest` for market, limit, stop and stop-limit requests, including magic, symbol, volume, SL/TP, GTC/DAY time-in-force and pending/market price semantics.
- Filling policy is selected from MT5 symbol/execution metadata: pending orders use RETURN; non-market execution may use RETURN; Market Execution requires a permitted FOK/IOC mode and fails closed if neither is available.
- A place-order request can advance only when the account is **demo**, the terminal is connected, and expert trading is allowed.
- `OrderCheck(request, check)` is now called on that demo-only path.
- The result of the check is durably journalled as `CHECKED` before any terminal result is returned to the desk.
- A terminal `RESULT` record is also durably journalled for preflight rejection or successful preflight.
- A successful `OrderCheck` is deliberately reported as `ambiguous / order_check_passed_execution_not_enabled`; it is not treated as an accepted order, because no broker send occurs.
- `maxSlippage` is deliberately rejected for now. The current wire request has no explicit reference price, so silently mapping it to MT5 `deviation` would pretend to enforce a risk constraint whose semantics are undefined.
- `KeelAgent.mq5` remains free of `OrderSend` and `OrderSendAsync`.
- Snapshot/reconcile remain unavailable rather than returning fabricated empty broker state.

### Self-audit decisions

- I did **not** enable demo execution in the same change as `OrderCheck`. Preflight needs its own independently testable gate before the irreversible boundary is introduced.
- I did **not** let desk-side schema validation stand in for EA validation. The execution process now rejects malformed/unsupported place-order semantics again at the terminal boundary.
- I did **not** silently ignore `maxSlippage`; doing so would turn a visible risk field into a false guarantee.
- I did **not** infer execution from a successful check. MetaTrader documents `OrderCheck` as validation/funds preflight, not proof that a subsequent request executes.

### Verification performed

- Added/updated repository source-safety tests asserting:
  - bounded command receive;
  - durable receipt before preflight;
  - demo gate around place-order preflight;
  - `OrderCheck` is present;
  - `CHECKED` and `RESULT` lifecycle records are present;
  - unsupported slippage semantics are rejected explicitly;
  - `OrderSend`/`OrderSendAsync` remain absent;
  - snapshot/reconcile are not fabricated.
- CI `verify` run 56 completed **successfully** for commit `035b239f28d5f6a256c632f12598d3f613a8163a`.
- MQL5 has **not** been compiled in MetaEditor in this environment. The source-safety contract is verified; MQL5 compile/runtime behaviour is still unverified.
- No MT5 terminal and no LiteFinance demo account were used. No broker-side execution occurred.

### Verification ladder impact

- Stage 1 — architecture reviewed: **done**.
- Stage 2 — implementation complete: **in progress**. Place-order preflight and part of the EA lifecycle are now implemented; broker send, authoritative snapshot/reconcile, spool replay/watermarks, cancel/modify/close and final assembly remain.
- Stage 3 — unit tested: **in progress**. TypeScript and repository source-contract tests are green; compiled MQL5 tests remain external.
- Stages 4–9: **not claimed**.

### Next highest-priority work

1. Add a durable EA `SENT` record that is flushed immediately before the future broker-side call.
2. Introduce a **demo-only** `OrderSend` boundary and classify only its immediate result; never infer a fill from it.
3. Build authoritative MT5 snapshot/reconcile from positions, active orders, order history and deal history.
4. Link `OnTradeTransaction` and reconciliation evidence back to the durable request/magic identity without assuming event order.
5. Add crash/restart/reconnect tests for every `RECEIVED → CHECKED → SENT → RESULT` boundary.
6. Only after those simulated gates pass, compile in MetaEditor and validate against a real LiteFinance demo terminal.

## 2026-08-26 — MT5 command lifecycle recovery contract

### Implemented

- Added a typed, testable reference lifecycle: `RECEIVED → CHECKED → SENT → RESULT`.
- The lifecycle is append-only and monotonic per request id/command.
- `SENT` is the irreversible boundary. A restart after `SENT` without a terminal result becomes `must_reconcile`, never inferred success/rejection.
- A mutating command cannot have an accepted result unless a durable `SENT` record exists first.
- Read-only snapshot/reconcile cannot cross the trade side-effect boundary.
- Tests cover normal completion, crash after send, safe pre-send recovery, deterministic pre-send rejection, illegal transitions, identity mixing and read-only invariants.

### Verification performed

- CI completed successfully at `b3cc3c512222f760cd7e996cf14e8f3e77c16eb2` (verify run 52).
- This remains the desk-side reference state machine. EA now implements durable `RECEIVED`, place-order `CHECKED` and preflight `RESULT`; EA-side `SENT` does not exist yet because broker send is still disabled.

## 2026-08-26 — MT5 agent bridge stage B

### Implemented

- `KeelAgent.mq5` receives newline-delimited authenticated loopback commands through a bounded socket path.
- Every accepted command is flushed to `Keel\\agent-commands.ndjson` before it may advance.
- Request ids are restored across EA restart; duplicates require reconciliation rather than re-execution.
- Trading commands are demo-gated.
- Snapshot/reconcile refuse to fake empty truth.
- Source-safety tests lock the bounded receive, durable receipt and no-send boundaries.

### Verification performed

- Stage-B CI completed successfully at `7d0e5bb54753a6f7a7d3c12903cf386aded520e2` (verify run 44).
- MQL5 compile remained externally unverified.

## 2026-08-26 — MT5 agent bridge stage A

### Implemented

- Added versioned newline-delimited protocol between the EA and Node desk.
- 64-bit MT5 identifiers remain decimal strings across the wire.
- Added UTF-8 framing, authenticated session state, heartbeat, event sequence de-duplication, request/result correlation and disconnect ambiguity.
- Added loopback TCP bridge plus EA heartbeat/transaction observation and flush-before-transmit event spooling.

### Verification performed

- TypeScript protocol/session tests cover framing, authentication, replayed sequences, stale heartbeat behaviour, request correlation and disconnect ambiguity.
- Initial MQL5 source was written against MetaQuotes APIs but not compiled here.

## Standing external verification boundary

The repository can build and test the deterministic desk-side logic and can statically guard the MQL5 source, but this environment has no Windows MetaEditor/MT5 terminal or LiteFinance account. Therefore:

- MetaEditor compile is still unverified.
- Real terminal stage is still unverified.
- LiteFinance demo stage is still unverified.
- No real-money execution is enabled or claimed.
- Accepted Trading Mission / Trading Brain / Memory designs in ADR-0018–0022 remain sequenced **after** the MT5 truth path, rather than being allowed to outrun execution implementation.
