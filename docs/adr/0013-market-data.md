# ADR-0013 — Market data: separate the price plane from the execution plane

**Status:** Accepted

## Context
Broker feeds are the correct source for *executable* prices (they are what you actually
trade against, spread included). But broker bridges are also the least reliable link, and
during a bridge outage the operator still needs to see the market to manage risk.

## Decision
Two independently-sourced planes:

- **Execution plane** — quotes from the broker adapter. The only prices used for order
  validation, sizing, margin and P&L. Always tagged `source: 'broker'`.
- **Reference plane** — an independent market-data provider used for charts, alerts and
  context when the broker feed is degraded. Always tagged `source: 'reference'` and
  **rendered differently**; the UI never lets a reference price masquerade as executable.

A `divergence` monitor compares the two and raises an alert when they disagree beyond a
configured threshold — which is itself a useful signal (broker feed stuck, bridge lagging,
or a genuine venue dislocation).

## Rationale
- The failure this prevents is the worst kind of stale data: a frozen broker feed that
  *looks* live because it is still connected. A second, independent opinion catches it.
- Separating the planes also makes the honest thing easy: the app can keep charting during
  a broker outage while *disabling order entry*, instead of the usual choice between
  "blank screen" and "trade against unknown prices".

## Ship set
- `CryptoComPublicProvider` — reference plane, no credentials required, **verified live
  from the build environment** (REST + WS). Serves as the reference implementation and the
  live integration test target.
- `ReplayProvider` — deterministic replay of recorded ticks/bars; the substrate for chaos
  and regression tests.
- `SyntheticProvider` — seeded random-walk generator with configurable regime, gaps,
  spread widening and freezes; used to test staleness handling.
- Broker-native quotes via each `BrokerPort` adapter for the execution plane.

## Consequences
- Two feeds to run and reconcile. Accepted: the divergence monitor turns that cost into a
  feature.
- FX/metals reference data requires a credentialed provider the operator supplies; the
  provider interface is small and documented, and its verification status is tracked
  honestly in `docs/VERIFICATION.md`.
