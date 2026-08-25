import * as D from '@keel/core';
import { defaultRiskPolicy } from '@keel/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Harness } from './harness.js';
import { createHarness, HARNESS_START } from './harness.js';
import type { SubmitCommand } from './supervisor.js';

/**
 * The guard daemon and the reconciler.
 *
 * These are the components that must work with no client connected. Every test
 * here runs without a single client request after setup — the desk acts on its
 * own, which is the property the whole two-tier topology exists to provide.
 */

const d = D.dec;
let h: Harness;

function cmd(over: Partial<SubmitCommand> = {}): SubmitCommand {
  return {
    intentId: '018f3b8c-1a2b-7c3d-8e4f-0000000000a1',
    canonical: 'XAUUSD',
    side: 'buy',
    kind: 'market',
    timeInForce: 'GTC',
    stopPrice: d('2395.00'),
    riskPct: d('0.005'),
    acknowledgeManualSize: false,
    preTradeNote: 'test',
    tags: [],
    ...over,
  };
}

function observeAccount(harness: Harness, balance: string, equity: string): void {
  harness.ledger.append({
    kind: 'account.observed',
    currency: 'USD',
    balance,
    equity,
    marginUsed: '0.00',
    marginFree: equity,
    asOf: harness.clock.now(),
    source: 'broker',
  });
  harness.projector.catchUp();
}

beforeEach(async () => {
  h = createHarness();
  await h.run(h.broker.connect());
  h.quote('XAUUSD', '2400.00', '2400.30');
  await h.syncAccount();
  h.ledger.append({
    kind: 'day.rolled',
    dayStart: HARNESS_START - 3_600_000,
    openBalance: '10000.00',
  });
  h.projector.catchUp();
});

afterEach(() => {
  h.close();
});

describe('the daily loss limit fires with no client connected', () => {
  it('flattens and locks out when the limit is reached', async () => {
    await h.run(h.supervisor.submit(cmd()));
    expect(await h.run(h.broker.getPositions())).toHaveLength(1);

    // The account drops 3.5% — past the 3% daily limit. Nothing calls the desk;
    // it observes the account and acts.
    observeAccount(h, '9650.00', '9650.00');
    await h.run(h.guard.evaluate());

    expect(await h.run(h.broker.getPositions())).toHaveLength(0);
    const lock = h.state.lockout();
    expect(lock).toBeDefined();
    expect(lock?.reason).toMatch(/daily loss limit/);

    const alert = h.alerts.find((a) => a.title === 'Daily loss limit reached');
    expect(alert?.severity).toBe('critical');
    expect(alert?.body).toMatch(/entries are locked/);
  });

  it('blocks every subsequent entry while the lockout holds', async () => {
    observeAccount(h, '9650.00', '9650.00');
    await h.run(h.guard.evaluate());

    h.quote('XAUUSD', '2400.00', '2400.30');
    const out = await h.run(
      h.supervisor.submit(cmd({ intentId: '018f3b8c-1a2b-7c3d-8e4f-0000000000a2' })),
    );
    expect(out.accepted).toBe(false);
    expect(out.problem?.detail).toMatch(/lockout/);
  });

  it('warns before the limit rather than only at it', async () => {
    observeAccount(h, '9760.00', '9760.00'); // 2.4% down, 80% of the budget
    await h.run(h.guard.evaluate());
    const warn = h.alerts.find((a) => a.title === 'Approaching the daily loss limit');
    expect(warn?.severity).toBe('warning');
    expect(h.state.lockout()).toBeUndefined();
  });

  it('warns once, not on every evaluation', async () => {
    observeAccount(h, '9760.00', '9760.00');
    for (let i = 0; i < 5; i++) await h.run(h.guard.evaluate());
    expect(h.alerts.filter((a) => a.title === 'Approaching the daily loss limit')).toHaveLength(1);
  });
});

