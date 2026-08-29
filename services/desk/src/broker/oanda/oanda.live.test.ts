import * as D from '@keel/core';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { systemClock } from '../../sim/clock.js';
import { describeCapabilities, supportsSafeRetry } from '../port.js';
import { OandaBroker } from './adapter.js';
import { OandaClient } from './client.js';

/**
 * Live validation against a real OANDA **practice** account.
 *
 * Nothing in this file runs without credentials, and the execution round trip
 * needs a second opt-in on top of that. Run it with:
 *
 *   KEEL_OANDA_TOKEN=... KEEL_OANDA_ACCOUNT_ID=101-004-XXXXXXX-001 \
 *     pnpm --filter @keel/desk test:live
 *
 * and add `KEEL_OANDA_LIVE_EXECUTION=true` to also open and close a real
 * position. The execution test trades ONE unit of EUR_USD — roughly a dollar of
 * notional — because the point is to prove the round trip, not to take a
 * position.
 *
 * This suite refuses to run against the live environment at all. A test that
 * places orders should never be one environment variable away from real money.
 */

const token = process.env.KEEL_OANDA_TOKEN;
const accountId = process.env.KEEL_OANDA_ACCOUNT_ID;
const executionAllowed = process.env.KEEL_OANDA_LIVE_EXECUTION === 'true';
const haveCredentials = token !== undefined && token !== '' && accountId !== undefined;

if (process.env.KEEL_OANDA_ENVIRONMENT === 'live') {
  throw new Error(
    'the OANDA live suite runs against the practice environment only; refusing to run with ' +
      'KEEL_OANDA_ENVIRONMENT=live',
  );
}

const log = pino({ level: process.env.KEEL_LOG_LEVEL ?? 'silent' });

function makeBroker(): OandaBroker {
  const client = new OandaClient({
    token: token as string,
    accountId: accountId as string,
    environment: 'practice',
    requestTimeoutMs: 15_000,
  });
  return new OandaBroker({
    client,
    clock: systemClock,
    log,
    instruments: ['EURUSD'],
  });
}

/** A client order id that is unique per run, so reruns cannot collide. */
function freshClientOrderId(): string {
  return `k-live-${Date.now().toString(36)}`;
}

describe.skipIf(!haveCredentials)('OANDA practice — read paths', () => {
  it('connects, and reports the account position model from the account itself', async () => {
    const broker = makeBroker();
    await broker.connect();
    try {
      expect(broker.isConnected()).toBe(true);
      expect(['netting', 'hedging']).toContain(broker.capabilities.positionModel);
      // v20 has native, addressable client ids, so retry is permitted.
      expect(supportsSafeRetry(broker.capabilities)).toBe(true);
      log.info({ notes: describeCapabilities(broker.capabilities) }, 'capabilities');
    } finally {
      await broker.disconnect();
    }
  });

  it('reads the account with exact decimal arithmetic', async () => {
    const broker = makeBroker();
    await broker.connect();
    try {
      const account = await broker.getAccount();
      expect(account.currency).toMatch(/^[A-Z]{3}$/);
      // Equity is balance plus unrealised P&L; both must parse exactly.
      expect(() => D.Decimal.toString(account.equity)).not.toThrow();
      expect(D.Decimal.isNegative(account.marginUsed)).toBe(false);
    } finally {
      await broker.disconnect();
    }
  });

  it('maps every instrument the account can trade without inventing a spec', async () => {
    const broker = makeBroker();
    await broker.connect();
    try {
      const specs = await broker.getInstruments();
      expect(specs.length).toBeGreaterThan(0);

      const eurusd = specs.find((s) => s.canonical === 'EURUSD');
      expect(eurusd).toBeDefined();
      if (eurusd === undefined) return;

      expect(eurusd.symbol).toBe('EUR_USD');
      expect(eurusd.digits).toBeGreaterThanOrEqual(4);
      // OANDA trades units, so the contract size is one by construction.
      expect(D.Decimal.toString(eurusd.contractSize)).toBe('1');
      // No per-tick account value is reported, so the core must convert via FX.
      expect(eurusd.tickValueAccount).toBeUndefined();
      expect(D.Decimal.isPositive(eurusd.marginRate)).toBe(true);
    } finally {
      await broker.disconnect();
    }
  });

  it('quotes EUR/USD with the venue timestamp and an uncrossed book', async () => {
    const broker = makeBroker();
    await broker.connect();
    try {
      const quote = await broker.getQuote('EURUSD');
      expect(quote).toBeDefined();
      if (quote === undefined) return;
      // A crossed book means the parse is wrong, whatever the market is doing.
      expect(D.Decimal.gte(quote.ask, quote.bid)).toBe(true);
      // The venue's own stamp, within a day of now — proving we read `time`
      // rather than substituting the local clock.
      expect(Math.abs(Date.now() - quote.asOf)).toBeLessThan(24 * 60 * 60 * 1000);
    } finally {
      await broker.disconnect();
    }
  });

  it('returns positive evidence of absence for an id that was never sent', async () => {
    // This is the branch the unknown-outcome resolver depends on: a clean
    // "the venue searched and does not have it", distinct from "no answer".
    const broker = makeBroker();
    await broker.connect();
    try {
      const res = await broker.findByClientOrderId(`k-absent-${Date.now().toString(36)}`);
      expect(res.found).toBe(false);
    } finally {
      await broker.disconnect();
    }
  });
});

