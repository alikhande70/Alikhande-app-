# ADR-0016 — The execution host, and where trading authority lives

**Status:** Accepted — refines ADR-0001, which remains correct

## Context

ADR-0001 chose a two-tier topology: an always-on desk that owns broker connectivity
and risk, and thin clients that view and command it. That decision survives the move
to MT5 unchanged, and the move makes it more obviously right, not less.

But MT5 adds a constraint OANDA did not have. OANDA was a REST endpoint on the public
internet: the desk could run anywhere. **MT5 execution requires a running MetaTrader 5
terminal on Windows.** The terminal is a GUI application; it needs a desktop session.
MQL5 sockets are outbound-only and can be opened only by Expert Advisors and scripts.
The Python `MetaTrader5` package is polling-only and also requires the terminal to be
running.

So the question the operator asked has to be answered concretely: *if the phone is away
from the desktop, where does execution authority run?*

## Decision

### Three processes, one host

```
  ┌──────────────────────── Always-on Windows host ────────────────────────┐
  │                                                                         │
  │   MetaTrader 5 terminal            Keel desk (Node)                     │
  │   ├── KeelAgent (MQL5 EA)  ──────► ledger · risk governor · guard       │
  │   │   OrderSend                    reconciler · realtime hub · HTTP     │
  │   │   OnTradeTransaction  ◄──────  commands                             │
  │   │   hard risk floor              (binds loopback)                     │
  │   └── broker credentials                                                │
  │       (never leave this host)              ▲                            │
  └────────────────────────────────────────────┼────────────────────────────┘
                                               │  WireGuard / Tailscale
                             ┌─────────────────┴─────────────────┐
                             │                                   │
                    Android app                          Windows desktop app
                    (away from desk)                     (at the desk)
```

The execution host is a **Windows machine that stays on**: either a Forex VPS or the
operator's own desktop configured to stay awake. It runs the MT5 terminal, the
KeelAgent EA inside it, and the Keel desk service beside it.

Both clients — Android and Windows desktop — are peers. Neither hosts execution.
The Windows desktop *application* may well run on the same physical machine as the
execution host, and that changes nothing: it still connects over the same API, and
closing it does not stop trading.

### Why the desk is co-located with the terminal, not in the cloud

The tempting alternative is a cloud desk with the EA dialling out to it. It is wrong
here for four reasons, in order of weight:

1. **A partition between desk and terminal is the worst possible failure.** The desk
   would believe it can trade while having no path to the venue, and the guard's kill
   switch could not flatten. Co-location makes that link loopback: it cannot partition
   without the whole host being gone, in which case nothing is pretending otherwise.
2. **Broker credentials never leave the host.** They live in the MT5 terminal, where
   the operator already put them. The desk never sees them, never stores them, and
   cannot leak them. This is strictly better than the OANDA design, where the desk
   held an API token — and it retires the "credential encryption at rest" gap that
   `THREAT-MODEL.md` currently admits to.
3. **The kill switch must work with the phone off.** That was already the reason the
   desk exists as a separate process. Putting it next to the terminal is what makes it
   actually able to act.
4. **Latency.** Loopback rather than a WAN round trip on every order.

The cost is that the desk must run on Windows. Node runs on Windows; `better-sqlite3`
runs on Windows; nothing in the existing service is POSIX-specific. This is a cheap
price for the four properties above.

### Why an MQL5 EA is the execution path

Four integration strategies were compared:

| Approach | Events | Latency | Credential exposure | Verdict |
| --- | --- | --- | --- | --- |
| **MQL5 EA** | `OnTradeTransaction` push (lossy, but prompt) | In-terminal, lowest | None — runs inside the terminal | **Chosen** |
| Python `MetaTrader5` | None. Polling only | IPC hop, poll interval | None | Secondary read path |
| Third-party cloud (MetaApi) | Push | WAN | **Broker credentials handed to a third party** | Rejected |
| File-drop bridge only | None | Filesystem poll | None | Too slow alone; retained for durability |

The EA wins on the property that matters most: it is the only component that can
execute *and* observe transactions *and* keep enforcing a risk floor when the desk is
not there. MetaApi was rejected on the credential question alone — handing a third
party the keys to the account contradicts the entire premise of a personal system, and
its outage would become the operator's outage. Convenience is not a sufficient reason
to introduce a party between the desk and the venue.

The Python package is retained as an **optional, independent read path**. Its value is
not redundancy of transport but redundancy of *implementation*: if the EA has a
serialisation bug, or the EA is removed from its chart, a second reader still sees the
account. It is never required, and it never executes.

### Transport between EA and desk: socket plus durable spool

MQL5 sockets are outbound-only, so the EA dials the desk on loopback and keeps the
connection open, polling it in `OnTimer`. That is the live channel.

Underneath it sits a **file-backed spool** in the terminal's `MQL5/Files` directory:

- The EA appends an intent record and flushes it **before** calling `OrderSend`.
- Every observed transaction is appended before being transmitted.
- On reconnect, the desk asks for everything after a watermark.

