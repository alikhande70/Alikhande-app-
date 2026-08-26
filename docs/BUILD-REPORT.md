# Build report — GPT implementation branch

This report records work actually implemented on `gpt/trading-brain-build`. Architecture documents describe intent; this file describes delivery state. The preserved Claude branch is not modified by this work.

## Current state — 2026-08-26

The project remains in the MT5 execution-truth phase. Trading Mission, Trading Brain, memory, evaluation and intelligence UX remain deliberately sequenced after this foundation.

### Implemented and repository-verified

- Versioned loopback protocol between the Windows execution side and `KeelAgent.mq5`.
- Authenticated agent hello, heartbeat, bounded UTF-8 framing, event-sequence de-duplication and disconnect ambiguity handling.
- MT5 64-bit identifiers remain decimal strings across the JavaScript boundary.
- Durable EA command receipt before any preflight or future broker-facing action.
- Request ids restored across EA restart; duplicate mutating requests require reconciliation rather than re-execution.
- Reference command lifecycle: `RECEIVED → CHECKED → SENT → RESULT`, with restart-after-`SENT` classified as requiring reconciliation.
- Independent EA parsing/validation for `place_order` requests.
- Demo-only `OrderCheck` preflight with durable `CHECKED` and preflight `RESULT` journal records.
- Successful `OrderCheck` is not treated as execution. `OrderSend` and `OrderSendAsync` remain absent.
- Desk-side authoritative snapshot validator is fail-closed: missing broker-state collections, invalid 64-bit ids, invalid decimal wire values, unsupported enum values and invalid timestamps are rejected.
- EA-side read-only authoritative current-state snapshot reads account state, current positions, current orders and current quotes for represented symbols.
- Snapshot construction fails closed if broker truth cannot be read completely or the bounded transport size is exceeded. Incomplete state is never converted into empty truth.
- Snapshot requests are request-correlated: an unrelated or stale snapshot cannot satisfy a current request.
- EA-side bounded reconciliation reads current positions, current orders, historical orders in an explicit `HistorySelect` interval and historical deals from the same interval.
- Historical order evidence carries explicit order-state semantics. Rejected/cancelled/expired historical orders cannot masquerade as fills; deal/position evidence is required to confirm execution once an order is no longer active.
- Reconcile responses cross strict runtime validation on the Windows side.
- Trustworthy order-only terminal history can resolve an ambiguous send positively to `REJECTED`, `CANCELLED` or `EXPIRED` when one consistent order with the expected magic exists and no deal/position execution evidence exists.
- A historical `FILLED` order without deal/position evidence remains indeterminate.
- A durable `RESULT` with ambiguous outcome after the irreversible `SENT` boundary remains reconciliation-required after restart.
- Targeted recovery tests cover host crash while reconcile is outstanding, stale/late responses, duplicate concurrent reconcile isolation and out-of-order snapshot rejection.
- Explicit MT5 venue-symbol → canonical mapping exists. It performs no suffix stripping or fuzzy matching and rejects ambiguous many-to-one aliases.
- A new fail-closed **instrument binding layer** separates two kinds of truth:
  - numerical execution facts such as tick size, contract size and volume constraints remain venue/MT5 supplied;
  - semantic metadata that cannot safely be inferred from an MT5 symbol name (`assetClass`, `base`, `quote`, `venueTimeZone`) must be configured explicitly per canonical instrument.
- Missing semantic instrument metadata blocks `InstrumentSpec` construction rather than generating a plausible value. Host-supplied semantic fields are deliberately not trusted by this binding layer.

### Latest repository verification

- Exact head `193bbd1abd8ef7b885514f85167fda8eade6adf0` completed GitHub Actions workflow `verify` successfully.
- The workflow ran Biome lint, TypeScript typecheck and all repository tests.
- The instrument-binding tests initially exposed two implementation/test hygiene defects (format/type-only import and an incorrect Decimal test shape). Both were repaired before the exact-head success.
- Repository verification therefore supports the TypeScript/static/test claims above. It does **not** prove MQL compilation or a real MT5 runtime.

### Self-audit findings still open

1. **Instrument binding exists but is not yet wired through every adapter surface.** `getInstruments`, positions, orders and quotes must all resolve canonical identity through one binding so aliases cannot diverge between reads and execution.
2. **EA snapshots still emit `instruments: []`.** The Agent must expose only MT5 properties that can be read authoritatively (digits, tick size, contract size, volume min/max/step, tick value, stops/freeze levels, etc.).
3. **Margin modelling needs care.** MT5 margin rates can depend on order type/direction and calculation mode; the current single `InstrumentSpec.marginRate` must not be populated by an arbitrary guessed scalar. This requires an explicit design/adapter decision before it is wired.
4. **Recovery chaos coverage is improved but not complete.** Still required: fuller EA-spool replay, terminal reconnect while an unknown resolver job is active and durable duplicate-command recovery across an actual agent restart boundary.
5. **No-send boundary remains intentional.** Demo `OrderSend` stays disabled until reconciliation/recovery semantics and chaos tests are strong enough, followed by MetaEditor compilation and real LiteFinance Demo validation.

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
| 2. Implementation | **IN PROGRESS** | Broker adapter, agent bridge, durable preflight, current snapshot, bounded history reconcile, strict validation, non-fill terminal recovery, crash/stale-response hardening and fail-closed symbol/instrument binding built. Instrument extraction/wiring, demo send, cancel/modify/close and final host assembly remain. |
| 3. Repository unit/static tests | **PASS at exact head** | `193bbd1...` completed `pnpm verify` successfully. MQL compilation is not covered by Linux CI. |
| 4. Integration simulation | **IN PROGRESS** | Protocol/session/recovery/reconcile components are covered; instrument binding is unit-tested but not yet wired end-to-end. |
| 5. Chaos/failure tests | **PARTIAL** | Crash, late/stale response, duplicate concurrent reconcile isolation and out-of-order snapshot rejection covered. EA spool replay/restart and reconnect-during-resolution remain. |
| 6. MetaEditor compile | **NOT VERIFIED** | Requires Windows + MetaEditor. |
| 7. Real MT5 terminal | **NOT VERIFIED** | Requires target terminal. |
| 8. LiteFinance Demo | **NOT VERIFIED** | Requires demo account/terminal. |
| 9. End-to-end demo proof | **NOT VERIFIED** | Must follow stages 6–8. |

## Next highest-priority sequence

1. Wire `Mt5InstrumentBinding` into the adapter so instruments, positions, orders and quotes share one explicit canonical identity and missing semantic metadata fails closed.
2. Add authoritative MT5 numeric instrument extraction in the EA without inventing asset class/timezone or a fake universal margin rate.
3. Resolve the margin-model mismatch explicitly before allowing the spec to drive risk sizing.
4. Add remaining restart/spool-replay/reconnect recovery tests and re-audit `RECEIVED → CHECKED → SENT → RESULT → RECONCILED` for duplicate execution and false absence.
5. Only after those gates pass, introduce a demo-only durable `SENT` + `OrderSend` boundary and classify the immediate MT5 result without inferring fill.
6. Compile in MetaEditor and validate on LiteFinance Demo before moving the product to the intelligence phase.
