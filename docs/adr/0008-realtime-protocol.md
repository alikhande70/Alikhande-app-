# ADR-0008 — Realtime protocol: sequenced snapshot + delta over a single WebSocket

**Status:** Accepted

## Context
Mobile networks drop, hand off between cell and wifi, and suspend sockets on background.
The client must never render a partial or out-of-order view and must never *silently*
miss an update — a missed fill event is a wrong position on screen.

## Options
1. **Poll REST.** Simple, but either laggy or wasteful, and gives no gap detection.
2. **Server-Sent Events.** One-directional and awkward through mobile proxies.
3. **WebSocket, fire-and-forget messages.** No gap detection: a dropped frame is invisible.
4. **WebSocket with a monotonic sequence number per stream, snapshot + delta, resume.**

## Decision
Option 4.

- Client subscribes to topics (`account`, `positions`, `orders`, `quotes:XAUUSD`, …).
- Server replies `snapshot` with `seq`, then `delta` frames with `seq+1, seq+2, …`.
- Client asserts contiguity. **Any gap forces a resnapshot** of that topic — it never
  interpolates or assumes.
- On reconnect the client sends `resume{topic, lastSeq}`. The server replays if the delta
  is still buffered, else sends a fresh snapshot. Either way the client's state is
  provably complete.
- Every payload carries `asOf` (source timestamp) and `source` (`broker` | `desk` |
  `cache`). The UI derives staleness from `asOf`, never from arrival time.

## Rationale
Gap detection is the difference between "realtime" and "realtime-looking". Without a
sequence number a client cannot distinguish *quiet* from *disconnected*, and quiet markets
look exactly like a dead socket.

## Consequences
- Server buffers a bounded delta ring per topic (memory-capped, oldest dropped → forces
  resnapshot, which is safe by construction).
- Quote streams are throttled and conflated for rendering, but conflation is applied
  **only** to quotes, never to orders/positions/fills, which are strictly gap-free.
