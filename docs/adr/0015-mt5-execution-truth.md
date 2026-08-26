# ADR-0015 — Establishing execution truth on MetaTrader 5

**Status:** Accepted — supersedes the assumption in ADR-0007 that a venue offers a durable client order id

## Context

The production venue is LiteFinance through MetaTrader 5. MT5 does not provide the
primitive the OANDA adapter was built on, and the difference is not cosmetic.

What the MQL5 documentation actually guarantees, read directly rather than assumed:

| Mechanism | What it actually is |
| --- | --- |
| `OrderSend` returning `false` | The request did not complete *locally*. It says nothing about the server. |
| `TRADE_RETCODE_TIMEOUT` (10012) | The canonical ambiguous outcome. The trade may be live. |
| `OrderSendAsync` returning `true` | "Successful execution means only the fact of sending, but does not give any guarantee that the request has reached the trade server and has been accepted for processing." |
| `MqlTradeResult.request_id` | Assigned **by the terminal**, to correlate an async send with `OnTradeTransaction` *within one session*. It is not durable and is not known to the server. |
| `OnTradeTransaction` ordering | "Priority of these transactions' arrival at the terminal is not guaranteed." |
| `OnTradeTransaction` delivery | Queue is 1024 elements. "If OnTradeTransaction() handles yet another transaction for too long, the previous ones can be superseded by new transactions in the queue." **Events can be silently lost.** |
| `comment` | Truncated at 31 characters, and brokers may rewrite or append to it. |
| `magic` | `ulong` on the request; carried into `ORDER_MAGIC`, `POSITION_MAGIC` and `DEAL_MAGIC`, and preserved into history. |
| `DEAL_POSITION_ID` | A stable identifier shared by every deal in a position's lifetime. |

Two of these invert a load-bearing assumption from the OANDA work.

**The event stream is not a log.** OANDA's transaction stream was ordered, and gaps
could be closed exactly with `sinceid`. MT5's is explicitly unordered and explicitly
lossy. An architecture that treats `OnTradeTransaction` as the source of truth will,
on a busy morning, quietly miss a fill.

**There is no client order id.** `comment` is the field that looks like one and is
the trap: it survives just often enough in testing to look reliable, then a broker
rewrites it during a partial close and the identity is gone.

## Decision

### 1. The magic number carries intent identity

`magic` is the only field we control that is durable, machine-readable, and preserved
into history. So it carries the intent id.

```
magic = (SYSTEM_PREFIX << 47) | (truncate47(sha256(intentId)))
```

- `SYSTEM_PREFIX` is 16 bits, configured once, and identifies trades as belonging to
  this system. It is what separates our positions from ones the operator opened by
  hand in the MT5 terminal or the MetaQuotes mobile app.
- The low 47 bits are a deterministic hash of the intent id, so a retry of the same
  decision computes the same magic — exactly as `clientOrderIdFor` does today.
- The total is 63 bits, not 64, because `HistoryDealGetInteger(DEAL_MAGIC)` returns a
  **signed** `long`. Using the top bit would make our own key read as negative in
  history and compare unequal. This is the kind of detail that is free to get right
  now and expensive to discover later.

47 bits of nonce is roughly 1.4 × 10¹⁴ values. For one operator's order flow the
collision probability is not a practical concern, and a collision is detectable
(two intents resolving to one magic is an anomaly the reconciler will raise).

### 2. Truth is reconstructed from state, not received from events

The order of authority is inverted relative to the OANDA adapter:

1. **Authoritative:** a full scan of open positions, open orders, and deal history.
2. **A hint only:** `OnTradeTransaction`.

`OnTradeTransaction` is used to make reconciliation *prompt* — an event means "look
now" rather than "this happened". Nothing is ever committed to the ledger on the
strength of an event alone. Because the queue is documented to drop events under
load, a periodic full reconciliation runs regardless of whether any event arrived,
and its result is what the ledger records.

This costs a little latency on the happy path and buys correctness on the day that
matters. It also means the system is, by construction, correct about trades placed
from another MT5 client — which is not an edge case here, because the operator has
the MetaQuotes mobile app on the same account.

### 3. Resolving an ambiguous send

When `OrderSend` does not return a definite answer, the resolver asks a question that
MT5 *can* answer definitively: **does anything on this account carry our magic?**

