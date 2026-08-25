# Runbook

> Operating Keel. Written for one person — you — reading it under stress, at an
> hour when nothing else is available.

---

## 0. Before anything else

Read [`VERIFICATION.md`](VERIFICATION.md). It states, without hedging, what has
and has not been proven. In particular: **no broker adapter has ever sent an
order to a real venue.** The desk runs today only against the paper venue.

---

## 1. Running the desk

The desk is one Node process. It owns your broker connection, your ledger and
your risk rules, and it must stay up — it is what enforces your limits while you
are asleep.

### Local, against the paper venue

```sh
pnpm install
pnpm verify          # lint + typecheck + every test
pnpm desk
```

It prints an enrolment code on first start when no device is paired. That code
is printed **only to the desk's own console** — there is no endpoint that hands
out enrolment codes, because that endpoint would be a way in for anyone who can
reach the port.

### Where it should actually live

A small always-on machine you control: a home box, a Raspberry Pi, or a cheap
VPS. Requirements are trivial (one core, 512MB, a few GB of disk); what matters
is that it stays up and that you control it.

**Do not expose it to the internet.** Put it on a WireGuard or Tailscale network
and reach it from your phone over that. The desk binds to loopback by default and
refuses to start on a wider interface without both an explicit opt-in and TLS:

```sh
# This will refuse to start, on purpose:
KEEL_HOST=0.0.0.0 pnpm desk

# This is the intended shape:
KEEL_HOST=127.0.0.1 pnpm desk    # reachable over your VPN only
```

### Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `KEEL_HOST` | `127.0.0.1` | Wider requires `KEEL_ALLOW_NON_LOOPBACK=true` **and** TLS |
| `KEEL_PORT` | `8787` | |
| `KEEL_DATA_DIR` | `./data` | Holds `keel.db`. Back this up. |
| `KEEL_SYNCHRONOUS` | `FULL` | fsync per commit. **Do not lower this in production.** |
| `KEEL_BROKER` | `paper` | `oanda` is implemented; `metaapi` still refuses to start |
| `KEEL_OANDA_TOKEN` | — | Required for `KEEL_BROKER=oanda` |
| `KEEL_OANDA_ACCOUNT_ID` | — | Required for `KEEL_BROKER=oanda`, e.g. `101-004-1234567-001` |
| `KEEL_OANDA_ENVIRONMENT` | `practice` | `live` additionally requires `KEEL_OANDA_ALLOW_LIVE=true` |
| `KEEL_OANDA_ALLOW_LIVE` | `false` | The deliberate second step before trading real money |
| `KEEL_REFERENCE_PROVIDER` | `none` | `cryptocom` enables the second price plane |
| `KEEL_INSTRUMENTS` | `XAUUSD,EURUSD` | Comma separated |
| `KEEL_EXPO_PUSH_TOKEN` | — | Without it, alerts are logged but never pushed |
| `ANTHROPIC_API_KEY` | — | Copilot is disabled without it |
| `KEEL_LOG_LEVEL` | `info` | |

### As a service

```ini
# /etc/systemd/system/keel.service
[Unit]
Description=Keel trading desk
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=keel
WorkingDirectory=/opt/keel
Environment=NODE_ENV=production
Environment=KEEL_DATA_DIR=/var/lib/keel
EnvironmentFile=/etc/keel/keel.env
ExecStart=/usr/bin/node services/desk/dist/main.js
Restart=always
RestartSec=5
# The desk holds broker credentials. Give it as little of the machine as it needs.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/keel

[Install]
WantedBy=multi-user.target
```

`Restart=always` is deliberate and safe: boot recovery verifies the ledger chain,
rebuilds projections, and resumes chasing any unresolved intent **before**
accepting anything new.

---


### Connecting OANDA

An OANDA practice account is free and takes a few minutes. From *Manage API
Access* in account management, generate a personal access token; the account id
is on the same screen, in the form `101-004-1234567-001`.

```sh
export KEEL_BROKER=oanda
export KEEL_OANDA_TOKEN=...
export KEEL_OANDA_ACCOUNT_ID=101-004-1234567-001
pnpm desk
```

Before pointing the desk at it, run the live suite once — it exercises the same
paths the desk will use and tells you immediately if anything about the account
is not what this adapter expects:

```sh
KEEL_OANDA_TOKEN=... KEEL_OANDA_ACCOUNT_ID=... \
  pnpm --filter @keel/desk test:live
```

Add `KEEL_OANDA_LIVE_EXECUTION=true` to also open and close a one-unit EUR/USD
position. Do that while the FX market is open, or the venue will decline the
order and the test will say so rather than fail.

Note that OANDA trades in **units**, not lots: a position is `50000` units of
EUR_USD, not `0.5`. Sizing, limits and the order ticket all work in those units.
See ADR-0014 for why.

**Going live is two steps, not one.** `KEEL_OANDA_ENVIRONMENT=live` on its own
is refused; it must be accompanied by `KEEL_OANDA_ALLOW_LIVE=true`. Read
`docs/VERIFICATION.md` first — as of this writing the adapter has not been run
against a real venue at all.

## 2. Pairing your phone

1. Build the app with EAS (`eas build --profile preview --platform ios`) and
   install it.
2. On the desk host, read the enrolment code from the console or mint one from
   operator tooling on that machine.
3. Enter it in the app. The phone generates its key, sends the public half, and
   is enrolled.

