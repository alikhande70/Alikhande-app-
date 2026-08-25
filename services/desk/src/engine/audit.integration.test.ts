import * as D from '@keel/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Ledger } from '../ledger/ledger.js';
import { createHarness } from './harness.js';
import type { Harness } from './harness.js';
import { recordOrderEvent } from './record.js';
import type { SubmitCommand } from './supervisor.js';

/**
 * Regressions for the defects found in the independent audit.
 *
 * Each one was a real hole with no test over it, which is precisely why it
 * survived: every one of them typechecked, read correctly, and did the wrong
 * thing. The tests below are narrow and pointed on purpose — they exist to fail
 * loudly if any of these come back.
 */

const d = D.dec;
let h: Harness;

function cmd(over: Partial<SubmitCommand> = {}): SubmitCommand {
  return {
    intentId: '018f3b8c-1a2b-7c3d-8e4f-00000000ff01',
    canonical: 'XAUUSD',
    side: 'buy',
    kind: 'market',
    timeInForce: 'GTC',
    stopPrice: d('2395.00'),
    riskPct: d('0.005'),
    acknowledgeManualSize: false,
    preTradeNote: 'audit regression',
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

describe('audit: anomalies are recorded and escalated, not discarded', () => {
  it('writes an order.anomaly event to the ledger', async () => {
    await h.run(h.supervisor.submit(cmd()));
    await h.clock.advance(1_000);

    // A fill for more than was requested. The state machine computes an
    // OVERFILL anomaly; before the fix, it was computed and thrown away.
    h.supervisor.applyVenueEvent(cmd().intentId, {
      type: 'fill',
      at: h.clock.now(),
      fillId: 'F-overfill',
      qty: d('99.00'),
      price: d('2400.00'),
    });

    const anomalies = h.ledger
      .readStream(cmd().intentId)
      .filter((r) => r.kind === 'order.anomaly')
      .map((r) => (r.event as { anomaly: { kind: string; severity: string } }).anomaly);

    // The regression is that *none* of these were written at all. The exact set
    // depends on the order's state when the fill lands — an overfill on an
    // already-finished order raises more than one kind — so the assertion is on
    // the invariant rather than on one particular label.
    expect(anomalies.length, 'no anomaly was recorded at all').toBeGreaterThan(0);
    expect(anomalies.some((a) => a.severity === 'critical')).toBe(true);
    expect(anomalies.map((a) => a.kind)).toContain('OVERFILL');
  });

  it('calls the escalation hook so an alert can be raised', () => {
    const recorded: string[] = [];
    h.ledger.append({
      kind: 'intent.created',
      intent: {
        intentId: 'i-esc',
        canonical: 'XAUUSD',
        symbol: 'XAUUSD',
        side: 'buy',
        kind: 'market',
        timeInForce: 'GTC',
        volume: '1.00',
        preTradeNote: 'n',
        tags: [],
        clientOrderId: 'k-esc',
      },
      risk: { verdict: 'pass', checks: [], policyVersion: 1, evaluatedAt: h.clock.now() },
    });
    h.projector.catchUp();

    const deps = {
      ledger: h.ledger,
      projector: h.projector,
      log: h.log,
      onAnomaly: (_id: string, a: D.Anomaly) => recorded.push(a.kind),
    };
    recordOrderEvent(deps, 'i-esc', { type: 'submit.started', at: h.clock.now() });
    recordOrderEvent(deps, 'i-esc', {
      type: 'fill',
      at: h.clock.now(),
      fillId: 'F1',
      qty: d('5.00'),
      price: d('2400.00'),
    });
    expect(recorded).toContain('OVERFILL');
  });

  it('records the event and its anomalies in one atomic batch', () => {
    // Recording a fill without the overfill anomaly beside it would leave a
    // ledger that reads as normal.
    h.ledger.append({
      kind: 'intent.created',
      intent: {
        intentId: 'i-atomic',
        canonical: 'XAUUSD',
        symbol: 'XAUUSD',
        side: 'buy',
        kind: 'market',
        timeInForce: 'GTC',
        volume: '1.00',
        preTradeNote: 'n',
        tags: [],
        clientOrderId: 'k-atomic',
      },
      risk: { verdict: 'pass', checks: [], policyVersion: 1, evaluatedAt: h.clock.now() },
    });
    h.projector.catchUp();
    const deps = { ledger: h.ledger, projector: h.projector, log: h.log };
    recordOrderEvent(deps, 'i-atomic', { type: 'submit.started', at: h.clock.now() });
    recordOrderEvent(deps, 'i-atomic', {
      type: 'fill',
      at: h.clock.now(),
      fillId: 'F1',
      qty: d('9.00'),
      price: d('2400.00'),
    });

    const stream = h.ledger.readStream('i-atomic');
    const fillIdx = stream.findIndex(
      (r) => r.kind === 'order.event' && (r.event as { event: { type: string } }).event.type === 'fill',
    );
    const anomalyIdx = stream.findIndex((r) => r.kind === 'order.anomaly');
    expect(fillIdx).toBeGreaterThanOrEqual(0);
    expect(anomalyIdx).toBe(fillIdx + 1);
  });
});

describe('audit: closing one position does not close the book', () => {
  it('closes only the requested position', async () => {
    for (let i = 0; i < 3; i++) {
      await h.run(
        h.supervisor.submit(
          cmd({ intentId: `018f3b8c-1a2b-7c3d-8e4f-00000000f${i}0${i}` }),
        ),
      );
      await h.clock.advance(30_000);
      h.quote('XAUUSD', '2400.00', '2400.30');
      await h.syncAccount();
    }

    const before = await h.run(h.broker.getPositions());
    expect(before.length).toBe(3);
    const target = before[1]?.positionId as string;

    const report = await h.run(h.guard.closeOne(target, 'audit regression'));
    expect(report.status).toBe('complete');
    expect(report.positionsTargeted).toBe(1);

    const after = await h.run(h.broker.getPositions());
    // The whole point: two positions survive.
    expect(after.length).toBe(2);
    expect(after.map((p) => p.positionId)).not.toContain(target);
  });

  it('reports honestly when it cannot reach the venue', async () => {
    await h.run(h.supervisor.submit(cmd()));
    await h.clock.advance(1_000);
    const positions = await h.run(h.broker.getPositions());
    h.broker.forceDisconnect('audit');

    const report = await h.run(
      h.guard.closeOne(positions[0]?.positionId ?? 'x', 'audit regression'),
    );
    expect(report.status).toBe('failed');
    expect(report.detail).toMatch(/not connected/);
  });
});

describe('audit: the ledger head survives a rolled-back batch', () => {
  it('does not corrupt the hash chain when appendAll throws', () => {
    const l = new Ledger({ path: ':memory:', synchronous: 'OFF', now: () => 1_000 });
    l.append({ kind: 'desk.started', version: '1', config: {} });
    const headBefore = l.head;

    expect(() =>
      l.appendAll([
        { kind: 'desk.started', version: '2', config: {} },
        // Not JSON-serialisable: the batch fails part-way through.
        // @ts-expect-error deliberately invalid payload
        { kind: 'order.event', intentId: 'x', event: { type: 'fill', at: 1, fillId: 'f', qty: 1n, price: 1n } },
      ]),
    ).toThrow();

    // The in-memory head must be exactly where it was. Before the fix it had
    // advanced past the rolled-back rows, and every later append wrote a
    // prev_hash that did not match.
    expect(l.head).toEqual(headBefore);

    l.append({ kind: 'desk.started', version: '3', config: {} });
    expect(l.verifyChain().ok).toBe(true);
    l.close();
  });
});

describe('audit: "no stop" and "cannot value the stop" are different problems', () => {
  it('does not tell the operator to attach a stop that is already there', async () => {
    // A GBPJPY position with a stop, but no USDJPY rate to value it with.
    const g = createHarness({
      instruments: [
        { ...D.Fixtures.GBPJPY, asOf: Date.now() },
        { ...D.Fixtures.XAUUSD, asOf: Date.now() },
      ],
    });
    await g.run(g.broker.connect());
    g.quote('GBPJPY', '190.000', '190.020');
    await g.syncAccount();
    g.ledger.append({
      kind: 'position.observed',
      positionId: 'P-jpy',
      canonical: 'GBPJPY',
      symbol: 'GBPJPY',
      side: 'buy',
      volume: '0.10',
      entryPrice: '190.000',
      stopPrice: '189.500',
      openedAt: g.clock.now(),
      foreign: false,
      asOf: g.clock.now(),
    });
    g.projector.catchUp();

    const risks = g.state.openPositionRisks();
    const jpy = risks.find((r) => r.canonical === 'GBPJPY');
    expect(jpy?.riskAccount).toBeUndefined();
    // The distinction that matters: it has a stop, we just cannot price it.
    expect(jpy?.riskUnknownReason).toBe('cannot-value');
    g.close();
  });

  it('still reports a genuinely stopless position as stopless', () => {
    h.ledger.append({
      kind: 'position.observed',
      positionId: 'P-naked',
      canonical: 'XAUUSD',
      symbol: 'XAUUSD',
      side: 'buy',
      volume: '0.10',
      entryPrice: '2400.00',
      openedAt: h.clock.now(),
      foreign: false,
      asOf: h.clock.now(),
    });
    h.projector.catchUp();
    const naked = h.state.openPositionRisks().find((r) => r.canonical === 'XAUUSD');
    expect(naked?.riskUnknownReason).toBe('no-stop');
  });
});
