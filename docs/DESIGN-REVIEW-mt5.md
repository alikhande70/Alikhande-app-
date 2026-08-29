# Adversarial review of the MT5 architecture

Written against ADR-0015, ADR-0016 and ADR-0017 immediately after accepting them, on
the assumption that they were produced by someone else and contain defects. Twelve
attacks; seven changed the design.

---

### 1. The agent dies silently when a chart is closed — **CHANGED**

An MQL5 EA runs attached to a chart. Close the chart, switch profile, or let the
terminal restore a different template, and the agent is gone. `OrderSend` stops
working and — worse — nothing announces it. The desk would sit there believing it has
an execution path.

**Change:** the agent emits a heartbeat on a fixed interval. Missing heartbeats past a
threshold puts the desk into a hard "no execution path" state: order entry blocked,
a critical alert raised, and both clients showing it plainly. Absence of the agent is
now an actively detected condition rather than an assumption. This also promotes the
optional Python reader from a nicety to something genuinely useful: it can distinguish
*terminal down* from *terminal up but agent missing*, which are different problems with
different fixes.

### 2. Magic-prefix collision with another EA — **no change, already covered**

If the operator runs some other EA that happens to use a magic inside our prefix, we
would adopt its trades as ours.

The existing reconciler already handles this: a position carrying our prefix with no
matching local intent is `UNSOLICITED_STATE`, which is a critical anomaly, not a
silent adoption. The prefix is operator-configurable so a collision can be resolved.
Worth verifying explicitly in a test rather than trusting the analysis.

### 3. The magic is a hash — you cannot invert it to find the intent — **CHANGED**

`magic = f(intentId)` is one-way. Reconciliation finds a magic on a position and needs
the intent behind it.

**Change:** the intent→magic mapping is written to the ledger at intent creation and
indexed by a projection, exactly as `clientOrderId` already is. Recovery from a lost
ledger still recognises the *prefix* — so trades are known to be ours — but cannot
attribute them to a specific decision. That degradation is acceptable and is now
documented rather than discovered.

### 4. The EA's hard floor is a second implementation of the risk rules — **CHANGED (clarified)**

This looked like hypocrisy: ADR-0017 forbids two implementations of the risk rules
across clients, then ADR-0016 puts risk logic in MQL5.

The distinction is real but was not stated. The floor is **not** a second opinion on
the same rules — it is a coarse backstop with deliberately wider numbers, designed to
disagree with the governor only when the governor is absent. If it tried to replicate
the twenty-rule governor in MQL5, that *would* be the defect this review was looking
for.

**Change:** ADR-0016 now says this explicitly, and adds the arbitration rule — **when
the floor and the governor disagree, the floor wins**, because it is closer to the
venue and its whole purpose is to act when the governor cannot be trusted to be there.

### 5. If the Windows host dies, everything dies — including the alerting — **CHANGED**

The strongest attack on co-location. A cloud desk would at least survive the host and
tell the operator it had lost contact. With everything on one host, the failure is
total *and silent*: the phone simply stops receiving updates, which is
indistinguishable from a quiet market.

**Change:** a small **external liveness watchdog** is added as a first-class
component. It holds no credentials, no execution authority, and no account data — it
only knows whether the host checked in, and pushes an alert to the phone when it stops.
This keeps the execution authority co-located (which attack 5 does not dispute) while
removing the silent-death failure mode. It is the cheapest possible component that
fixes the most dangerous consequence of the topology.

### 6. Resuming after a long outage is not the same as starting up — **CHANGED**

Windows reboots for updates. The host may be down for hours. On restart the desk would
reconcile and carry on — but the world moved: positions may have been stopped out,
the day may have rolled, the daily loss anchor may be meaningless.

**Change:** boot now classifies the gap. A short gap reconciles and resumes. A gap past
a threshold, or one spanning a day boundary, reconciles and then **holds trading until
the operator acknowledges**, presenting what changed while the system was blind.
Resuming automatically after an unknown interval is exactly the kind of confident
guess this system exists to avoid.

### 7. Two clients, two intents, one decision — **CHANGED**

Idempotency deduplicates the *same* intent. It does nothing about the operator tapping
buy on the phone and then again on the desktop: two different intent ids, two genuine
orders, double the risk. The two-client design created this and nothing in ADR-0017
addressed it.

**Change:** a near-duplicate detector in the desk. A second intent matching an existing
one on symbol, side and approximate size inside a short window is held and must be
explicitly confirmed as deliberate, naming the device that sent the first. Deliberate
scaling-in is still possible; accidental double-entry across devices is not.

### 8. Broker server time is not UTC and not the operator's zone — **CHANGED**

LiteFinance's server runs its own offset, typically GMT+2/+3 with its own DST rules,
and MT5 timestamps are in server time. Session logic, daily-loss day boundaries and
history windows all depend on getting this right, and `zone.ts` reasons in IANA zones.

**Change:** the agent reports the server/UTC offset with every snapshot, and it is
treated as observed data rather than configuration. The daily boundary is defined in
the operator's chosen zone and *translated*, never assumed to match the server's. This
is the same class of bug as the FX 150× trap and deserves the same treatment.

### 9. Symbol names are broker-specific — **no change, already a principle**

`XAUUSD`, `XAUUSD.m`, `GOLD` are all real. The adapter reads the symbol list from the
terminal and never hardcodes, which `InstrumentSpec` was already built for.

### 10. The desktop app runs on the execution host — does it get a free pass? — **no change**

It must not. Same device-bound signing, same authentication, same command nonces. "It
is on localhost" is not authentication, and the moment it becomes one the security
model has a hole with a convenient excuse attached.

### 11. Full history scans are expensive at reconciliation cadence — **CHANGED**

ADR-0015 makes full reconciliation the primary truth mechanism, then implies running it
frequently. Scanning entire deal history every few seconds is wasteful and will get
quietly downgraded by a future change, which is how a safety mechanism rots.

**Change:** two tiers. A frequent **windowed** reconcile covering open positions, open
orders and recent history, and an infrequent **full** reconcile over the complete
history that proves the windowed one has not been missing anything. The full pass is
the one that would catch a systematic error, so its interval is configuration, not a
constant, and it runs on boot.

### 12. `TRADE_RETCODE_MARKET_CLOSED` and friends are not all definite — **no change, but sharpened**

Some retcodes look definite but describe local state — the terminal refusing before
reaching the server. The classification in ADR-0015 already routes anything not on the
explicit definite list to the resolver, which is the correct default. Worth an explicit
test per retcode rather than trusting the list, mirroring what was done for OANDA's
HTTP statuses.

---

## Net effect on the design

Seven changes, of which three are structural: the liveness watchdog, the outage-gap
acknowledgement, and the cross-device duplicate detector. None of them contradicts the
ADRs; all three close failure modes that would otherwise have been discovered in
production, and two of them (5 and 7) are consequences of decisions made *in this
round* rather than inherited.

The review did not find a reason to move execution authority off the co-located host,
which was the decision most at risk of being wrong.