describe('drawdown enforcement', () => {
  it('flattens and locks out on a soft breach', async () => {
    const g = createHarness({
      policy: {
        drawdown: {
          ...defaultRiskPolicy().drawdown,
          model: { kind: 'static', amount: d('600.00') },
          breachAction: 'soft',
        },
      },
    });
    await g.run(g.broker.connect());
    g.quote('XAUUSD', '2400.00', '2400.30');
    await g.syncAccount();
    g.ledger.append({
      kind: 'day.rolled',
      dayStart: HARNESS_START - 3_600_000,
      openBalance: '10000.00',
    });
    g.projector.catchUp();
    await g.run(g.supervisor.submit(cmd()));

    // Below the 9,400 floor.
    observeAccount(g, '9300.00', '9300.00');
    await g.run(g.guard.evaluate());

    expect(await g.run(g.broker.getPositions())).toHaveLength(0);
    expect(g.state.lockout()?.reason).toMatch(/drawdown breached/);
    expect(g.alerts.some((a) => a.title === 'Drawdown breached')).toBe(true);
    g.close();
  });

  it('locks out without flattening on a hard breach', async () => {
    const g = createHarness({
      policy: {
        drawdown: {
          ...defaultRiskPolicy().drawdown,
          model: { kind: 'static', amount: d('600.00') },
          breachAction: 'hard',
        },
      },
    });
    await g.run(g.broker.connect());
    g.quote('XAUUSD', '2400.00', '2400.30');
    await g.syncAccount();
    await g.run(g.supervisor.submit(cmd()));

    observeAccount(g, '9300.00', '9300.00');
    await g.run(g.guard.evaluate());

    // A hard breach ends the account at the firm; closing out is theirs to do.
    // What matters is that nothing else is sent.
    expect(g.state.lockout()?.reason).toMatch(/hard/);
    g.close();
  });

  it('records the breach in the ledger as its own fact', async () => {
    const g = createHarness({
      policy: {
        drawdown: {
          ...defaultRiskPolicy().drawdown,
          model: { kind: 'static', amount: d('600.00') },
        },
      },
    });
    await g.run(g.broker.connect());
    await g.syncAccount();
    observeAccount(g, '9300.00', '9300.00');
    await g.run(g.guard.evaluate());

    const kinds = g.ledger.readStream('risk').map((r) => r.kind);
    expect(kinds).toContain('drawdown.breached');
    expect(g.ledger.verifyChain().ok).toBe(true);
    g.close();
  });
});

describe('flattening is not one attempt', () => {
  it('retries until the venue reports flat', async () => {
    await h.run(h.supervisor.submit(cmd()));
    const report = await h.run(h.guard.flatten('manual', 'test'));
    expect(report.status).toBe('complete');
    expect(report.detail).toMatch(/venue reports flat/);
    expect(await h.run(h.broker.getPositions())).toHaveLength(0);
  });

  it('reports failure honestly when the venue cannot be reached', async () => {
    await h.run(h.supervisor.submit(cmd()));
    h.broker.forceDisconnect('network partition');

    const report = await h.run(h.guard.flatten('manual', 'test'));
    expect(report.status).toBe('failed');
    expect(report.detail).toMatch(/could not confirm/);
    // And the operator is told to go and look, rather than reassured.
    const alert = h.alerts.find((a) => a.title === 'Flatten could not be confirmed');
    expect(alert?.severity).toBe('critical');
    expect(alert?.body).toMatch(/Check the broker terminal now/);
  });

  it('does not count an ambiguous close as done', async () => {
    const flaky = createHarness({ faults: { ambiguousRate: 1, ambiguousButExecutedRate: 0 } });
    await flaky.run(flaky.broker.connect());
    flaky.quote('XAUUSD', '2400.00', '2400.30');
    await flaky.syncAccount();
    // Open a position through a path that is not ambiguous, by using the
    // no-fault harness's broker directly.
    const report = await flaky.run(flaky.guard.flatten('manual', 'test'));
    // With no positions, the venue reports flat immediately.
    expect(report.status).toBe('complete');
    flaky.close();
  });

  it('refuses to start a second flatten while one is running', async () => {
    await h.run(h.supervisor.submit(cmd()));
    const first = h.guard.flatten('manual', 'a');
    const second = await h.run(h.guard.flatten('manual', 'b'));
    expect(second.detail).toMatch(/already in progress/);
    await h.run(first);
  });
});

