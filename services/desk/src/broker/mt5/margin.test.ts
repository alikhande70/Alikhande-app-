import * as D from '@keel/core';
import { describe, expect, it } from 'vitest';
import {
  type Mt5MarginRequestFingerprint,
  marginForGovernor,
  marginIsFresh,
  parseMt5MarginResponse,
} from './margin.js';

const FP: Mt5MarginRequestFingerprint = {
  symbol: 'XAUUSD',
  side: 'buy',
  volume: '0.10',
  price: '2500.00',
};
const NOW = 1_700_000_000_000;

function good(over: Record<string, unknown> = {}) {
  return {
    status: 'available',
    requiredAccountCurrency: '240.00',
    asOfUtcMs: NOW,
    requestFingerprint: FP,
    ...over,
  };
}

describe('MT5 request-specific margin', () => {
  it('accepts a well-formed response for the matching request', () => {
    const outcome = parseMt5MarginResponse(good(), FP);
    expect(outcome.status).toBe('available');
    if (outcome.status !== 'available') return;
    expect(D.Decimal.toString(outcome.requiredAccountCurrency)).toBe('240.00');
    expect(outcome.source).toBe('OrderCalcMargin');
  });

  it.each([
    ['not an object', 'nonsense'],
    ['null', null],
    ['an array', []],
    ['missing the figure', { status: 'available', asOfUtcMs: NOW, requestFingerprint: FP }],
    ['a non-decimal figure', good({ requiredAccountCurrency: '2.4e2' })],
    ['a negative figure', good({ requiredAccountCurrency: '-1.00' })],
    ['no timestamp', good({ asOfUtcMs: undefined })],
    ['a zero timestamp', good({ asOfUtcMs: 0 })],
    ['no fingerprint', good({ requestFingerprint: undefined })],
  ])('reports unavailable for %s rather than inventing a number', (_label, body) => {
    const outcome = parseMt5MarginResponse(body, FP);
    expect(outcome.status).toBe('unavailable');
  });

  it('refuses a figure computed for a different request', () => {
    // A margin for another order looks authoritative and describes something
    // else, which is worse than having none.
    const outcome = parseMt5MarginResponse(
      good({ requestFingerprint: { ...FP, volume: '1.00' } }),
      FP,
    );
    expect(outcome.status).toBe('unavailable');
    if (outcome.status !== 'unavailable') return;
    expect(outcome.reason).toContain('fingerprint');
  });

  it('distinguishes a venue refusal from silence', () => {
    const refused = parseMt5MarginResponse({ status: 'unavailable', reason: 'trade disabled' }, FP);
    expect(refused).toMatchObject({ status: 'unavailable', certainty: 'refused' });
    const silent = parseMt5MarginResponse({ garbage: true }, FP);
    expect(silent).toMatchObject({ status: 'unavailable', certainty: 'unknown' });
  });

  it('never yields 0.00 for an unavailable margin', () => {
    // The defect this module exists to prevent: zero reads as "needs no margin"
    // and clears the free-margin rule for any funded account.
    for (const body of [
      null,
      'x',
      { status: 'unavailable', reason: 'no' },
      good({ asOfUtcMs: 0 }),
    ]) {
      expect(marginForGovernor(parseMt5MarginResponse(body, FP), NOW, 5_000)).toBeUndefined();
    }
  });

  it('treats a stale figure as unavailable, not approximately right', () => {
    // Margin depends on account state; a figure from ten minutes ago describes
    // an account that may no longer exist.
    const outcome = parseMt5MarginResponse(good(), FP);
    expect(marginIsFresh(outcome, NOW + 1_000, 5_000)).toBe(true);
    expect(marginIsFresh(outcome, NOW + 60_000, 5_000)).toBe(false);
    expect(marginForGovernor(outcome, NOW + 60_000, 5_000)).toBeUndefined();
  });

  it('rejects a figure stamped in the future', () => {
    const outcome = parseMt5MarginResponse(good(), FP);
    expect(marginIsFresh(outcome, NOW - 10_000, 5_000)).toBe(false);
  });
});
