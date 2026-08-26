# Build report — GPT implementation branch

This report records only work actually implemented on `gpt/trading-brain-build`.
Architecture documents describe intent; this file describes delivery state.

## 2026-08-26 — MT5 command lifecycle recovery contract

### Implemented

- Added a typed, testable reference lifecycle for MT5 commands: `RECEIVED → CHECKED → SENT → RESULT`.
- The lifecycle is append-only and monotonic per request id and command. Duplicate/backwards stages, mixed request ids and command changes are rejected.
- `SENT` is the irreversible boundary. A restart after `SENT` without a terminal `RESULT` is classified as `must_reconcile`; it is never inferred as either success or rejection.
- A restart at `RECEIVED` or `CHECKED` is classified as safe-before-send because no broker side effect has been proven.
- Deterministic rejection before send is supported, including the future `OrderCheck` failure path.
- A mutating command cannot have an `accepted` result unless a durable `SENT` record exists first. This closes a self-audit finding where the original reference model could have represented an impossible successful trade lifecycle.
- Read-only `snapshot` and `reconcile` commands are explicitly prevented from crossing the trade `SENT` side-effect boundary.
- Added tests for normal completion, crash after send, safe pre-send recovery, pre-send rejection, illegal transitions, identity mixing, result shape, read-only commands and the accepted-result send invariant.

### Verification performed

- The first lifecycle CI run failed only on lint/format constraints; those findings were repaired rather than bypassed.
- Final lifecycle CI completed successfully at `b3cc3c512222f760cd7e996cf14e8f3e77c16eb2` (workflow `verify`, run 52). Lint, TypeScript verification and the test suite passed.
- This lifecycle is currently the **reference recovery contract on the desk side**. It is not yet fully wired into the EA's durable command spool.
- `KeelAgent.mq5` still durably records the initial received command only. It does not yet persist structured `CHECKED`, `SENT`, and `RESULT` lifecycle records.
- There is still no `OrderSend`/`OrderSendAsync` path in the EA, and no real-money execution has been enabled.
- MQL5 source has **not** been compiled in MetaEditor in this environment.

### Verification ladder impact

- MT5 stage 1 — architecture reviewed: **done**.
- MT5 stage 2 — implementation complete: **in progress**. The recovery semantics are now executable and tested on the TypeScript side; EA-side lifecycle persistence, `OrderCheck`, demo send, authoritative snapshot/reconcile and spool replay remain.
- MT5 stage 3 — unit tested: **in progress**. The lifecycle/recovery contract is unit-tested; MQL5 compile/runtime verification remains external.
- Stages 4–9: **not claimed**.

### Next highest-priority work

1. Implement the same structured lifecycle journal inside `KeelAgent.mq5`, preserving flush-before-side-effect ordering.
2. Parse and independently validate the exact order payload in MQL5, then perform demo-only `OrderCheck` and persist `CHECKED` or a deterministic rejection.
3. Only after `SENT` can be durably persisted immediately before the broker call, add a demo-only `OrderSend` boundary; never infer fill from the immediate return.
4. Build authoritative snapshot/reconcile responses from active orders, positions, order history and deal history.
5. Implement event-spool replay/watermark acknowledgement after reconnect.
6. Run simulated crash tests at every lifecycle boundary, then compile/run in MetaEditor and validate against a LiteFinance demo account.

## 2026-08-26 — MT5 agent bridge stage B

### Implemented

- `KeelAgent.mq5` now receives newline-delimited desk commands over the authenticated loopback socket using `SocketIsReadable`/`SocketRead`.
- Added a bounded receive buffer and allowlisted command envelope parsing for protocol version, request id and command name.
- Every accepted command is written and `FileFlush`ed to `Keel\\agent-commands.ndjson` **before** it can advance toward any broker side effect.
- Request ids are restored from that journal on EA restart. A replayed request is never executed again; it is reported as ambiguous and requires authoritative reconciliation.
- Trading commands remain hard-gated to demo accounts, and execution is still intentionally disabled in this stage. There is no `OrderSend` or `OrderSendAsync` call in the EA.
- Snapshot/reconcile commands deliberately return ambiguity instead of fabricating an empty account snapshot. A false "no orders/no positions" response would be more dangerous than an unavailable response.
- Added a repository test that locks the EA safety contract: bounded socket receive exists, durable receipt precedes the execution gate, the demo-only guard exists, and no order-send call can appear unnoticed.

