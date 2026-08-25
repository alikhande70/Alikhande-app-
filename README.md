# Keel

A risk-governed personal trading command center for a single operator.

> **Broker truth is the only truth. Risk is enforced, not suggested.**

Keel is two things: an always-on **desk** service that owns broker connectivity,
a durable ledger and the risk governor, and a **mobile** client that is a fast,
honest view and command surface over it.

It is built for one person. It has no sign-up, no subscriptions, no social
features and no multi-tenancy, and it will refuse to send an order that breaks a
rule you set when you were calm.

---

## The three things that make it different

**It never claims to know something it does not.** A submit that times out
produces `UNKNOWN`, never "failed" — and the desk chases it by client order id
until the broker gives a definite answer. Every value on screen carries its
source and its age. Losing the socket keeps your data on screen but marks it as
last-known rather than current.

**Risk is enforced on the desk, not on the phone.** Twenty pre-committed rules
sit in front of every path to a broker, and the daily-loss kill switch fires
while you are asleep with the phone off. That is the entire reason the desk
exists as a separate always-on process.

**The ledger is the system of record.** Append-only, hash-chained, and verified
at boot; every projection is a pure function of it, and a rebuild-and-compare
proves it continuously.

---

## Start here

| Document | What it covers |
| --- | --- |
| [`docs/PRODUCT.md`](docs/PRODUCT.md) | What this is, why it exists, what it deliberately is not |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | How it fits together, and the failure model it is built around |
| [`docs/VERIFICATION.md`](docs/VERIFICATION.md) | **Honest** status of every component, and every defect found so far |
| [`docs/adr/`](docs/adr/) | 13 decision records, including the options that were rejected |
| [`docs/RUNBOOK.md`](docs/RUNBOOK.md) | Deploying, pairing, and what to do at 2am |
| [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md) | Security assumptions, including where they are weaker than they sound |

**Read `VERIFICATION.md` before trusting anything here with money.** In
particular: no broker adapter has ever sent an order to a real venue.

---

## Layout

```
packages/contracts   Wire schemas (zod). Imported by both sides, so a protocol
                     change is a compile error, not a runtime surprise.
packages/core        Pure trading domain: exact decimals, sizing, risk rules,
                     state machines, sessions. No network, no clock, no I/O.
services/desk        The always-on service: ledger, execution, reconciliation,
                     guard, market data, realtime hub.
apps/mobile          Expo / React Native client.
```

## Quick start

```sh
pnpm install
pnpm verify          # lint + typecheck + every test
pnpm desk            # run against the paper venue
```

The desk prints a one-time enrolment code on first start. There is no endpoint
that issues them — that endpoint would be a way in for anyone who can reach the
port.

See [`docs/RUNBOOK.md`](docs/RUNBOOK.md) for real deployment.

## Tests

```sh
pnpm verify                              # everything
pnpm --filter @keel/desk test:chaos      # randomized adversarial sessions
pnpm --filter @keel/desk test:live       # real network, Crypto.com public API
```

**457 tests** across the workspace: 212 core, 130 desk, 76 mobile, 19 contracts,
a 14-scenario chaos suite, and 6 live network tests. `pnpm verify` runs 451 of
them — the 6 live tests are held back because they need the network.

The chaos suite is seeded: a failure prints a seed that reproduces the run
exactly. A chaos suite that cannot be replayed is theatre.

---

## What found the bugs

Seventeen defects were found after the first working version. The source of each
is recorded in [`docs/VERIFICATION.md`](docs/VERIFICATION.md), and the pattern is
worth stating up front:

**Example-based tests found almost nothing.** Property tests, randomized chaos,
and reading the code adversarially found everything severe — including an entire
anomaly pipeline that computed correctly and discarded its results, an endpoint
that flattened the whole book when asked to close one position, and a guard that
cleared the daily loss limit if you restarted the desk after a bad morning.

Every one of them typechecked, read correctly, and did the wrong thing.
