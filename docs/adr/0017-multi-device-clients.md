# ADR-0017 — Two first-class clients: Android and Windows

**Status:** Accepted — extends ADR-0002, which chose the mobile stack

## Context

The product now has two equally important interfaces. The instruction was explicit:
do not build a phone app and stretch it onto Windows, and do not build a terminal and
shrink it onto Android.

That is a real risk in both directions. A React Native app rendered on Windows would
be a phone screen on a 32-inch monitor. An Electron terminal squeezed onto Android
would be a desktop grid nobody can hit with a thumb.

The question is what should actually be shared. "Share everything" produces a
lowest-common-denominator UI. "Share nothing" produces two systems that disagree about
the account.

## Decision

**Share the truth. Do not share the interface.**

```
              packages/core          exact decimals, sizing, FX, sessions,
              (pure domain)          risk rules, order state machine,
                     │               reconciliation, analytics
                     ├── packages/contracts   wire schemas (zod)
                     ├── packages/client      API client, signing, socket,
                     │                        store, certainty semantics
                     │
        ┌────────────┴────────────┐
        │                         │
   apps/mobile               apps/desktop
   Expo / React Native       Tauri 2 + React DOM
   Android                   Windows
   own components            own components
   own navigation            own layout engine
   Skia charts               canvas/WebGL charts
```

Everything above the split is one implementation with one set of tests. Both clients
compute the same risk verdict from the same rules, because it is the same code — which
is what makes it impossible for the phone and the desktop to disagree about whether a
trade is allowed.

Everything below the split is written for its device. No shared components, no shared
layout, no responsive-breakpoint compromise between a thumb and a mouse.

### Why Tauri 2 for Windows

| Option | Bundle | Shares `packages/core` | Desktop-native feel | Verdict |
| --- | --- | --- | --- | --- |
| **Tauri 2 + React** | ~10 MB | Yes, verbatim | Native windowing, multi-window, real menus | **Chosen** |
| Electron | ~150 MB | Yes, verbatim | Good, but heavy for an always-open tool | Rejected |
| WPF / WinUI (.NET) | Native | No — would fork the domain | Best | Rejected |
| React Native Windows | Medium | Yes | Immature; and it invites component sharing | Rejected |

Tauri keeps the TypeScript domain shared without a rewrite, while its Rust shell
provides genuine multi-window support and a small resident footprint — which matters
for something intended to sit open on a monitor all day beside the MT5 terminal
itself. WPF was rejected only because it would fork the domain layer into a second
language, and a second implementation of the risk rules is exactly the thing this
architecture exists to prevent.

### What each interface is for

These follow from the device, not from a feature list.

**Android — decide and act, away from the desk.**
The phone's job is to make the operator's *first thirty seconds* good: what is my
exposure, what has changed, is anything wrong, and can I act on it safely with one
thumb. Fast comprehension over density. Existing work — the one-thumb ticket, the
slide-to-commit gesture, certainty-annotated values — is aimed correctly and stays.

**Windows — investigate, review and supervise.**
The desktop's job is everything that needs more than a glance: multiple charts at
once, a real trade-review workspace where a decision can be reconstructed against the
chart it was made on, deeper analytics, and a persistent monitoring layout. Keyboard
first. Multi-window, so a chart can live on a second monitor.

The desktop is *not* a superset of the phone with more panels. Some things belong only
on the phone (a compact alert triage flow), and some only on the desktop (a
multi-chart workspace, session-by-session review).

### One truth, two viewers, simultaneously

Both clients may be open at once — the operator at the desk with the phone beside
them. This is a supported state, not an edge case:

- Both subscribe to the same sequenced snapshot/delta stream, so both converge.
- The realtime protocol's gap detection already means a client that falls behind
  knows it is behind and says so rather than showing stale values as current.
- Commands are idempotent by intent id, so the same decision issued twice — from two
  devices, or from one device twice — is one order.

That last property is inherited directly from the execution design and is what makes
two simultaneous clients safe rather than alarming.

**But idempotency does not cover the case this design creates.** Two devices produce
two *different* intent ids for what the operator meant as one decision — tap buy on the
phone, tap again on the desktop, and you have two genuine orders and double the
intended risk. Deduplication by intent id is powerless here because the intents really
are different.

So the desk holds a second intent that matches an existing one on symbol, side and
approximate size within a short window, and requires explicit confirmation that it is
deliberate — naming the device that sent the first. Scaling into a position remains
possible; accidentally doubling it from two screens does not.

Neither client may relax authentication because of where it runs. The desktop
application will usually run on the execution host itself, and "it is on localhost" is
not authentication. Same device-bound signing, same command nonces, both devices.

## Consequences

- A new `packages/client` is extracted from the mobile app: the API client, request
  signing, the socket with contiguity checking, and the store. These are currently in
  `apps/mobile/src/api` and `apps/mobile/src/store` and are not mobile-specific.
- `apps/mobile` shrinks to components, navigation and screens.
- `apps/desktop` is new.
- Design tokens are shared as **values** (scales, palette, semantics), rendered by
  each platform's own primitives. A shared token file is not a shared component
  library.
- Two client surfaces mean two verification burdens. Neither may be marked verified on
  the strength of the other.

## Rejected alternatives

- **One responsive codebase (React Native Web, or Expo targeting Windows).** Produces
  a compromise interface on both devices. The instruction was explicit and correct.
- **Desktop as a thin wrapper around a web view of the mobile UI.** The fastest path
  and the worst result.
- **Flutter for both.** Would share more, but discards working React Native work and a
  TypeScript domain that both clients already use, in exchange for a UI toolkit that
  still would not make a phone layout right for a monitor.