This is the same fsync-before-transmit ordering the desk's supervisor already uses,
applied one layer further out. The socket makes it fast; the spool makes it survive a
terminal crash, a desk restart, and the gap between them.

### Two layers of risk enforcement

This is new, and MT5 forces it. On OANDA the desk was the only path to the venue, so
desk-side risk was complete. Here the terminal can trade without the desk — manually,
or because the desk is down.

So risk is enforced twice, at different fidelities:

- **Desk governor** — the full rule set, explainable, with reason chains. It decides
  whether an intent may become an order.
- **KeelAgent floor** — a small, hard, independently-configured set: maximum daily
  loss, maximum open exposure, and a kill switch. It runs inside the terminal and
  keeps working when the desk is unreachable.

The floor is deliberately dumber than the governor. It is not a second opinion, it is
a backstop, and its numbers are set wider than the governor's so it fires only when
the governor is absent or has already failed.

**When the EA loses the desk it fails safe:** it accepts no new intents, and it keeps
enforcing the floor. It does not fall back to trading on its own judgement, because it
has none.

### Positions the system did not open

The operator can trade this account from the MT5 desktop terminal or the MetaQuotes
mobile app. Those positions carry a foreign magic and are treated as first-class
facts:

- They are **reported** — the operator sees them, marked as not ours.
- They are **counted** in aggregate exposure, margin and equity, because they really
  do consume all three.
- They are **not managed**. The system does not modify or close what it did not open.

The one hard question is the kill switch: when the daily-loss floor fires, does it
flatten foreign positions too? It is the operator's account and their loss limit, but
those are deliberate trades made elsewhere. **Default: flatten ours, alert loudly
about theirs, and require an explicit opt-in to flatten foreign positions.** Silently
closing a trade the operator placed by hand would be the system exceeding its mandate;
silently ignoring it while the account bleeds would be the system failing its mandate.
The operator decides which, once, in configuration — and the setting is shown in the
runbook rather than buried.

## Amendments from the adversarial review

`DESIGN-REVIEW-mt5.md` attacked this ADR immediately after it was accepted. Five of
its findings change what is specified above.

**The floor wins arbitration.** When the EA's hard floor and the desk's governor
disagree, the floor is obeyed. It is closer to the venue, and its entire purpose is to
act when the governor cannot be trusted to be present. The floor is a coarse backstop
with deliberately wider numbers — it is emphatically **not** a second implementation of
the governor's rules, and if it ever grows toward being one, that is a defect.

**Agent absence is detected, not assumed.** The EA emits a heartbeat. Missed
heartbeats past a threshold put the desk into a hard no-execution-path state: order
entry blocked, critical alert raised, both clients showing it plainly. An EA can vanish
simply because a chart was closed, and that must never look like a quiet market.

**An external liveness watchdog is a first-class component.** Co-locating everything on
one host means that when the host dies, the alerting dies with it — and silence is
indistinguishable from calm. A minimal external watchdog holds no credentials, no
account data and no execution authority; it knows only whether the host checked in, and
pushes to the phone when it stops. This preserves co-located execution authority while
removing the silent-death failure mode.

**Resuming after an outage is not the same as starting.** Boot classifies the gap since
the last known-good state. A short gap reconciles and resumes. A long gap, or one
crossing a day boundary, reconciles and then **holds trading until the operator
acknowledges what changed while the system was blind.**

**Server time is observed, never configured.** The agent reports the broker's
server/UTC offset with every snapshot. Day boundaries are defined in the operator's
zone and translated; the server's offset is never assumed to match anything.

## Consequences

- A Windows host that stays on is now a **first-class, documented component** with its
  own runbook section, not an implicit assumption. If it is off, there is no trading —
  and the clients say so plainly rather than appearing functional.
- The desk gains a Windows deployment path (service wrapper, autologon, terminal
  autostart) alongside the existing systemd unit.
- `THREAT-MODEL.md` improves: the desk no longer holds broker credentials at all.
- A new failure mode exists that OANDA did not have — **EA present, desk down** — and
  it is handled explicitly by the floor rather than left undefined.
- The system must tolerate being one of several clients on the account, permanently.
- A minimal external watchdog must be deployed somewhere other than the execution host.
- Boot is now a two-mode operation — resume, or hold for acknowledgement.

## Rejected alternatives

- **Desktop application as the execution host.** Explicitly rejected: closing the UI
  would end trading. UI lifecycle and execution lifecycle are separated precisely so
  that quitting a window is never a trading decision.
- **Cloud desk, EA dials out over TLS.** Introduces a partition on the most critical
  link, and puts the kill switch on the far side of it.
- **Python as the execution path.** Polling-only means fills are noticed on an
  interval rather than on an event, and it still requires the terminal — so it carries
  the Windows dependency without the compensating benefit.
- **Running MT5 under a service wrapper with no desktop session.** Possible with
  third-party tooling, but the terminal is not built for it and the failure modes are
  poorly documented. Autologon plus autostart is better understood and easier to
  verify, and verification is the point.
