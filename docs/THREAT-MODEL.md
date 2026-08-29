# Threat model

> What this system defends against, what it does not, and where its stated
> security properties are weaker than they sound. The last category is the point
> of writing this down.

---

## 1. What is being protected

In descending order of consequence:

1. **The ability to place orders.** An attacker who can send a signed order can
   empty the account, and no amount of ledger integrity helps afterwards.
2. **Broker credentials.** They outlive any single session and grant that
   ability directly, bypassing the desk entirely.
3. **The trading history.** It is the operator's only honest record of their own
   behaviour. Corrupting it destroys the ability to learn from it, quietly.
4. **Position and account confidentiality.** Real but distinctly lower: knowing
   the operator's positions is not the same as being able to move them.

## 2. Who is being defended against

| Adversary | In scope | Notes |
| --- | --- | --- |
| Someone on the same network | Yes | Coffee-shop wifi, a compromised router |
| Someone who steals the phone | Partly | See §4 |
| Someone who obtains the desk's disk | Partly | See §5 |
| A malicious npm dependency | Partly | See §6 |
| A compromised broker | No | If the broker is hostile the game is over; the reconciler will at least *notice* |
| A nation-state with device access | No | Out of scope for a personal trading app, stated plainly |
| The operator themselves | No | Single-user system; the risk governor is a commitment device, not a control against its own owner |

---

## 3. The transport

**Defended.** Every request is signed over a canonical string covering method,
path, timestamp, per-request nonce, a hash of the exact body, and the command
nonce. An attacker on the network can read traffic if TLS is absent, but cannot:

- modify a body and keep the signature valid (the hash is signed);
- redirect a signed request to a different endpoint (the path is signed);
- replay a request (the per-request nonce is remembered within the skew window);
- replay a *command* even outside that window (the server-issued command nonce is
  single-use and bound into the signature).

**Deliberate design detail:** a failed signature does *not* consume the nonce.
Otherwise an attacker who cannot forge anything could still lock the operator out
by exhausting their nonces — a denial of service requiring no key at all.

**Confidentiality is not provided by the signing scheme.** Bodies are plaintext.
The desk binds to loopback and expects to be reached over WireGuard or Tailscale;
binding wider requires an explicit flag *and* TLS, enforced as a startup failure
rather than a warning.

**Residual risk:** an operator who tunnels the port over plain HTTP anyway gets
integrity without confidentiality. The config refuses the obvious version of this
mistake but cannot prevent an external proxy from undoing it.

---

## 4. The phone

**Defended.** The private key never leaves the device. Commands require a fresh
biometric assertion, so an unlocked-but-unattended phone cannot send an order
without the operator's face or finger.

**Weaker than it sounds — two things:**

**(a) The key is only hardware-protected on some devices.** ADR-0011 originally
specified Ed25519 in the Secure Enclave. That is not achievable: Apple's Secure
Enclave supports only ECDSA P-256. The desk now accepts both and *records which
it got*. A Keychain-held Ed25519 key is encrypted at rest but readable by the app
process — so a jailbroken or malware-bearing device can exfiltrate it, and the
attacker then needs only to defeat the biometric prompt on their own hardware
(they cannot: the command nonce is server-issued, but they can request one).

**Treat a software-backed key as: possession of the phone's storage is
possession of the ability to trade.** The desk's device list shows which kind
each enrolment holds. The native enclave module is not implemented in this
repository (see `VERIFICATION.md`).

**(b) Reads are not biometric-gated.** An unlocked stolen phone can see positions
and history. This is deliberate — gating reads would mean a flaky biometric
sensor could lock the operator out of *seeing* their own exposure during a
crisis — but it is a real confidentiality exposure, mitigated only by the
device's own lock screen.

**Recovery:** re-enrol from the desk host and revoke the old device. There is no
remote wipe and no remote recovery, by design: both are attack surfaces that
exist only for convenience.

---

