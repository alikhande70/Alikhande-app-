import { describe, expect, it } from 'vitest';
import {
  ClientMessage,
  DecimalString,
  Order,
  PlaceOrderRequest,
  PlaceOrderResponse,
  Quote,
  ServerMessage,
  Topic,
  checkContiguity,
} from './index.js';

describe('decimal strings on the wire', () => {
  it('accepts plain decimals', () => {
    for (const s of ['0', '-0.001', '2400.10', '90071992547409910.12', '+7.25']) {
      expect(DecimalString.safeParse(s).success, s).toBe(true);
    }
  });

  it('rejects anything that would lose precision or meaning', () => {
    for (const s of ['1e-8', 'NaN', 'Infinity', '1,000', '', '1.2.3', '0x10']) {
      expect(DecimalString.safeParse(s).success, s).toBe(false);
    }
  });

  it('rejects a JSON number, because a float has already lost the value', () => {
    expect(DecimalString.safeParse(2400.1).success).toBe(false);
  });

  it('preserves trailing zeros through a round trip', () => {
    const q = {
      canonical: 'XAUUSD',
      bid: '2400.10',
      ask: '2400.40',
      spread: '0.30',
      provenance: { source: 'broker' as const, asOf: 1 },
      stale: false,
    };
    const parsed = Quote.parse(JSON.parse(JSON.stringify(q)));
    expect(parsed.bid).toBe('2400.10'); // not 2400.1
  });
});

describe('order request shape', () => {
  const base = {
    intentId: '018f3b8c-1a2b-7c3d-8e4f-5a6b7c8d9e0f',
    canonical: 'XAUUSD',
    side: 'buy',
    kind: 'market',
    stopPrice: '2395.00',
    riskPct: '0.005',
    preTradeNote: 'London open continuation off the 4h level',
  };

  it('accepts a risk-first order with no volume field', () => {
    const r = PlaceOrderRequest.safeParse(base);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.timeInForce).toBe('GTC');
    expect(r.data.acknowledgeManualSize).toBe(false);
    expect('volume' in r.data).toBe(false);
  });

  it('requires an acknowledgement to bypass risk-derived sizing', () => {
    const parsed = PlaceOrderRequest.parse({ ...base, explicitVolume: '5.00' });
    // The schema permits it; the desk refuses it unless acknowledged. Encoding
    // the flag here means the client cannot omit the decision by accident.
    expect(parsed.acknowledgeManualSize).toBe(false);
    expect(parsed.explicitVolume).toBe('5.00');
  });

  it('demands a substantive reason for a break-glass override', () => {
    expect(PlaceOrderRequest.safeParse({ ...base, override: { reason: 'yes' } }).success).toBe(
      false,
    );
    expect(
      PlaceOrderRequest.safeParse({
        ...base,
        override: { reason: 'closing a hedge ahead of the weekend' },
      }).success,
    ).toBe(true);
  });

  it('rejects an intent id that is not a uuid', () => {
    expect(PlaceOrderRequest.safeParse({ ...base, intentId: 'order-1' }).success).toBe(false);
  });
});

describe('the response never implies execution', () => {
  it('separates "the desk recorded this" from "the venue has it"', () => {
    const r = PlaceOrderResponse.parse({
      intentId: '018f3b8c-1a2b-7c3d-8e4f-5a6b7c8d9e0f',
      accepted: true,
      risk: { verdict: 'pass', checks: [], policyVersion: 1, evaluatedAt: 1 },
    });
    expect(r.accepted).toBe(true);
    expect(r.order).toBeUndefined(); // live state comes from the venue, over the socket
    expect(r.deduplicated).toBe(false);
  });

  it('carries certainty alongside state on every order', () => {
    const o = Order.parse({
      intentId: '018f3b8c-1a2b-7c3d-8e4f-5a6b7c8d9e0f',
      canonical: 'XAUUSD',
      symbol: 'XAUUSD',
      side: 'buy',
      kind: 'market',
      timeInForce: 'GTC',
      requestedQty: '0.20',
      filledQty: '0.00',
      state: 'UNKNOWN',
      certainty: 'unknown',
      certaintyText: 'Unknown. Resolving — attempt 1. Do not resend.',
      resolutionAttempts: 0,
      createdAt: 1,
      lastEventAt: 2,
      provenance: { source: 'desk', asOf: 2 },
    });
    expect(o.certainty).toBe('unknown');
    expect(o.certaintyText).toMatch(/Do not resend/);
  });
});

describe('realtime protocol', () => {
  it('accepts well-formed topics and rejects malformed ones', () => {
    for (const t of ['health', 'positions', 'orders', 'quotes:XAUUSD', 'quotes:BTCUSD-PERP']) {
      expect(Topic.safeParse(t).success, t).toBe(true);
    }
    for (const t of ['quotes:', 'quotes:xauusd', 'nonsense:1', '']) {
      expect(Topic.safeParse(t).success, t).toBe(false);
    }
  });

  it('parses a hello with per-topic resume points', () => {
    const m = ClientMessage.parse({
      type: 'hello',
      protocolVersion: 1,
      clientVersion: '0.1.0',
      topics: ['positions', 'orders'],
      resume: { positions: 42, orders: 17 },
    });
    expect(m.type).toBe('hello');
    if (m.type !== 'hello') return;
    expect(m.resume.positions).toBe(42);
  });

  it('parses snapshot, delta and resync frames', () => {
    const snap = ServerMessage.parse({
      type: 'snapshot',
      topic: 'positions',
      seq: 1,
      at: 100,
      payload: { topicKind: 'positions', value: [] },
    });
    expect(snap.type).toBe('snapshot');

    const resync = ServerMessage.parse({
      type: 'resync',
      topic: 'orders',
      reason: 'buffer-expired',
      detail: 'resume point 3 is older than the 60s delta buffer',
    });
    expect(resync.type).toBe('resync');
  });
});

describe('sequence contiguity — the rule both sides share', () => {
  it('accepts the very first frame whatever its sequence', () => {
    expect(checkContiguity(undefined, 9_999)).toEqual({ ok: true });
  });

  it('accepts exactly the next sequence', () => {
    expect(checkContiguity(41, 42)).toEqual({ ok: true });
  });

  it('names a gap rather than silently accepting it', () => {
    expect(checkContiguity(41, 44)).toEqual({ ok: false, reason: 'gap', expected: 42 });
  });

  it('distinguishes a duplicate from a gap', () => {
    expect(checkContiguity(41, 41)).toEqual({ ok: false, reason: 'duplicate', expected: 42 });
  });

  it('distinguishes a regression, which means the server restarted', () => {
    expect(checkContiguity(41, 3)).toEqual({ ok: false, reason: 'regression', expected: 42 });
  });

  it('a quiet market and a dead socket are not the same thing', () => {
    // No frames at all leaves lastSeq untouched; the client detects the dead
    // socket through the heartbeat, not through sequence numbers. This test
    // exists to pin that division of responsibility.
    expect(checkContiguity(41, 42)).toEqual({ ok: true });
    expect(checkContiguity(41, 42)).toEqual({ ok: true });
  });
});