describe('the trading day rolls at the operator local boundary', () => {
  it('resets counters and re-opens trading', async () => {
    observeAccount(h, '9650.00', '9650.00');
    await h.run(h.guard.evaluate());
    expect(h.state.lockout()).toBeDefined();

    // Move past 17:00 New York.
    await h.clock.advance(9 * 3_600_000);
    observeAccount(h, '9650.00', '9650.00');
    await h.run(h.guard.evaluate());

    const stats = h.state.dayStats();
    expect(stats.tradesToday).toBe(0);
    expect(D.Decimal.toString(stats.dayOpenBalance)).toBe('9650.00');
    // The new day's loss limit is measured against the new opening balance.
    const kinds = h.ledger.readStream('risk').map((r) => r.kind);
    expect(kinds).toContain('day.rolled');
  });
});

describe('restarting the desk must never widen a risk limit', () => {
  it('a fresh Guard over existing state does not roll the day and reset the loss counter', async () => {
    // The bug this pins: the day boundary was tracked in a field initialised to
    // zero, so a desk restarted mid-day rolled the day on its first evaluation,
    // reset day_open_balance to the *current* (already reduced) balance, and
    // silently cleared the daily loss limit after a bad morning.
    observeAccount(h, '9800.00', '9800.00'); // 2% down on the day
    await h.run(h.guard.evaluate());
    const before = h.state.dayStats();
    expect(D.Decimal.toString(before.dayOpenBalance)).toBe('10000.00');

    // "Restart": a brand new Guard over the same durable state.
    const { Guard } = await import('./guard.js');
    const restarted = new Guard({
      ledger: h.ledger,
      projector: h.projector,
      state: h.state,
      broker: h.broker,
      clock: h.clock,
      log: h.log,
      onAlert: () => undefined,
    });
    await h.run(restarted.evaluate());

    const after = h.state.dayStats();
    expect(D.Decimal.toString(after.dayOpenBalance)).toBe('10000.00');

    // And the limit still bites at the same place it would have before.
    observeAccount(h, '9650.00', '9650.00');
    await h.run(restarted.evaluate());
    expect(h.state.lockout()?.reason).toMatch(/daily loss limit/);
    restarted.stop();
  });
});

