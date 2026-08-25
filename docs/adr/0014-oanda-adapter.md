# ADR-0014 — OANDA v20 as the first real broker adapter

**Status:** Accepted

## Context
Until now the only working adapter was the paper venue. Every safety mechanism in the
system — ambiguous-outcome classification, unknown-outcome resolution, reconciliation —
was exercised against a simulation that this codebase also wrote. That is a closed loop:
the simulator and the adapter shared my assumptions, so neither could disprove them.

A real venue was needed. The candidates were MT5 through a bridge (MetaApi or a
self-hosted EA), cTrader Open API, and OANDA v20.

## Decision
OANDA v20, practice environment first.

The deciding factor was not popularity or breadth of instruments. It was that v20
supports **native, addressable client order ids**: `clientExtensions.id` survives the
round trip, and both orders and trades can be fetched back by that id with an `@`
prefix. That is precisely the primitive an ambiguous send needs — the ability to ask the
venue "do you have this?" and get an answer that is evidence rather than inference.

`supportsSafeRetry` is therefore true for this adapter, and the engine is allowed to
retry. Against a venue without that primitive it would not be, and the operator would
have to resolve every timeout by hand.

Three further properties made it the right first choice:

- Every number is transmitted as a **string**, so exact decimals survive the wire.
  A venue that sends JSON floats would corrupt prices before this system ever saw them.
- Stops can be attached in the same request as the entry (`stopLossOnFill`), so
  `atomicStopLoss` is genuinely true and a new position is never briefly naked.
- Transactions stream, and there is a `sinceid` endpoint to replay what a dropped
  stream missed.

## The id migration, and why the lookup checks two places
When a market order fills, the client id ceases to identify a live order and instead
identifies the **trade** that the fill opened. An adapter that looks only at
`/orders/@id` will get a 404 for an order that filled perfectly well, and would report a
real, open position as never having existed.

So the adapter sets `clientExtensions` **and** `tradeClientExtensions` to the same value
on submission, and `findByClientOrderId` checks `/orders/@id` and then `/trades/@id`
before concluding anything. Absence requires a clean 404 from both.

## Units, not lots
OANDA has no lot. It trades in units of the base currency — 12,345 units of EUR_USD is
a valid order — and metals are quoted in ounces.

So `contractSize` is **1** for every OANDA instrument, and our `volume` is denominated
in the venue's own units.

The alternative was to impose the MT5 convention that one lot is 100,000 units. That
would have required inventing a contract size per asset class — is silver 5,000 ounces
per lot, or 1,000? — and then rounding every computed position onto a grid the venue
does not actually impose. Guessing a contract size is guessing the size of every future
position, which is not a guess this system is willing to make.

The upside is real: a risk budget converts to a position at unit precision instead of
0.01 lots, so the sized position matches the intended risk far more closely than a
lot-based venue permits.

`tickValueAccount` is left undefined, because OANDA does not report one. The core
already derives it through an FX conversion and refuses to size when no conversion path
exists; synthesising a value here would bypass that refusal.

## What counts as a rejection
Only a response in which OANDA evaluated the request and declined it:

- HTTP 400, 401, 403, 404, 405, 422 — validation, authentication and authorisation are
  all decided before the request reaches execution.
- HTTP 201 carrying an `orderCancelTransaction` and no fill — typically a FOK market
  order that could not be filled in full. The venue considered it and said no.

Everything else is **ambiguous**: timeouts, socket errors, 429, every 5xx, and any body
that cannot be parsed — including on a 2xx, where the order may well have filled and the
response simply cannot tell us.

The ordering inside a successful response is itself a safety property. A fill is
inspected **before** a cancellation, because an IOC order that fills part of its size
returns both, and reading the cancel first would report a live position as a rejection.

## Live trading needs a second, separate acknowledgement
`KEEL_OANDA_ENVIRONMENT=live` alone is refused. It must be accompanied by
`KEEL_OANDA_ALLOW_LIVE=true`.

This mirrors `assertSafeExposure`, and for the same reason: a desk exposed to the
internet and a desk trading real money are both states you should never arrive at by
editing one line and forgetting.

## Consequences
- The adapter's read paths, execution paths and recovery paths can all be validated
  against a real venue that costs nothing to be wrong on.
- MT5 remains unimplemented. Instruments OANDA does not list cannot be traded.
- Two OANDA behaviours remain assumptions until the live suite is run against a real
  practice account: that `ClientID` accepts our `k-` prefixed base32 ids unchanged, and
  that a filled market order's id is reliably addressable as a trade. Both are recorded
  in `docs/VERIFICATION.md` rather than being treated as settled.

## Rejected alternatives
- **MetaApi (MT5 bridge).** Closest to the operator's existing terminal, but adds a
  third party between the desk and the venue, and its client-id support is emulated
  through a comment field that can be truncated.
- **cTrader Open API.** Good protocol, but protobuf over TCP is a much larger surface
  to get right than newline-delimited JSON over HTTPS.
- **Crypto exchange first.** Already have live-verified market data from Crypto.com, but
  a perpetual-futures venue would not exercise the FX conversion and session logic that
  most of this core is about.
