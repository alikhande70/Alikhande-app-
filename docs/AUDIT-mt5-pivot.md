# Repository audit after the LiteFinance/MT5 pivot

The venue changed from OANDA v20 to LiteFinance via MetaTrader 5, and the product
gained a second first-class client. This is the component-by-component decision about
what survives, in the categories the operator asked for.

The headline: **the domain layer survives untouched.** 6,637 lines of `packages/core`
contain no venue-specific code — a grep for OANDA or Crypto.com across it returns one
doc comment that mentions MT5 first. That was the point of building it that way, and
it is now being collected.

What did *not* survive contact with MT5 is narrower and more interesting than "the
broker adapter": it is the assumption that a venue hands you a durable client order id
and an ordered event log. Both were encoded in exactly one place each.

---

## KEEP — correct as written, no change required

| Component | Why it survives |
| --- | --- |
| `core/money/decimal.ts` | Exact decimal arithmetic. MT5 quotes doubles, which makes this *more* necessary: every value crossing the boundary is parsed to `Dec` at the edge. |
| `core/market/instrument.ts` | `InstrumentSpec` was modelled on MT5 `SymbolInfo*` from the beginning — `stopsLevel`, `freezeLevel`, `contractSize`, `tickValueAccount` are MT5 concepts. The OANDA adapter was the one that had to bend to fit. |
| `core/market/fx.ts` | Conversion with per-hop staleness. Unchanged. |
| `core/market/sizing.ts` | Rounds volume down, cross-checks tick value against contract-size maths. This is the MT5 lot model and always was. |
| `core/time/zone.ts`, `sessions.ts` | DST-correct session and day boundaries. MT5 server time makes this harder, not different. |
| `core/risk/*` | Governor, drawdown models, policy. Venue-neutral by construction. |
| `core/analytics/performance.ts` | R-multiples, expectancy, SQN. Venue-neutral. |
| `desk/ledger/*` | Hash-chained append-only ledger, projections, rebuild-and-verify. |
| `desk/realtime/hub.ts` | Sequenced snapshot/delta with gap detection. Now serves two clients instead of one — which is what it was designed for. |
| `desk/http/auth.ts` | Device-bound signing, nonces, replay protection. |
| `desk/sim/*` | `TestClock`, seeded `Rng`. The substrate for every deterministic test. |
| `core/execution/orderState.ts` | **The certainty model is vindicated.** `confirmed / in-flight / unknown / local`, local-commands-refusable vs venue-facts-never-refusable, and the terminal-exit escalation all apply unchanged to MT5. MT5 needs *more* of this, not less. |

## REFACTOR — right shape, needs MT5's truths added

| Component | Change |
| --- | --- |
| `desk/broker/port.ts` | Add capabilities that describe real weaknesses instead of hiding them: `eventStreamLossy`, `requiresPeriodicFullReconcile`, `thirdPartyTradingPossible`. OANDA sets all three false; MT5 sets all three true. The capability descriptor was built for exactly this and has never been exercised by a venue that needed it. |
| `core/execution/reconcile.ts` | Promoted from background safety net to **primary truth mechanism**. The divergence kinds already cover foreign positions and unprotected positions; what changes is its authority and cadence, not its logic. |
| `desk/engine/guard.ts` | Gains a "desk-down" counterpart. The guard keeps the rich rules; a hard floor moves into the EA (ADR-0016). Also needs the foreign-position flatten policy. |
| `desk/engine/resolver.ts` | Same contract, new evidence source: magic-number search across positions, orders and history instead of an HTTP lookup by client id. |
| `desk/config.ts` | Multi-adapter configuration; Windows paths; MT5 terminal data directory. |

## GENERALIZE — extract so both clients share it

| Component | Change |
| --- | --- |
| `apps/mobile/src/api/*` (client, signing, socket, signer) | Extract to `packages/client`. None of it is mobile-specific; the desktop needs all of it, and a second implementation would be a second set of bugs. |
| `apps/mobile/src/store/desk.ts` | Extract to `packages/client`. `canTrade`, `dataAgeMs` and the certainty semantics must be identical on both devices. |
| `apps/mobile/src/design/tokens.ts` | Split: shared **values** (scales, palette, certainty semantics), per-platform **primitives**. |
| `desk` service | Becomes the execution host core; gains a Windows deployment path beside the systemd unit. |

## REPLACE

| Component | Replaced by | Why |
| --- | --- | --- |
| Crypto.com as the reference price plane | **OANDA practice as the FX/metals reference plane** | Crypto.com cannot price XAUUSD or EURUSD. The divergence monitor was therefore inert for every instrument actually being traded. OANDA's practice API is free, already implemented, already tested, and prices exactly these instruments. |

## KEEP AS REFERENCE — not production, but not deleted

**The OANDA adapter stays.** Three concrete reasons, none of them sentimental:

1. **It becomes the independent reference price plane.** This is a real production
   job, not a museum piece. MT5 gives one price feed — the broker's own — and a
   single-source feed cannot be checked against anything. OANDA practice gives an
   independent second opinion on EURUSD and XAUUSD, which is what the divergence
   monitor was built for and has never had.
2. **It is the control case for the abstraction.** OANDA has strong client-order-id
   semantics; MT5 has none. Keeping both proves `BrokerPort` is not quietly
   MT5-shaped. If a future change makes the port impossible to implement for OANDA,
   that is a design smell worth catching.
3. **Its 86 tests still pass and cost nothing to keep.**

It is marked non-production in `VERIFICATION.md`, and `KEEL_BROKER=oanda` remains
available for execution but is not the default.

## REMOVE

Nothing. No component became wrong — one became misapplied (Crypto.com as an FX
reference), and it retains its value for crypto instruments if ever needed.

A destructive rewrite here would be pure loss: the parts that look OANDA-specific are
a single adapter directory, and the parts that look generic genuinely are.

## NEW — required by the pivot

| Component | Purpose |
| --- | --- |
| `agent/KeelAgent.mq5` | Terminal-side execution agent: `OrderSend`, `OnTradeTransaction`, durable spool, hard risk floor. |
| `desk/broker/mt5/*` | Desk-side adapter speaking to the agent over loopback socket + spool. |
| `packages/client` | Shared client layer for both apps. |
| `apps/desktop` | Tauri 2 + React Windows application. |

## EXPERIMENTAL ONLY

| Component | Status |
| --- | --- |
| AI copilot (ADR-0010) | Still designed, still unbuilt, endpoint still returns 503. The architectural separation it specifies — deterministic truth vs AI interpretation — is now reinforced by ADR-0015: AI reads projections, never the venue, and never writes execution state. |
| Python `MetaTrader5` read path | Optional independent verification reader. Never required, never executes. |

---

## What the pivot revealed about the original design

Two things were built better than they needed to be for OANDA, and MT5 collects on
both:

- **The certainty axis** (`confirmed / in-flight / unknown / local`) was arguably
  over-engineering against a venue that answers definitively. Against MT5, where the
  event stream is documented to drop events, it is the minimum viable model.
- **`BrokerPort`'s capability descriptor** existed to stop adapters from pretending.
  Until now every adapter could honestly claim every capability. MT5 is the first
  venue that must admit to real weaknesses, which is the first time the mechanism has
  done any work.

And one thing was wrong and the pivot exposed it:

- **The reference price plane was pointed at an exchange that cannot price the
  instruments being traded.** That was a latent defect independent of the venue
  change — the divergence monitor could never have fired for XAUUSD or EURUSD. It is
  recorded in `VERIFICATION.md` as a defect found by architecture review.
