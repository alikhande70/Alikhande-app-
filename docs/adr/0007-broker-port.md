# ADR-0007 — Broker abstraction and the reconciliation contract

**Status:** Accepted

## Context
The operator's venue is MetaTrader 5 through a broker. MT5 has no official retail REST
API; access is via a bridge (MetaApi-class cloud services, or a self-hosted EA/ZeroMQ
bridge). Those bridges vary in guarantees. Other venues (OANDA v20, cTrader Open API,
crypto exchanges) have different order models entirely.

## Decision
A narrow `BrokerPort` interface plus an explicit **capability descriptor**. Adapters
declare what they can actually guarantee:

```
capabilities: {
  clientOrderId: 'native' | 'emulated' | 'none'
  findByClientOrderId: boolean
  streamsFills: boolean
  atomicStopLoss: boolean          // SL/TP attached in the same request as entry
  partialFills: boolean
  serverTimeSource: 'broker' | 'local'
  positionModel: 'netting' | 'hedging'
}
```

The core **refuses** behaviours the adapter cannot support rather than emulating them
silently. Example: with `clientOrderId: 'none'`, automatic retry after an ambiguous
timeout is disabled and the operator is asked to resolve manually — because a retry
without a dedupe key can duplicate a position.

## Rationale
- The universal failure mode of broker abstractions is a lowest-common-denominator
  interface that pretends every venue behaves the same. That pretence is where duplicate
  fills and phantom stops come from.
- `atomicStopLoss` is load-bearing: if a venue cannot attach a stop in the entry request,
  there is a window where the position is naked. The system must *know* that and either
  refuse, or open with an explicit, visible "unprotected window" state and a watchdog.
- `positionModel` (netting vs hedging) changes what "close position" even means. MT5
  supports both depending on account type; getting this wrong silently reverses positions.

## Consequences
- Adapters are more work, and honest.
- Ship set: `PaperBroker` (full simulator, the default and the test substrate),
  `OandaV20Adapter`, `MetaApiMt5Adapter`. Verification status of each is tracked in
  `docs/VERIFICATION.md` — implemented is not the same as validated.
