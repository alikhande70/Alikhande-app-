# ADR-0011 — Security model: single operator, device-bound keys, no passwords

**Status:** Accepted

## Context
One user, one desk, broker credentials with real money behind them. Standard SaaS auth
(email + password + reset flow) is both overkill and *weaker* here — a password reset flow
is an attack surface that exists only to serve users who forget passwords.

## Decision
- **No passwords, no registration, no reset flow.**
- The desk is paired with a device once, out of band (QR / one-time enrolment code with a
  short TTL, consumed exactly once).
- The device generates a **non-extractable keypair in the Secure Enclave / StrongBox**.
  Requests are signed; the desk verifies against the enrolled public key.
- **Command** requests (anything that can move money) additionally require a fresh
  biometric assertion and carry a short-lived, single-use nonce from the desk. Replay is
  therefore impossible even with a captured request.
- Broker credentials live **only** on the desk, encrypted at rest with a key derived from
  an operator-supplied passphrase supplied at desk start (never persisted). Restarting the
  desk requires re-supplying it — deliberate: a stolen disk is not a stolen account.
- The desk binds to loopback by default. Remote access is expected via WireGuard/Tailscale.
  Direct internet exposure requires an explicit config flag, and refuses to start without
  TLS and an allowlist.

## Rationale
- Device-bound asymmetric keys remove the entire credential-theft class: there is no
  bearer secret to phish, log, or leak in a backup.
- Nonce + biometric on commands means a compromised *transport* still cannot place a trade.
- Requiring the passphrase at boot is friction the operator experiences rarely and an
  attacker experiences always.

## Consequences
- Losing the device requires re-enrolment from the desk host. Acceptable and documented.
- An unattended desk reboot cannot auto-resume broker connectivity until the passphrase is
  supplied. This is a deliberate safety property, and the desk degrades honestly: it serves
  read-only cached state and refuses commands, loudly.