```
search open positions   (POSITION_MAGIC == magic)
search open orders      (ORDER_MAGIC    == magic)
search deal history     (DEAL_MAGIC     == magic), over a window that
                        starts before the send and extends past it
```

- **Found** → that is the truth. Take the tickets, the fill price, the volume.
- **Not found** → absence is concluded only when every one of these holds:
  - `TERMINAL_CONNECTED` is true, so the terminal genuinely has the server's state;
  - `HistorySelect` over the covering window succeeded;
  - the negative has been observed repeatedly, with separation in time.
- **Anything else** → `UNKNOWN`, and it stays unknown. A disconnected terminal
  returning an empty history is not evidence of absence, it is absence of evidence.

This is the same contract the existing `LookupResult` type already expresses
(`found` / `found: false` with evidence / `indeterminate`), which is the strongest
signal that `BrokerPort` was abstracted at the right level rather than around OANDA.

### 4. A secondary fingerprint, because the magic may not always survive

Field reports describe brokers zeroing `magic` on some pending-order activations. We
have not verified this against LiteFinance and will not assume either way.

So at send time the agent also records a **fingerprint**: symbol, order type, volume,
and the server-time window bracketing the send. If a magic search finds nothing but a
fingerprint search finds exactly one unclaimed candidate, that candidate is reported
as a *probable* match with reduced certainty — never silently promoted to confirmed.
If the fingerprint matches more than one candidate, the system refuses to guess and
escalates to the operator.

Fingerprint matching is a fallback that degrades certainty, not a second source of
truth. The distinction is recorded on the order record so the operator can see which
evidence a position rests on.

### 5. Definite rejections

These retcodes mean the server evaluated the request and declined it. They are safe to
treat as "did not happen":

`10013` invalid request · `10014` invalid volume · `10015` invalid price ·
`10016` invalid stops · `10019` insufficient funds · `10030` unsupported filling mode ·
`10009` DONE and `10008` PLACED are the successes.

Everything else — `10012` timeout, `10031` no connection, `10004` requote,
`10018` market closed where the terminal never reached the server, `10024` too many
requests, and any `OrderSend` that returns false without a retcode — is ambiguous and
goes to the resolver.

### 6. Reconciliation runs at two tiers

Making a full history scan the primary truth mechanism invites it to be run too often,
found expensive, and then quietly downgraded — which is how a safety mechanism rots.

- A frequent **windowed** reconcile covers open positions, open orders and recent
  history. This is the one that catches ordinary divergence.
- An infrequent **full** reconcile covers complete history and exists to prove the
  windowed pass has not been systematically missing anything. It runs on boot, and its
  interval is configuration rather than a constant.

The intent→magic mapping is written to the ledger at intent creation and indexed by a
projection. The magic is a one-way hash of the intent id, so it cannot be inverted;
without that index a recovered system still recognises its own *prefix* — trades are
known to be ours — but cannot attribute them to a specific decision.

## Consequences

- Fills are observed a little later than on OANDA, because a hint must be confirmed by
  a scan before it is recorded. That is the correct trade.
- The reconciler stops being a background safety net and becomes the primary truth
  mechanism. It is promoted accordingly, and its interval becomes a first-class
  setting rather than a detail.
- Positions the operator opens by hand are first-class citizens of the model: they
  carry a foreign magic, they consume real margin, and they move real equity. They are
  reported, included in aggregate risk, and **not** managed by the system.
- `BrokerPort` gains capabilities that describe these weaknesses honestly rather than
  hiding them: whether the event stream can drop events, whether a full periodic
  reconcile is required, and whether third parties can trade the same account.

## Rejected alternatives

- **`comment` as the identity key.** Truncated at 31 characters and broker-mutable.
  It is the obvious choice and it is wrong.
- **`request_id` as the identity key.** Terminal-assigned and session-scoped; it does
  not survive a terminal restart, which is precisely when identity matters most.
- **Trusting `OnTradeTransaction` as a log.** The documentation says it drops events
  under load. Building truth on it would work in testing and fail under volume.
- **A separate order-tracking database keyed by ticket alone.** Tickets are only known
  *after* a successful send, so this answers nothing in the ambiguous case, which is
  the only case that is hard.
