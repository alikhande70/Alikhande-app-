# ADR-0002 — Mobile stack: Expo SDK 57 / React Native 0.87, New Architecture

**Status:** Accepted

## Context
One operator, two potential devices (iOS primary), needs native-feeling realtime UI with
high-quality charts, biometrics, secure storage and push notifications.

## Options
1. **Native Swift (+ Kotlin later).** Best possible fidelity and performance ceiling.
2. **React Native / Expo.**
3. **Flutter.** Strong rendering story, but a second language ecosystem and no code
   sharing with a TypeScript desk.
4. **PWA.** Rejected: no reliable background push on iOS, no biometric-gated secure
   enclave storage, no confidence in realtime socket lifecycle.

## Decision
Expo SDK 57 (React Native 0.87), New Architecture (Fabric + TurboModules, mandatory from
SDK 55), Hermes.

## Rationale
- **Shared types across the wire.** The contracts package is consumed by both the desk and
  the app, so a protocol change is a compile error rather than a runtime surprise. For a
  trading protocol this is worth more than a few ms of native polish.
- **New Architecture is no longer optional or experimental** in this SDK line — synchronous
  layout, better list performance, and Skia integration that keeps chart rendering off the
  JS thread.
- **EAS Build + OTA updates** matter disproportionately for a single-operator app: the
  operator can ship a fix to their own phone without an App Store cycle.
- Native Swift was rejected not on quality but on total system coherence and the cost of
  duplicating the domain model in a second language — duplicated domain logic is exactly
  where trading bugs live.

## Consequences
- Chart rendering needs deliberate engineering (see ADR-0012); the default RN path is not
  fast enough for tick-rate updates.
- Accept a dependency on Expo's release cadence. Mitigated: no undocumented native forks.
