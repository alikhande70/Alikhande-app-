# ADR-0005 — Money and price arithmetic: scaled `bigint`, never IEEE-754

**Status:** Accepted

## Context
`0.1 + 0.2 !== 0.3`. A trading system that sizes positions, computes risk in account
currency, and compares prices to tick boundaries cannot use binary floating point for
those quantities. Errors here are silent and compound.

## Options
1. **`number` (float64) with rounding at the edges.** How most retail code does it. Fails
   on tick alignment, accumulates on P&L, and produces sizing that the broker rejects.
2. **`decimal.js` / `big.js`.** Correct, but object allocation per operation and a
   permissive API that lets you mix scales by accident.
3. **Scaled `bigint` with an explicit, type-checked scale.**

## Decision
Option 3. A `Dec` value is `{ v: bigint, s: number }` — an integer `v` at scale `s`
(`value = v / 10^s`). Operations require explicit rescale decisions; there is **no implicit
rounding**. Prices are additionally snapped to instrument tick size through a dedicated
function that names its rounding mode at every call site.

## Rationale
- `bigint` is exact and unbounded — no silent overflow at large notionals.
- Making scale part of the value forces the "what precision is this?" question to be
  answered at every boundary, which is precisely where trading bugs hide.
- Rounding **direction** is a trading decision, not a formatting detail: position size
  rounds *down* to lot step (never risk more than intended), stop distance rounds *out*
  (never tighter than intended). Encoding rounding mode in the API makes those choices
  reviewable.

## Consequences
- More verbose than `a + b`. Accepted — this is the layer where verbosity buys safety.
- Floats remain legal for chart pixel geometry and for indicator maths where the output is
  advisory and never sizes an order. That boundary is documented and tested.
