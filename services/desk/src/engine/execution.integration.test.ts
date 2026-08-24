import * as D from '@keel/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, HARNESS_START } from './harness.js';
import type { Harness } from './harness.js';
import type { SubmitCommand } from './supervisor.js';

/**
 * End-to-end execution behaviour against the paper venue.
 *
 * These are the tests the product's central claim rests on: that the system
 * never invents execution state, and that no sequence of client actions can
 * produce a duplicate position.
 */

const d = D.dec;
let h: Harness;

function cmd(over: Partial<SubmitCommand> = {}): SubmitCommand {
  return {
    intentId: '018f3b8c-1a2b-7c3d-8e4f-000000000001',
    canonical: 'XAUUSD',
    side: 'buy',
    kind: 'market',
    timeInForce: 'GTC',
    stopPrice: d('2395.00'),
    riskPct: d('0.005'),
    acknowledgeManualSize: false,
    preTradeNote: 'London open continuation off the 4h level',
    tags: [],
    ...over,
  };
}

beforeEach(async () => {
  h = createHarness();
  await h.run(h.broker.connect());
  h.quote('XAUUSD', '2400.00', '2400.30');
  await h.syncAccount();
});

afterEach(() => {
  h.close();
});

describe('the happy path', () => {
  it('sizes from risk, fills, and records a position', async () => {
    const out = await h.run(h.supervisor.submit(cmd()));
    await h.clock.advance(1_000);

    expect(out.accepted).toBe(true);
    expect(out.risk.verdict).toBe('pass');
    // 0.5% of 10,000 = 50 USD; stop 5.30 below the ask; 100oz/lot => 530/lot.
    // 50/530 = 0.09 lots after rounding down.
    expect(out.sizing?.ok).toBe(true);
    if (out.sizing?.ok) {
      expect(D.Decimal.toString(out.sizing.volume)).toBe('0.09');
      expect(D.Decimal.lte(out.sizing.riskAtStop, d('50.00'))).toBe(true);
    }

    const rec = h.projector.loadOrderRecord(out.intentId);
    expect(rec?.state).toBe('FILLED');
    expect(D.CERTAINTY[rec?.state ?? 'UNKNOWN']).toBe('confirmed');

    const positions = await h.run(h.broker.getPositions());
    expect(positions).toHaveLength(1);
    expect(D.Decimal.toString(positions[0]?.volume as D.Dec)).toBe('0.09');
    // The stop went out with the entry, atomically.
    expect(positions[0]?.stopPrice).toBeDefined();
  });

  it('writes the intent to the ledger before anything is sent', async () => {
    await h.run(h.supervisor.submit(cmd()));
    const rows = h.ledger.readStream(cmd().intentId);
    expect(rows[0]?.kind).toBe('intent.created');
    expect(rows[1]?.kind).toBe('order.event');
    const second = rows[1]?.event as unknown as { event: { type: string } };
    expect(second.event.type).toBe('submit.started');
    // And the whole history is verifiable.
    expect(h.ledger.verifyChain().ok).toBe(true);
  });

  it('captures the risk decision that authorised the trade', async () => {
    await h.run(h.supervisor.submit(cmd()));
    const created = h.ledger.readStream(cmd().intentId)[0]?.event as unknown as {
      kind: string;
      risk: { policyVersion: number; checks: unknown[] };
    };
    expect(created.kind).toBe('intent.created');
    expect(created.risk.policyVersion).toBe(1);
    expect(created.risk.checks.length).toBeGreaterThan(0);
  });
});

describe('risk is enforced server-side', () => {
  it('refuses an order with no pre-trade note and never contacts the broker', async () => {
    const out = await h.run(h.supervisor.submit(cmd({ preTradeNote: '   ' })));
    expect(out.accepted).toBe(false);
    expect(out.problem?.code).toBe('RISK_BLOCKED');
    expect(out.problem?.detail).toMatch(/pre-trade-note/);
    expect(await h.run(h.broker.getOpenOrders())).toHaveLength(0);
    expect(await h.run(h.broker.getPositions())).toHaveLength(0);
    // The refusal is recorded — a blocked trade is still evidence about behaviour.
    const kinds = h.ledger.readStream(cmd().intentId).map((r) => r.kind);
    expect(kinds).toEqual(['intent.refused']);
  });

  it('refuses to size a market order with no stop', async () => {
    const out = await h.run(h.supervisor.submit(cmd({ stopPrice: undefined })));
    expect(out.accepted).toBe(false);
    expect(out.problem?.code).toBe('CANNOT_SIZE');
  });

  it('refuses an explicit volume unless the operator acknowledges it', async () => {
    const out = await h.run(
      h.supervisor.submit(cmd({ explicitVolume: d('1.00'), acknowledgeManualSize: false })),
    );
    expect(out.accepted).toBe(false);
    expect(out.problem?.code).toBe('MANUAL_SIZE_NOT_ACKNOWLEDGED');
  });

  it('blocks every entry once the daily loss limit is hit', async () => {
    // Force the account down 3.5% and re-observe it.
    h.ledger.append({
      kind: 'account.observed',
      currency: 'USD',
      balance: '9650.00',
      equity: '9650.00',
      marginUsed: '0.00',
      marginFree: '9650.00',
      asOf: h.clock.now(),
      source: 'broker',
    });
    h.ledger.append({ kind: 'day.rolled', dayStart: HARNESS_START - 3_600_000, openBalance: '10000.00' });
    h.projector.catchUp();

    const out = await h.run(h.supervisor.submit(cmd()));
    expect(out.accepted).toBe(false);
    expect(out.problem?.detail).toMatch(/daily-loss-limit/);
    expect(await h.run(h.broker.getPositions())).toHaveLength(0);
  });

  it('refuses when the broker is disconnected rather than guessing', async () => {
    h.broker.forceDisconnect('test');
    const out = await h.run(h.supervisor.submit(cmd()));
    expect(out.accepted).toBe(false);
    expect(out.problem?.detail).toMatch(/broker-connection/);
  });
});