## 5. The desk host

**Defended.** Enrolment codes are single-use, short-lived, and consumed even on a
failed attempt so they cannot be brute-forced. There is no network endpoint that
issues them — codes are produced by the desk process itself, which means an
attacker who can reach the port still cannot enrol.

**Weaker than it sounds — two things:**

**(a) Broker credentials are not yet encrypted at rest.** ADR-0011 specifies
encryption under an operator passphrase supplied at boot and never persisted, so
that a stolen disk is not a stolen account. **That is specified and not
implemented.** The `credentialsLocked` field in the health payload is currently
hard-coded to `false`. Until it is built, treat the desk host's disk as
equivalent to the broker credentials on it. This is the most significant gap in
this document.

**(b) The ledger hash chain does not stop a determined attacker.** It detects a
modified row, a deleted row, and a truncated file — the accidental and
unsophisticated cases, which are the common ones. It does **not** stop an
attacker with write access who recomputes the whole chain from the edit forward:
the hashes are unkeyed, so anyone can produce a valid chain.

Making that hard needs an external anchor — periodically writing the head hash
somewhere the attacker does not control, so a rewritten chain diverges from a
witness. That is not implemented. The chain as it stands is tamper-*evident*
against corruption and casual editing, not tamper-*proof* against an adversary.

---

## 6. Supply chain

**Partly defended.** The dependency set is deliberately small on the desk side —
Fastify, better-sqlite3, ws, undici, pino, zod — all widely used with narrow
purposes. The lockfile pins exact versions.

**Not defended.** A malicious version of any of them runs in the same process as
the broker connection. Nothing in this system would detect it.

Mitigations available and not yet taken: `pnpm audit` in CI, a dependency review
before each upgrade, and running the desk under a restricted systemd unit (the
runbook includes one, which limits filesystem damage but not network access).

The mobile app's dependency surface is much larger — Expo, React Native, Skia,
Reanimated — and is correspondingly less reviewable. That is an accepted cost of
not writing two native apps.

---

## 7. What the system does when defence fails

Assuming an attacker gets far enough to place orders:

- Every order they place is **still subject to the risk governor**. They cannot
  exceed the per-trade cap, the daily loss limit, or the drawdown floor, because
  those are enforced on the desk and not by the client. This bounds the damage
  to roughly one day's configured loss rather than the account.
- Every order is in the ledger, with the risk decision that authorised it. The
  operator can reconstruct exactly what happened and when.
- The reconciler will notice positions the desk did not open, and raise them as
  critical divergences.

That is not a defence, but it is a meaningful containment property and it comes
free from decisions made for other reasons.

---

## 8. Assumptions this rests on

Stated so they can be checked rather than assumed:

1. The operator's phone is not already compromised at enrolment time.
2. The desk host is not already compromised at first start.
3. The enrolment code is transferred out of band (read off a screen), not over
   the same network an attacker might be watching.
4. Node's crypto primitives and the platform Keychain behave as documented.
5. The broker's API does what its documentation says — in particular that a
   client order id is durable and searchable. Where an adapter cannot guarantee
   that, it declares so and the engine disables automatic retry rather than
   risking a duplicate.
6. The operator reads a critical alert. Nothing here defends against an alert
   that arrives and is ignored — though `undeliveredCriticalAlerts` at least
   detects one that never arrived at all.

## 9. In priority order, what to fix

1. **Encrypt broker credentials at rest** under a boot passphrase. Specified,
   unimplemented, and the largest gap here.
2. **Implement the enclave signer**, so the strong key story is the real one
   rather than the fallback.
3. **Anchor the ledger head externally** — even a daily line in a file on
   different infrastructure would turn the chain from tamper-evident into
   something an attacker has to work around.
4. **`pnpm audit` in CI**, and a deliberate review on dependency upgrades.
5. **TLS by default**, so the loopback assumption is a defence in depth rather
   than the only line.