### Verification performed

- Previous CI at `c715206e8ae952356ac850bf9c37a0213c52da83` was green.
- Stage-B safety-contract CI completed successfully at `7d0e5bb54753a6f7a7d3c12903cf386aded520e2` (workflow `verify`, run 44).
- MQL5 source has **not** been compiled in MetaEditor in this environment. Source-level verification is not a substitute for a real MetaEditor compile.

### Verification ladder impact

- MT5 stage 1 — architecture reviewed: **done**.
- MT5 stage 2 — implementation complete: **in progress**. Adapter + authenticated bridge + durable command receipt now exist; broker preflight/send, authoritative snapshot/reconcile, spool replay acknowledgements and terminal validation remain.
- MT5 stage 3 — unit tested: **in progress**. TypeScript and source-safety tests exist; MQL5 compile/runtime verification remains external.
- Stages 4–9: **not claimed**.

### Next highest-priority work

1. Add a durable command state machine (`RECEIVED → CHECKED → SENT → RESULT`) so a crash at every boundary has an explicit recovery meaning.
2. Parse and independently validate the exact order payload in MQL5, then run `OrderCheck` on demo only.
3. Only after the pre-send journal state is flushed, add the demo-only `OrderSend` boundary and classify the immediate return without inferring a fill.
4. Build authoritative snapshot/reconcile responses from active orders, positions, order history and deal history.
5. Implement event-spool replay/watermark acknowledgement after reconnect.
6. After simulated chaos tests pass, compile/run against a real MT5 terminal and then a LiteFinance demo account.

## 2026-08-26 — MT5 agent bridge stage A

### Implemented

- Added a versioned newline-delimited protocol between `KeelAgent.mq5` and the Node desk.
- MT5 64-bit tickets, magic values and event sequence identifiers remain decimal strings across the wire.
- Added streaming UTF-8 framing with a 256 KiB per-line ceiling.
- Added authenticated session state with constant-time token comparison.
- The session refuses state before authentication, rejects stale/disconnected agents for commands, de-duplicates replayed event sequence numbers, correlates command results by request id, and rejects outstanding commands as ambiguous when the socket disappears.
- Added a loopback-only TCP bridge. A newly authenticated agent replaces the prior session so two attached EAs cannot both receive one command.
- Added `mt5/KeelAgent.mq5` stage A: loopback connection, authenticated hello, heartbeat, trade-transaction observation, and flush-before-send file spooling.
- Stage A is deliberately observation-only. Command receive/OrderSend is not enabled until parsing, preflight, durable intent spool and replay are implemented and tested.

### Verification performed

- TypeScript protocol/session unit tests added for framing, protocol drift, authentication failure, replayed event sequences, stale heartbeat fail-closed behaviour, request correlation and disconnect ambiguity.
- Repository CI before this change was green at `e60400dcc95fe0ce51051c6e27d9445632bf8c14`.
- The new MQL5 source was written against current MetaQuotes socket, account-info, file-spool and `OnTradeTransaction` APIs. It has **not** been compiled in MetaEditor in this environment.

### Verification ladder impact

- MT5 stage 1 — architecture reviewed: **done**.
- MT5 stage 2 — implementation complete: **in progress**. Adapter exists; agent bridge stage A now exists; command execution, snapshot/reconcile service and spool replay remain.
- MT5 stage 3 — unit tested: **in progress**. TypeScript side has unit coverage; MQL5 requires MetaEditor compile/test before this stage can close.
- Stages 4–9: **not claimed**.

### Next highest-priority work

1. Implement command receive in `KeelAgent.mq5` with strict parsing and allowlisted command types.
2. Persist command intent before `OrderSend`, run `OrderCheck`, and classify result as ack/reject/ambiguous without inferring fill from `OrderSend` alone.
3. Implement spool replay/watermark handshake after reconnect.
4. Build authoritative snapshot/reconcile responses from active orders, positions, order history and deal history.
5. Only after simulated chaos tests pass, compile/run against a real MT5 terminal and then a LiteFinance demo account.
