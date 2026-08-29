# ADR-0001 — Two-tier topology: always-on desk + thin mobile client

**Status:** Accepted

## Context
The system must enforce risk and reconcile broker state even when the phone is off,
asleep, backgrounded by iOS, or out of signal. It must also never lose an order intent
to an app crash.

## Options
1. **Phone-only.** App talks directly to broker APIs. Simple, no server to run, no server
   cost, keys stay on device.
2. **Thin client + always-on desk service** the operator runs (VPS or home box).
3. **Managed cloud SaaS backend.** Rejected on brief (personal, non-commercial) and on
   principle: broker credentials in someone else's cloud.

## Decision
Option 2. A single-tenant **desk** service owns broker connectivity, the durable ledger,
the risk governor and reconciliation. The mobile app is a *view and command surface*, not
the system of record.

## Rationale
- iOS/Android background execution is not a platform on which to run a kill switch.
  Both OSes will suspend or terminate the app. A daily-loss limit that only fires when
  the app happens to be foregrounded is not a risk control.
- Order intents must be durably logged **before** transmission. A phone that dies between
  "user tapped confirm" and "broker acked" must not create an unknowable state.
- Broker credentials belong in one hardened place with a small attack surface, not on a
  device that is lost, stolen, jailbroken or backed up to a consumer cloud.
- Reconciliation is a continuous background loop. That is a server workload.

## Consequences
- The operator must run one process. Accepted: mitigated with a container image, a
  systemd unit, and a health/self-check endpoint.
- The app is useless without the desk reachable — so the app must degrade honestly:
  cached data clearly marked stale, and command surfaces disabled rather than optimistic.
- Network path is operator-controlled (VPN/Tailscale recommended, TLS required otherwise).
