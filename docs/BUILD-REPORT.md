# Build report — GPT implementation branch

This report records work actually implemented on `gpt/trading-brain-build`. Architecture documents describe intent; this file describes delivery state. The preserved Claude branch is not modified by this work.

## Current state — 2026-08-27

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
- A fail-closed **instrument binding layer** separates numerical execution facts from semantic metadata that cannot safely be inferred from MT5 symbol names.
- The same binding is now wired through **instruments, positions, orders, quotes, order submission and recovery context**. A broker suffix such as `XAUUSD.x` cannot silently become a second identity on one adapter surface while another surface uses `XAUUSD`.
- Order submission fails closed if the request's canonical identity conflicts with the configured venue-symbol binding. Recovery returns indeterminate on the same conflict instead of reconciling against the wrong instrument.
- Missing semantic instrument metadata (`assetClass`, `base`, `quote`, `venueTimeZone`) blocks `InstrumentSpec` construction rather than generating a plausible value. Host-supplied semantic fields are deliberately not trusted by this binding layer.

### Latest repository verification

- Exact code/test head `bb0930bc936bf380dd7898bc2ee96cc63e6ccef0` completed GitHub Actions workflow `verify` successfully.
- The workflow ran Biome lint, TypeScript typecheck and all repository tests.
- During this change CI caught three real integration/hygiene issues before success: old adapter tests had not injected the newly required binding, a type-only import was incorrect, and the new alias regression test violated lint/format rules. All were repaired and re-run to exact-head success.
- Repository verification supports the TypeScript/static/test claims above. It does **not** prove MQL compilation or a real MT5 runtime.

### Self-audit findings still open

## Independent audit, 2026-08 (`docs/AUDIT-2026-08-repository.md`)

Six defects were found and fixed on this branch; two were found and deliberately not
fixed because the correct repair depends on decisions below.

**Fixed** — each with a regression test verified to fail without it:

| Severity | Defect |
| --- | --- |
| P0 | Duplicate execution reported as a clean fill: the exact-magic path confirmed without grouping by position, while the weaker fingerprint path did group. Two positions under one magic surfaced as one order. |
| P0 | Agent emitted broker-local time where the desk expected UTC. On a server ahead of UTC no ambiguous send is ever resolvable; on a server behind UTC **false absence** becomes possible. |
| P0 | `isLive()` used a one-sided age check, so a heartbeat stamped hours ahead passed trivially and a dead agent read as live for the length of the timezone offset. |
| P1 | Recovery used `matches[0].volume`, understating a multi-deal fill. |
| P1 | Two venue symbols could resolve to one canonical; `getQuote` resolves by first match, so sizing could price one instrument off another's book. |
| P1 | Retcodes 10040–10046 fell through to ambiguous, producing unresolvable UNKNOWNs for definite server rejections. |

**Found, not fixed** — see the audit for the recommended migration:

- `instrumentFacts` is parsed and validated but consumed by nothing, while `instruments`
  (which `getInstruments()` reads) is always empty. The binding layer currently binds
  nothing.
- `InstrumentSpec.marginRate` remains a static scalar MT5 does not actually provide.

The branch head also failed `pnpm verify` on a formatting error, meaning it was pushed
red through the same command CI runs.

---

1. **EA snapshots still emit `instruments: []`.** The Agent must expose only MT5 properties that can be read authoritatively (digits, tick size, contract size, volume min/max/step, tick value, stops/freeze levels, etc.).
2. **The current single `InstrumentSpec.marginRate` is not a safe MT5 execution truth.** MetaTrader exposes request-specific margin calculation via `OrderCalcMargin`; required margin depends on the proposed order and current trading environment. Do not populate a guessed universal scalar from the symbol name or a convenient default. The MT5 risk path needs an explicit request-specific margin-calculation boundary before margin-sensitive sizing is trusted.
3. **Recovery chaos coverage is improved but not complete.** Still required: fuller EA-spool replay, terminal reconnect while an unknown resolver job is active and durable duplicate-command recovery across an actual agent restart boundary.
4. **No-send boundary remains intentional.** Demo `OrderSend` stays disabled until reconciliation/recovery semantics and chaos tests are strong enough, followed by MetaEditor compilation and real LiteFinance Demo validation.

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
| 2. Implementation | **IN PROGRESS** | Broker adapter, agent bridge, durable preflight, current snapshot, bounded history reconcile, strict validation, non-fill terminal recovery, crash/stale-response hardening and adapter-wide fail-closed symbol/instrument binding built. Instrument extraction, request-specific MT5 margin calculation, demo send, cancel/modify/close and final host assembly remain. |
| 3. Repository unit/static tests | **PASS at exact code/test head** | `bb0930bc...` completed `pnpm verify` successfully. MQL compilation is not covered by Linux CI. |
| 4. Integration simulation | **IN PROGRESS** | Protocol/session/recovery/reconcile components plus adapter-wide alias consistency are covered; EA instrument extraction is not yet end-to-end. |
| 5. Chaos/failure tests | **PARTIAL** | Crash, late/stale response, duplicate concurrent reconcile isolation and out-of-order snapshot rejection covered. EA spool replay/restart and reconnect-during-resolution remain. |
| 6. MetaEditor compile | **NOT VERIFIED** | Requires Windows + MetaEditor. |
| 7. Real MT5 terminal | **NOT VERIFIED** | Requires target terminal. |
| 8. LiteFinance Demo | **NOT VERIFIED** | Requires demo account/terminal. |
| 9. End-to-end demo proof | **NOT VERIFIED** | Must follow stages 6–8. |

## Next highest-priority sequence

1. Add authoritative MT5 numeric instrument extraction in the EA without inventing asset class/timezone or a fake universal margin rate.
2. Introduce a request-specific MT5 margin-calculation boundary based on the proposed order rather than forcing one static rate into broker truth; keep existing core assumptions isolated until that contract is proven.
3. Add remaining restart/spool-replay/reconnect recovery tests and re-audit `RECEIVED → CHECKED → SENT → RESULT → RECONCILED` for duplicate execution and false absence.
4. Only after those gates pass, introduce a demo-only durable `SENT` + `OrderSend` boundary and classify the immediate MT5 result without inferring fill.
5. Compile in MetaEditor and validate on LiteFinance Demo before moving the product to the intelligence phase.