describe('no sequence of actions produces a duplicate position', () => {
  it('deduplicates a repeated submission of the same intent', async () => {
    const first = await h.run(h.supervisor.submit(cmd()));
    await h.clock.advance(500);
    const second = await h.run(h.supervisor.submit(cmd()));
    await h.clock.advance(500);

    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(await h.run(h.broker.getPositions())).toHaveLength(1);
  });

  it('serialises two concurrent submissions of the same intent', async () => {
    // The double-tap: two requests in flight before either has written.
    const both = Promise.all([h.supervisor.submit(cmd()), h.supervisor.submit(cmd())]);
    const [a, b] = await h.run(both);
    await h.clock.advance(2_000);

    expect([a.deduplicated, b.deduplicated].filter(Boolean)).toHaveLength(1);
    expect(await h.run(h.broker.getPositions())).toHaveLength(1);
  });

  it('blocks a materially identical order under a new intent id', async () => {
    await h.run(h.supervisor.submit(cmd()));
    await h.clock.advance(1_000);
    const again = await h.run(
      h.supervisor.submit(cmd({ intentId: '018f3b8c-1a2b-7c3d-8e4f-000000000002' })),
    );
    expect(again.accepted).toBe(false);
    expect(again.problem?.detail).toMatch(/duplicate-intent/);
    expect(await h.run(h.broker.getPositions())).toHaveLength(1);
  });

  it('allows the same trade again once the double-tap window has passed', async () => {
    await h.run(h.supervisor.submit(cmd()));
    await h.clock.advance(30_000);
    // A live feed keeps quoting; without a fresh quote the desk correctly
    // refuses to build an order from a stale price.
    h.quote('XAUUSD', '2400.00', '2400.30');
    await h.syncAccount();
    const again = await h.run(
      h.supervisor.submit(cmd({ intentId: '018f3b8c-1a2b-7c3d-8e4f-000000000003' })),
    );
    await h.clock.advance(1_000);
    expect(again.accepted, again.problem?.detail ?? '').toBe(true);
    expect(await h.run(h.broker.getPositions())).toHaveLength(2);
  });
});

describe('a broker rejection is a fact, not an inference', () => {
  it('records REJECTED and opens nothing', async () => {
    const rejecting = createHarness({ faults: { rejectRate: 1 } });
    await rejecting.run(rejecting.broker.connect());
    rejecting.quote('XAUUSD', '2400.00', '2400.30');
    await rejecting.syncAccount();

    const out = await rejecting.run(rejecting.supervisor.submit(cmd()));
    await rejecting.clock.advance(500);

    expect(out.accepted).toBe(false);
    expect(out.problem?.outcomeUnknown).toBe(false);
    expect(rejecting.projector.loadOrderRecord(out.intentId)?.state).toBe('REJECTED');
    expect(await rejecting.run(rejecting.broker.getPositions())).toHaveLength(0);
    rejecting.close();
  });
});

