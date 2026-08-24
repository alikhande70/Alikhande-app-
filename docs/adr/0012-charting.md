# ADR-0012 — Charting: custom Skia renderer, not a chart library

**Status:** Accepted

## Context
The chart is the primary read surface and the primary place the operator makes decisions.
It must handle tick updates without dropping frames, support crosshair + measure + level
drawing under a thumb, and render risk geometry (entry/stop/target bands sized in R)
directly on price — which no generic chart library models.

## Options
1. **`react-native-wagmi-charts`.** Fast, Skia-based, but modelled for simple financial
   line/candle display, not for interactive risk geometry or the drawing tools needed.
2. **Victory Native (Skia backend).** General-purpose; a poor fit for a price chart with
   pan/zoom over a rolling window and live last-bar mutation.
3. **A WebView-hosted TradingView Lightweight Charts.** Excellent charts, but a WebView
   bridge on the hot path, a second rendering model, and no access to the app's own gesture
   and theming systems.
4. **A purpose-built renderer on `@shopify/react-native-skia` + Reanimated.**

## Decision
Option 4, with a strict separation: **viewport state lives on the UI thread** (Reanimated
shared values), so pan/zoom never round-trips to JS; **data lives in JS** and is pushed to
Skia as a compact typed structure.

## Rationale
- The distinguishing feature — stop/target/risk bands, position markers, and R-multiple
  overlays that stay correct while panning — is not a plugin to an existing library, it is
  the chart's core model. Building on a library would mean fighting it.
- Gesture responsiveness under a thumb is the single most-felt quality signal in a mobile
  trading app, and it is only achievable by keeping the gesture→transform path off the JS
  thread entirely.
- Bars are pre-bucketed on the desk, so the client renders a bounded window and never
  holds unbounded history in memory.

## Consequences
- More code to own and to test. Mitigated by keeping all chart *maths* (scales, hit-testing,
  bucketing, visible-range selection) as pure functions in `@keel/core`, unit-tested off-device,
  with only drawing in the component.