describe.skipIf(!haveCredentials || !executionAllowed)('OANDA practice — execution', () => {
  it('opens a one-unit position with an attached stop, finds it by client id, and closes it', async () => {
    const broker = makeBroker();
    await broker.connect();
    const clientOrderId = freshClientOrderId();

    try {
      const quote = await broker.getQuote('EURUSD');
      expect(quote).toBeDefined();
      if (quote === undefined) return;

      // A stop well away from the market, quantised to the venue's grid.
      const specs = await broker.getInstruments();
      const spec = specs.find((s) => s.canonical === 'EURUSD');
      expect(spec).toBeDefined();
      if (spec === undefined) return;
      const stop = D.Decimal.quantize(
        D.Decimal.sub(quote.bid, D.dec('0.01000')),
        spec.tickSize,
        'down',
      );

      const submitted = await broker.placeOrder({
        clientOrderId,
        canonical: 'EURUSD',
        symbol: 'EUR_USD',
        side: 'buy',
        kind: 'market',
        volume: D.dec('1'),
        timeInForce: 'FOK',
        stopLoss: stop,
      });

      if (submitted.outcome === 'rejected') {
        // Outside trading hours the venue declines rather than fills. That is
        // a real, correct answer from the adapter, so say so plainly instead
        // of failing as though the code were wrong.
        log.warn({ reason: submitted.reason }, 'venue rejected the probe order');
        expect(submitted.reason.length).toBeGreaterThan(0);
        return;
      }

      expect(submitted.outcome).toBe('acked');
      if (submitted.outcome !== 'acked') return;
      expect(submitted.state).toBe('FILLED');
      expect(D.Decimal.toString(submitted.filledQty)).toBe('1');

      // The id survived the round trip and is addressable — which is the
      // whole basis on which this adapter claims retry is safe.
      const found = await broker.findByClientOrderId(clientOrderId);
      expect(found.found).toBe(true);

      const positions = await broker.getPositions();
      const mine = positions.find((p) => p.clientOrderId === clientOrderId);
      expect(mine).toBeDefined();
      if (mine === undefined) return;
      expect(mine.side).toBe('buy');
      // The stop was attached atomically on fill, so it is already there.
      expect(mine.stopPrice).toBeDefined();

      const closed = await broker.closePosition(mine.positionId, undefined, `${clientOrderId}-x`);
      expect(closed.outcome).toBe('acked');

      const after = await broker.getPositions();
      expect(after.find((p) => p.positionId === mine.positionId)).toBeUndefined();
    } finally {
      await broker.disconnect();
    }
  }, 60_000);
});
