import { z } from 'zod';

/**
 * Wire primitives shared by the desk and the mobile client.
 *
 * The single most important decision in this file: **money and prices travel as
 * decimal strings, never as JSON numbers.** `JSON.parse('2400.10')` is a
 * float64 and has already lost information by the time any code sees it. A
 * string preserves both the value and the precision the venue quoted it at.
 */

/** A plain decimal string. Scientific notation is rejected, as in `@keel/core`. */
export const DecimalString = z
  .string()
  .regex(/^[+-]?\d+(\.\d+)?$/, 'must be a plain decimal string, e.g. "2400.10"');

export type DecimalString = z.infer<typeof DecimalString>;

/** Epoch milliseconds. */
export const Timestamp = z.number().int().nonnegative();

/**
 * Where a value came from. Rendered by the UI, because a reference price and an
 * executable price must never look the same (ADR-0013).
 */
export const DataSource = z.enum([
  /** The venue we would actually trade against. */
  'broker',
  /** An independent market-data provider. Not executable. */
  'reference',
  /** Computed by the desk from other inputs. */
  'desk',
  /** Served from the client's own cache while offline. */
  'cache',
]);
export type DataSource = z.infer<typeof DataSource>;

/**
 * Provenance travels with every value that could be stale. The UI derives
 * staleness from `asOf`, never from arrival time — a value that took 9 seconds
 * to reach the phone is 9 seconds old, not fresh on arrival.
 */
export const Provenance = z.object({
  source: DataSource,
  /** Source timestamp, from the origin system. */
  asOf: Timestamp,
  /** Optional venue/provider identifier for forensics. */
  origin: z.string().max(64).optional(),
});
export type Provenance = z.infer<typeof Provenance>;

export const Side = z.enum(['buy', 'sell']);
export type Side = z.infer<typeof Side>;

export const OrderKind = z.enum(['market', 'limit', 'stop', 'stop_limit']);
export type OrderKind = z.infer<typeof OrderKind>;

export const TimeInForce = z.enum(['GTC', 'IOC', 'FOK', 'DAY', 'GTD']);
export type TimeInForce = z.infer<typeof TimeInForce>;

export const OrderState = z.enum([
  'PENDING_SUBMIT',
  'SUBMITTED',
  'UNKNOWN',
  'WORKING',
  'PARTIALLY_FILLED',
  'FILLED',
  'REJECTED',
  'CANCEL_REQUESTED',
  'CANCELLED',
  'EXPIRED',
  'CONFIRMED_ABSENT',
  'FAILED_LOCAL',
]);
export type OrderState = z.infer<typeof OrderState>;

export const Certainty = z.enum(['confirmed', 'in-flight', 'unknown', 'local']);
export type Certainty = z.infer<typeof Certainty>;

export const Verdict = z.enum(['pass', 'warn', 'block']);
export type Verdict = z.infer<typeof Verdict>;

export const Severity = z.enum(['info', 'warning', 'critical']);
export type Severity = z.infer<typeof Severity>;

export const SessionId = z.enum(['sydney', 'tokyo', 'london', 'newyork']);
export type SessionId = z.infer<typeof SessionId>;

/**
 * UUIDv7, generated on the client when the order ticket opens.
 *
 * It is the identity of a *human decision*, not of a request, which is what
 * makes retries safe: the same decision retried carries the same id and is
 * deduplicated end to end (ADR-0006).
 */
export const IntentId = z.string().uuid();
export type IntentId = z.infer<typeof IntentId>;

/** A problem, in a shape the client can render without string-matching. */
export const ProblemDetail = z.object({
  code: z.string(),
  title: z.string(),
  detail: z.string(),
  /** Whether retrying the identical request could succeed. */
  retryable: z.boolean(),
  /** Set when the outcome of the original attempt is genuinely unknown. */
  outcomeUnknown: z.boolean().default(false),
});
export type ProblemDetail = z.infer<typeof ProblemDetail>;
