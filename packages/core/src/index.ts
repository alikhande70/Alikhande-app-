/**
 * `@keel/core` — the trading domain, as pure functions.
 *
 * Nothing here touches the network, the clock, the filesystem or a database.
 * Everything takes its inputs explicitly, including `now`. That is what lets
 * the mobile client run the identical risk evaluation the desk enforces, and
 * what lets the chaos suite replay a whole trading day deterministically.
 */

export * from './analytics/performance.js';
export * from './execution/orderState.js';
export * from './execution/reconcile.js';
export * from './market/fx.js';
export * from './market/instrument.js';
export * from './market/sizing.js';
export type { Dec, RoundingMode } from './money/decimal.js';
export * as Decimal from './money/decimal.js';
export { DecimalError, ZERO, dec, raw, rescale } from './money/decimal.js';
export * from './risk/drawdown.js';
export * from './risk/governor.js';
export * from './risk/policy.js';
export * as Fixtures from './testing/fixtures.js';
export * from './time/sessions.js';
export * from './time/zone.js';
