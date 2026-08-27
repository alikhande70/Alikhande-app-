import * as D from '@keel/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrokerMarginRequest, BrokerMarginResult, BrokerPort } from '../broker/port.js';
import type { Harness } from './harness.js';
import { createHarness } from './harness.js';
import type { SubmitCommand } from './supervisor.js';

const d = D.dec;
let h: Harness;

function cmd(over: Partial<SubmitCommand> = {}): SubmitCommand {
  return {
    intentId: '018f3b8c-1a2b-7c3d-8e4f-00000000a001',
    canonical: 'XAUUSD',
    side: 'buy',
    kind: 'market',
    timeInForce: 'GTC',
    stopPrice: d('2395.00'),
    riskPct: d('0.005'),
    acknowledgeManualSize: false,
    preTradeNote: 'margin integration verification',
    tags: [],
    ...over,
  };
}

function installMargin(
  fn: (req: BrokerMarginRequest) => Promise<BrokerMarginResult>,
): ReturnType<typeof vi.fn> {
  const calculateMargin = vi.fn(fn);
  Object.assign(h.broker as BrokerPort, { calculateMargin });
  return calculateMargin;
}

beforeEach(async () => {
  h = createHarness();
  await h.run(h.broker.connect());
  h.quote('XAUUSD', '2400.00', '2400.30');
  await h.syncAccount();
});

afterEach(() => h.close());

describe('request-specific margin reaches the risk governor', () => {
  it('uses the exact sized proposal and can block on the venue margin value', async () => {
    const calculateMargin = installMargin(async () => ({
      status: 'available',
      requiredAccountCurrency: d('9000.00'),
      asOf: h.clock.now(),
      source: 'test-venue',
    }));

    const out = await h.run(h.supervisor.submit(cmd()));

    expect(out.accepted).toBe(false);
    expect(out.problem?.detail).toMatch(/free-margin/);
    expect(calculateMargin).toHaveBeenCalledTimes(1);
    expect(calculateMargin).toHaveBeenCalledWith(
      expect.objectContaining({
        canonical: 'XAUUSD',
        symbol: 'XAUUSD',
        side: 'buy',
        kind: 'market',
        price: d('2400.30'),
      }),
    );
    const proposal = calculateMargin.mock.calls[0]?.[0] as BrokerMarginRequest;
    expect(D.Decimal.toString(proposal.volume)).toBe('0.09');
    expect(await h.run(h.broker.getPositions())).toHaveLength(0);
  });

  it('blocks when request-specific margin is unavailable and an override cannot waive it', async () => {
    installMargin(async () => ({
      status: 'unavailable',
      reason: 'agent disconnected',
      certainty: 'unknown',
    }));

    const out = await h.run(
      h.supervisor.submit(
        cmd({ override: { reason: 'operator explicitly accepts all discretionary warnings' } }),
      ),
    );

    expect(out.accepted).toBe(false);
    expect(out.problem?.detail).toMatch(/margin-unknown/);
    const margin = out.risk.checks.find((check) => check.rule === 'margin-unknown');
    expect(margin?.verdict).toBe('block');
  });

  it('blocks stale and future-dated margin truth', async () => {
    installMargin(async () => ({
      status: 'available',
      requiredAccountCurrency: d('1000.00'),
      asOf: h.clock.now() - h.state.policy.maxQuoteAgeMs - 1,
      source: 'test-venue',
    }));
    const stale = await h.run(h.supervisor.preview(cmd()));
    expect(stale.risk.checks.some((check) => check.rule === 'margin-unknown')).toBe(true);

    installMargin(async () => ({
      status: 'available',
      requiredAccountCurrency: d('1000.00'),
      asOf: h.clock.now() + 1,
      source: 'test-venue',
    }));
    const future = await h.run(h.supervisor.preview(cmd()));
    expect(future.risk.checks.some((check) => check.rule === 'margin-unknown')).toBe(true);
  });

  it('preview and submit both use request-specific margin instead of separate logic', async () => {
    const calculateMargin = installMargin(async () => ({
      status: 'available',
      requiredAccountCurrency: d('1000.00'),
      asOf: h.clock.now(),
      source: 'test-venue',
    }));

    const preview = await h.run(h.supervisor.preview(cmd()));
    expect(preview.risk.verdict).toBe('pass');

    const submitted = await h.run(h.supervisor.submit(cmd()));
    expect(submitted.risk.verdict).toBe('pass');
    expect(calculateMargin).toHaveBeenCalledTimes(2);
  });

  it('turns a thrown margin transport error into fail-closed unknown', async () => {
    installMargin(async () => {
      throw new Error('transport timeout');
    });

    const result = await h.run(h.supervisor.preview(cmd()));
    expect(result.risk.checks.some((check) => check.rule === 'margin-unknown')).toBe(true);
  });
});
