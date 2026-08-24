# Keel

A risk-governed personal trading command center for a single operator.

> **Broker truth is the only truth. Risk is enforced, not suggested.**

Keel is a two-tier system: an always-on **desk** service that owns broker connectivity,
the durable ledger and the risk governor, and a **mobile** client that is a fast, honest
view and command surface over it.

It is built for one person. It has no sign-up, no subscriptions, no social features and no
multi-tenancy, and it will refuse to send an order that breaks a rule you set when calm.

## Start here

| Document | What it covers |
| --- | --- |
| [`docs/PRODUCT.md`](docs/PRODUCT.md) | What this is, why it exists, what it deliberately is not |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | How the system fits together, and the failure model |
| [`docs/VERIFICATION.md`](docs/VERIFICATION.md) | **Honest** status of every component: what is tested and what is not |
| [`docs/adr/`](docs/adr/) | Architecture decision records, with the options that were rejected |
| [`docs/RUNBOOK.md`](docs/RUNBOOK.md) | Deploying, operating, and what to do when it breaks |
| [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md) | Security assumptions and their limits |

## Layout

```
packages/contracts   Wire protocol + shared schemas (zod). One source of truth.
packages/core        Pure trading domain: decimals, sizing, risk rules, state machines.
services/desk        The always-on service: ledger, execution, reconciliation, guard.
apps/mobile          Expo / React Native client.
```

## Quick start

```sh
pnpm install
pnpm verify          # lint + typecheck + all tests
pnpm desk            # run the desk against the paper broker
```

See [`docs/RUNBOOK.md`](docs/RUNBOOK.md) for real deployment.
