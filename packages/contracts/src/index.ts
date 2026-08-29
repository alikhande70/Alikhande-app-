/**
 * `@keel/contracts` — the single source of truth for the desk/client protocol.
 *
 * Both sides import these schemas, so a protocol change is a compile error
 * rather than a runtime surprise in the middle of a trade.
 */

export * from './api.js';
export * from './domain.js';
export * from './primitives.js';
export * from './realtime.js';