The private key never leaves the phone. Where the platform supports it the key is
generated inside the Secure Enclave and is non-extractable; otherwise it is held
in the Keychain and **the desk records it as software-only**. Check which you got
in Settings → Devices; it will not pretend.

Losing the phone: re-enrol from the desk host. There is no remote recovery, by
design.

---

## 3. Daily operation

### Starting the day

Open Pulse. If the top of the screen is empty, nothing needs you — that emptiness
is the message. Anything above the equity card is there because it could cost
money.

### Placing a trade

Trade tab → Long or Short → the ticket opens. **You set a stop, not a size.**
The desk derives the size from your risk policy and the broker's contract
specification. Write why you are taking the trade — this is required, it takes
eight seconds, and it is the note you will read when reviewing the trade.

Slide to commit. The gesture is deliberate; letting go abandons it.

### When something is refused

The ticket shows every rule that refused it, with what was observed and what the
limit was. That is not decoration: if you disagree with a refusal, the fix is to
change the rule when calm, not to override it now.

The break-glass override exists, is recorded as its own ledger event, and cannot
waive the rules that exist because the system cannot compute a safe answer.

---

## 4. When it breaks

### "Outcome unknown" on an order

**Do not resend.** The desk is querying the broker by client order id, and the
order carries a stable id so a duplicate cannot be created by resolution itself.

What to do:
1. Leave it. Resolution runs on a backoff schedule and escalates if it cannot
   conclude.
2. If it is still unknown after a few minutes, open your broker's own terminal
   and look. That is the ground truth.
3. If the broker has it, the desk will find it. If the broker genuinely does not,
   the desk will mark it `CONFIRMED_ABSENT` — and only then is it safe to place
   the trade again, as a *new* decision.

Trading is blocked while any order is unknown. That is intentional.

### "The broker disagrees with us"

A reconciliation divergence. Read the two lines: what we say, and what the broker
says. The broker is authoritative about its own book.

- `POSITION_UNKNOWN_TO_US` — you traded from the broker terminal, or the desk was
  down when it opened. Adopt it so it comes under the risk rules.
- `POSITION_UNPROTECTED` — attach a stop. Now. This one blocks trading.
- `POSITION_MISSING_AT_VENUE` / `ORDER_STATE_MISMATCH` — needs you. Check the
  broker terminal before doing anything else.

### The desk is down

The app shows *last known state*, clearly marked, and will not let you trade.
Everything you were holding is still at the broker — the desk being down does not
close anything. Restart it; boot recovery will reconcile.

### The daily loss limit fired

Positions have been closed and entries are locked until the next trading day. The
lockout releases automatically at your configured day boundary.

To release early, you have to say why — and the reason is recorded. Consider not.

### The ledger will not verify

```
ledger integrity check failed at seq N: <reason>
```

The desk refuses to start. This means the trading history has been altered or
truncated. **Do not delete the file to get going again.** Restore the most recent
backup and start from that:

```sh
cp /var/backups/keel/keel-<date>.db /var/lib/keel/keel.db
```

Then reconcile against the broker before trading: the gap between the backup and
now is exactly what reconciliation is for.

### Everything is wrong and you want out

Book tab → Flatten. It closes everything and can lock you out for a chosen
period. It retries until the venue reports flat and **tells you honestly if it
could not confirm** — if it says "check the broker terminal now", do that.

---

## 5. Backups

The ledger is your trading history and your journal. Losing it loses your ability
to review your own behaviour.

```sh
# Atomic, no external tooling, safe while the desk is running.
sqlite3 /var/lib/keel/keel.db "VACUUM INTO '/var/backups/keel/keel-$(date +%F).db'"
```

Daily, kept for a year, with at least one copy off the machine.

**Test the restore.** A backup you have never restored is a hypothesis. Restoring
into a scratch directory and starting a desk against it takes two minutes and is
the only way to know.

---

## 6. Upgrading

1. `pnpm verify` on the new version. Everything must pass.
2. Back up the ledger.
3. Stop the desk, deploy, start it.
4. Watch the boot log: it prints the chain verification result and the projection
   watermark. Both must look right before you trade.

Ledger migrations are forward-only and never rewrite history. Old events stay
replayable forever; a projection change is a projection rebuild.

---

## 7. Health

`GET /health` needs no authentication and is safe to poll:

```json
{
  "brokerConnected": true,
  "openDivergences": 0,
  "criticalDivergences": 0,
  "unresolvedOrders": 0,
  "undeliveredCriticalAlerts": 0,
  "lockout": null
}
```

Alert yourself on: `brokerConnected: false`, `criticalDivergences > 0`,
`unresolvedOrders > 0`, and `undeliveredCriticalAlerts > 0`.

That last one matters more than it looks. It means a critical alert was raised
and never reached you — a notification path that has quietly stopped working is
indistinguishable from a quiet market, right up until it isn't.

---

## 8. Running the tests

```sh
pnpm verify                              # lint + typecheck + all tests
pnpm --filter @keel/core test            # domain, incl. property tests
pnpm --filter @keel/desk test            # desk, incl. integration
pnpm --filter @keel/desk test:chaos      # randomized adversarial sessions
pnpm --filter @keel/desk test:live       # real network, Crypto.com public API
pnpm --filter @keel/mobile test          # client logic
```

The chaos suite prints a seed on failure. That seed reproduces the run exactly —
which is the whole point of it being seeded.
