# Build report — GPT implementation branch

This report records only work actually implemented on `gpt/trading-brain-build`.
Architecture documents describe intent; this file describes delivery state.

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