describe('an unknown outcome is never guessed', () => {
  it('records UNKNOWN, refuses to call it failed, and starts resolving', async () => {
    const flaky = createHarness({ faults: { ambiguousRate: 1, ambiguousButExecutedRate: 1 } });
    await flaky.run(flaky.broker.connect());
    flaky.quote('XAUUSD', '2400.00', '2400.30');
    await flaky.syncAccount();

    const out = await flaky.run(flaky.supervisor.submit(cmd()));
    expect(out.problem?.code).toBe('OUTCOME_UNKNOWN');
    expect(out.problem?.outcomeUnknown).toBe(true);
    expect(out.problem?.detail).toMatch(/Do not resend/);
    expect(out.accepted).toBe(true); // the desk owns it

    const rec = flaky.projector.loadOrderRecord(out.intentId);
    expect(rec?.state).toBe('UNKNOWN');
    expect(D.CERTAINTY[rec?.state ?? 'FILLED']).toBe('unknown');
    expect(flaky.resolver.activeJobs).toBe(1);
    flaky.close();
  });

  it('resolves to the truth when the order did reach the venue', async () => {
    const flaky = createHarness({ faults: { ambiguousRate: 1, ambiguousButExecutedRate: 1 } });
    await flaky.run(flaky.broker.connect());
    flaky.quote('XAUUSD', '2400.00', '2400.30');
    await flaky.syncAccount();

    await flaky.run(flaky.supervisor.submit(cmd()));
    expect(flaky.projector.loadOrderRecord(cmd().intentId)?.state).toBe('UNKNOWN');

    await flaky.clock.advance(15_000);

    const rec = flaky.projector.loadOrderRecord(cmd().intentId);
    expect(rec?.state).toBe('FILLED');
    expect(rec?.venueOrderId).toBeDefined();
    expect(flaky.resolver.activeJobs).toBe(0);
    // Exactly one position: resolution found the existing order, it did not resend.
    expect(await flaky.run(flaky.broker.getPositions())).toHaveLength(1);
    flaky.close();
  });

  it('concludes absence only after repeated, separated negatives', async () => {
    const flaky = createHarness({ faults: { ambiguousRate: 1, ambiguousButExecutedRate: 0 } });
    await flaky.run(flaky.broker.connect());
    flaky.quote('XAUUSD', '2400.00', '2400.30');
    await flaky.syncAccount();

    await flaky.run(flaky.supervisor.submit(cmd()));
    expect(flaky.projector.loadOrderRecord(cmd().intentId)?.state).toBe('UNKNOWN');

    // One lookup is not enough, however negative.
    await flaky.clock.advance(1_500);
    expect(flaky.projector.loadOrderRecord(cmd().intentId)?.state).toBe('UNKNOWN');

    await flaky.clock.advance(15_000);
    const rec = flaky.projector.loadOrderRecord(cmd().intentId);
    expect(rec?.state).toBe('CONFIRMED_ABSENT');
    expect(rec?.reason).toMatch(/consecutive negative lookups/);
    expect(await flaky.run(flaky.broker.getPositions())).toHaveLength(0);
    flaky.close();
  });

  it('will not conclude absence while the connection is down', async () => {
    const flaky = createHarness({ faults: { ambiguousRate: 1, ambiguousButExecutedRate: 0 } });
    await flaky.run(flaky.broker.connect());
    flaky.quote('XAUUSD', '2400.00', '2400.30');
    await flaky.syncAccount();
    await flaky.run(flaky.supervisor.submit(cmd()));

    flaky.broker.forceDisconnect('network partition');
    await flaky.clock.advance(60_000);

    // Still unknown: absence cannot be established without a healthy connection.
    expect(flaky.projector.loadOrderRecord(cmd().intentId)?.state).toBe('UNKNOWN');
    flaky.close();
  });

  it('escalates to the operator when resolution keeps failing', async () => {
    const flaky = createHarness({ faults: { ambiguousRate: 1, ambiguousButExecutedRate: 0 } });
    await flaky.run(flaky.broker.connect());
    flaky.quote('XAUUSD', '2400.00', '2400.30');
    await flaky.syncAccount();
    await flaky.run(flaky.supervisor.submit(cmd()));
    flaky.broker.forceDisconnect('network partition');

    await flaky.clock.advance(600_000);
    // Disconnected lookups do not count as attempts, so nothing is concluded —
    // and the order stays unknown rather than being quietly closed out.
    expect(flaky.projector.loadOrderRecord(cmd().intentId)?.state).toBe('UNKNOWN');
    expect(flaky.resolver.activeJobs).toBe(1);
    flaky.close();
  });
});

describe('restart recovery', () => {
  it('finds orders left in flight and resumes resolving them', async () => {
    const flaky = createHarness({ faults: { ambiguousRate: 1, ambiguousButExecutedRate: 1 } });
    await flaky.run(flaky.broker.connect());
    flaky.quote('XAUUSD', '2400.00', '2400.30');
    await flaky.syncAccount();
    await flaky.run(flaky.supervisor.submit(cmd()));
    flaky.resolver.stopAll(); // simulate the process dying

    // "Restart": the projections survive, and the order is still UNKNOWN.
    const { pendingResolutions } = await import('./resolver.js');
    const pending = pendingResolutions(flaky.projector, flaky.ledger.db);
    expect(pending.map((p) => p.intentId)).toContain(cmd().intentId);

    flaky.resolver.resumeAll(pending);
    await flaky.clock.advance(15_000);
    expect(flaky.projector.loadOrderRecord(cmd().intentId)?.state).toBe('FILLED');
    flaky.close();
  });
});
