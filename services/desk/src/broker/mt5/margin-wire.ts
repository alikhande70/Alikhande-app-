import type { Mt5MarginRequestFingerprint } from './margin.js';

/**
 * Exact proposal sent to MT5 for request-specific margin truth.
 *
 * Price is always explicit, including market orders. That makes the returned
 * value auditable and prevents a margin result computed from a later tick from
 * being silently attached to an earlier decision snapshot.
 */
export interface Mt5MarginRequest extends Mt5MarginRequestFingerprint {
  readonly kind: 'market' | 'limit' | 'stop' | 'stop_limit';
}

export type Mt5MarginWireResult =
  | {
      readonly status: 'available';
      readonly requiredAccountCurrency: string;
      readonly source: 'OrderCalcMargin';
      readonly asOfUtcMs: number;
      readonly requestFingerprint: Mt5MarginRequestFingerprint;
    }
  | {
      readonly status: 'unavailable';
      readonly reason: string;
      readonly asOfUtcMs: number;
      readonly requestFingerprint: Mt5MarginRequestFingerprint;
    };