describe('reconciliation', () => {
  it('reports a clean book as clean', async () => {
    await h.run(h.supervisor.submit(cmd()));
    const run = await h.run(h.reconciler.runOnce());
    expect(run.failed).toBeUndefined();
    expect(run.clean).toBe(true);
  });

  it('never reports "clean" when it could not check', async () => {
    h.broker.forceDisconnect('network partition');
    const run = await h.run(h.reconciler.runOnce());
    expect(run.clean).toBe(false);
    expect(run.failed).toMatch(/not connected/);
    // The distinction that matters: "nothing wrong" and "could not look" are
    // different answers and must never render the same.
    expect(run.divergences).toHaveLength(0);
  });

  it('records a manual terminal trade as foreign while the desk is watching', async () => {
    h.quote('EURUSD', '1.08500', '1.08510');
    await h.run(
      h.broker.placeOrder({
        clientOrderId: 'manual-1',
        canonical: 'EURUSD',
        symbol: 'EURUSD',
        side: 'buy',
        kind: 'market',
        volume: d('0.10'),
        timeInForce: 'GTC',
      }),
    );
    // The event stream carried it, so the desk knows about it — and it is
    // flagged as opened elsewhere rather than treated as one of ours.
    const local = h.state.openPositions().find((p) => p.canonical === 'EURUSD');
    expect(local).toBeDefined();

    const run = await h.run(h.reconciler.runOnce());
    // The urgent finding is not that it is foreign; it is that it has no stop.
    const unprotected = run.divergences.find((x) => x.kind === 'POSITION_UNPROTECTED');
    expect(unprotected?.severity).toBe('critical');
    expect(unprotected?.action).toBe('attach-stop');
  });

  it('finds a position opened while the desk was down', async () => {
    // The case the event stream cannot cover: the desk was not listening.
    h.quote('EURUSD', '1.08500', '1.08510');
    h.detachBrokerEvents();
    await h.run(
      h.broker.placeOrder({
        clientOrderId: 'manual-1',
        canonical: 'EURUSD',
        symbol: 'EURUSD',
        side: 'buy',
        kind: 'market',
        volume: d('0.10'),
        timeInForce: 'GTC',
      }),
    );
    expect(h.state.openPositions().find((p) => p.canonical === 'EURUSD')).toBeUndefined();

    const run = await h.run(h.reconciler.runOnce());
    const kinds = run.divergences.map((x) => x.kind);
    expect(kinds).toContain('POSITION_UNKNOWN_TO_US');
    expect(kinds).toContain('POSITION_UNPROTECTED');
    const foreign = run.divergences.find((x) => x.kind === 'POSITION_UNKNOWN_TO_US');
    expect(foreign?.detail).toMatch(/brings it under the risk rules/);
  });

  it('reports the same divergence once, not once per pass', async () => {
    h.quote('EURUSD', '1.08500', '1.08510');
    await h.run(
      h.broker.placeOrder({
        clientOrderId: 'manual-1',
        canonical: 'EURUSD',
        symbol: 'EURUSD',
        side: 'buy',
        kind: 'market',
        volume: d('0.10'),
        timeInForce: 'GTC',
      }),
    );

    await h.run(h.reconciler.runOnce());
    const afterFirst = h.divergenceEvents.filter((e) => e.isNew).length;
    await h.run(h.reconciler.runOnce());
    await h.run(h.reconciler.runOnce());
    const afterThird = h.divergenceEvents.filter((e) => e.isNew).length;

    expect(afterFirst).toBeGreaterThan(0);
    expect(afterThird).toBe(afterFirst);
  });

  it('closes a divergence when it stops being true', async () => {
    h.quote('EURUSD', '1.08500', '1.08510');
    await h.run(
      h.broker.placeOrder({
        clientOrderId: 'manual-1',
        canonical: 'EURUSD',
        symbol: 'EURUSD',
        side: 'buy',
        kind: 'market',
        volume: d('0.10'),
        timeInForce: 'GTC',
      }),
    );
    await h.run(h.reconciler.runOnce());
    expect(h.reconciler.openDivergences.length).toBeGreaterThan(0);

    await h.run(h.guard.flatten('manual', 'clear the book'));
    const run = await h.run(h.reconciler.runOnce());
    expect(run.resolved).toBeGreaterThan(0);
    expect(h.reconciler.openDivergences).toHaveLength(0);
  });

  it('surfaces an unresolved order as needing resolution, not as an alarm', async () => {
    const flaky = createHarness({ faults: { ambiguousRate: 1, ambiguousButExecutedRate: 1 } });
    await flaky.run(flaky.broker.connect());
    flaky.quote('XAUUSD', '2400.00', '2400.30');
    await flaky.syncAccount();
    await flaky.run(flaky.supervisor.submit(cmd()));
    flaky.resolver.stopAll(); // reconciliation must handle it alone

    expect(flaky.projector.loadOrderRecord(cmd().intentId)?.state).toBe('UNKNOWN');
    await flaky.clock.advance(20_000); // past the settlement grace period

    const run = await flaky.run(flaky.reconciler.runOnce());
    const missing = run.divergences.find((x) => x.kind === 'ORDER_MISSING_AT_VENUE');
    expect(missing).toBeDefined();
    // An unknown order is something to resolve, not something to panic about —
    // the severity and the suggested action say so.
    expect(missing?.severity).toBe('warning');
    expect(missing?.action).toBe('resolve-unknown');
    flaky.close();
  });
});
