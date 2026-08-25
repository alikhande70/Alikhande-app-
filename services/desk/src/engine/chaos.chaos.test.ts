import * as D from '@keel/core';
import { describe, expect, it } from 'vitest';
import { Rng } from '../sim/rng.js';
import { createHarness } from './harness.js';
import type { Harness } from './harness.js';
import { pendingResolutions } from './resolver.js';
import type { SubmitCommand } from './supervisor.js';

/**
 * Chaos.
 *
 * Each run drives a whole trading session against a venue that misbehaves on
 * purpose — ambiguous submits that really executed, dropped and duplicated fill
 * events, rejections, disconnections mid-flight — and then asserts the
 * invariants that must hold no matter what happened.
 *
 * Every run is seeded, so a failure prints a seed that reproduces it exactly.
 * A failure that cannot be replayed cannot be fixed with confidence, and a
 * chaos suite that cannot be replayed is theatre.
 *
 * The invariants are deliberately about *safety*, not about outcomes. It does
 * not matter whether a given order filled; it matters that the system never
 * ends up holding two positions from one decision, never claims certainty it
 * does not have, and never loses the evidence needed to find out.
 */

const d = D.dec;

const CHAOS: Parameters<typeof createHarness>[0]['faults'] = {
  ambiguousRate: 0.25,
  rejectRate: 0.1,
  partialFillRate: 0.3,
  requoteRate: 0.2,
  disconnectRate: 0.02,
  ambiguousButExecutedRate: 0.5,
  dropFillEventRate: 0.15,
  duplicateFillEventRate: 0.1,
};

interface RunResult {
  readonly seed: number;
  readonly intents: string[];
  readonly harness: Harness;
}

/** Drive one randomized session. */
async function runSession(seed: number, actions = 30): Promise<RunResult> {
  const rng = new Rng(seed);
  const h = createHarness({ seed, faults: CHAOS, medianLatencyMs: 30, slippageTicks: 2 });
  await h.run(h.broker.connect());
  h.quote('XAUUSD', '2400.00', '2400.30');
  h.quote('EURUSD', '1.08500', '1.08512');
  await h.syncAccount();

  const intents: string[] = [];
  let price = 240000; // XAUUSD in ticks of 0.01

  for (let i = 0; i < actions; i++) {
    // The market moves.
    price += rng.int(-40, 40);
    const bid = (price / 100).toFixed(2);
    const ask = ((price + 30) / 100).toFixed(2);
    h.quote('XAUUSD', bid, ask);

    // The connection sometimes dies and comes back.
    if (rng.chance(0.06)) {
      h.broker.forceDisconnect('chaos: link down');
      await h.clock.advance(rng.int(500, 4_000));
      await h.run(h.broker.connect());
      h.quote('XAUUSD', bid, ask);
      await h.syncAccount();
    }

    const roll = rng.float();
    if (roll < 0.55) {
      // Place an order.
      const intentId = uuidFor(seed, i);
      intents.push(intentId);
      const side = rng.chance(0.5) ? 'buy' : 'sell';
      const stop =
        side === 'buy'
          ? ((price - rng.int(300, 900)) / 100).toFixed(2)
          : ((price + rng.int(300, 900)) / 100).toFixed(2);
      const cmd: SubmitCommand = {
        intentId,
        canonical: 'XAUUSD',
        side,
        kind: 'market',
        timeInForce: 'GTC',
        stopPrice: d(stop),
        riskPct: d('0.003'),
        acknowledgeManualSize: false,
        preTradeNote: `chaos ${i}`,
        tags: [],
      };
      await h.run(h.supervisor.submit(cmd));

      // Sometimes the client retries the same decision, as a nervous operator
      // or a flaky network would.
      if (rng.chance(0.25)) await h.run(h.supervisor.submit(cmd));
    } else if (roll < 0.75) {
      await h.run(h.reconciler.runOnce());
    } else if (roll < 0.85) {
      await h.run(h.guard.evaluate());
    } else if (roll < 0.92) {
      await h.run(h.guard.flatten('manual', 'chaos flatten'));
    }

    await h.clock.advance(rng.int(200, 3_000));
  }

  // Let resolution finish, with the connection healthy so absence can be
  // established. An unresolved order at the end is a legitimate state, but it
  // should be because resolution is still working, not because it gave up.
  if (!h.broker.isConnected()) await h.run(h.broker.connect());
  await h.clock.advance(600_000);
  await h.run(h.reconciler.runOnce());

  return { seed, intents, harness: h };
}

function duplicates(ids: readonly (string | undefined)[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const id of ids) {
    if (id === undefined) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, n]) => n > 1);
}

function uuidFor(seed: number, i: number): string {
  const hex = (seed * 1000 + i).toString(16).padStart(12, '0');
  return `018f3b8c-1a2b-7c3d-8e4f-${hex}`;
}

// ---------------------------------------------------------------------------

describe('chaos: one decision never becomes two positions', () => {
  for (const seed of [1, 7, 42, 101, 999]) {
    it(`holds under seed ${seed}`, async () => {
      const { harness: h } = await runSession(seed);

      // Every venue-side order carries a client order id derived from an
      // intent. Orders and positions are counted separately so a failure is
      // diagnosable: two *orders* sharing an id means the idempotency layer
      // failed, while two *positions* sharing one means the venue split one
      // order across positions.
      const venueOrders = h.broker.isConnected() ? await h.run(h.broker.getOpenOrders()) : [];
      const positions = h.broker.isConnected() ? await h.run(h.broker.getPositions()) : [];

      const dupOrders = duplicates(venueOrders.map((o) => o.clientOrderId));
      expect(
        dupOrders,
        `seed ${seed}: one intent produced two ORDERS — idempotency failed`,
      ).toEqual([]);

      const dupPositions = duplicates(positions.map((p) => p.clientOrderId));
      expect(
        dupPositions,
        `seed ${seed}: one intent produced two POSITIONS ${JSON.stringify(dupPositions)}`,
      ).toEqual([]);

      h.close();
    }, 60_000);
  }
});

describe('chaos: the ledger stays authoritative', () => {
  for (const seed of [3, 77, 512]) {
    it(`chain and projections survive seed ${seed}`, async () => {
      const { harness: h } = await runSession(seed, 25);

      const chain = h.ledger.verifyChain();
      expect(chain.ok, `seed ${seed}: ${chain.ok ? '' : chain.reason}`).toBe(true);

      // Projections must be reproducible from events alone. A mismatch means
      // state leaked in without a fact behind it.
      const rebuild = h.projector.verifyAgainstRebuild();
      expect(
        rebuild.ok,
        `seed ${seed}: projection drift in ${rebuild.ok ? '' : `${rebuild.table} — ${rebuild.detail}`}`,
      ).toBe(true);

      h.close();
    }, 60_000);
  }
});

describe('chaos: the system never claims certainty it does not have', () => {
  for (const seed of [11, 222]) {
    it(`every order's state is backed by evidence under seed ${seed}`, async () => {
      const { harness: h, intents } = await runSession(seed, 25);

      for (const intentId of intents) {
        const rec = h.projector.loadOrderRecord(intentId);
        if (rec === undefined) continue;

        // A confirmed state must have come from the venue, which means either a
        // venue order id or a fill. A "confirmed" order with neither would be a
        // claim with nothing behind it.
        if (D.CERTAINTY[rec.state] === 'confirmed' && rec.state !== 'CONFIRMED_ABSENT') {
          const hasEvidence =
            rec.venueOrderId !== undefined || D.Decimal.gt(rec.filledQty, D.Decimal.ZERO);
          expect(
            hasEvidence,
            `seed ${seed}: ${intentId} is ${rec.state} with no venue evidence`,
          ).toBe(true);
        }

        // Filled quantity never exceeds what was asked for without an anomaly
        // having been raised. (Overfills are possible at a venue; silent ones
        // are not acceptable.)
        if (D.Decimal.gt(rec.filledQty, rec.requestedQty)) {
          const anomalies = h.ledger
            .readStream(intentId)
            .filter((r) => r.kind === 'order.anomaly');
          expect(anomalies.length, `seed ${seed}: silent overfill on ${intentId}`).toBeGreaterThan(0);
        }
      }

      h.close();
    }, 60_000);
  }
});

describe('chaos: nothing is left unknown without someone chasing it', () => {
  for (const seed of [5, 88]) {
    it(`unknown orders are either resolved or still being resolved (seed ${seed})`, async () => {
      const { harness: h } = await runSession(seed, 20);

      const unknown = h.state.ordersInState(['UNKNOWN']);
      if (unknown.length > 0) {
        // Anything still unknown must be a live resolution job, not an
        // abandoned one. The resolver never gives up quietly.
        const pending = pendingResolutions(h.projector, h.ledger.db);
        for (const row of unknown) {
          expect(
            pending.some((p) => p.intentId === row.intent_id),
            `seed ${seed}: ${String(row.intent_id)} is UNKNOWN but nothing is resolving it`,
          ).toBe(true);
        }
      }

      h.close();
    }, 60_000);
  }
});

describe('chaos: a flatten is honest about whether it worked', () => {
  it('never reports complete while the venue still holds a position', async () => {
    const h = createHarness({ seed: 31, faults: CHAOS, medianLatencyMs: 20 });
    await h.run(h.broker.connect());
    h.quote('XAUUSD', '2400.00', '2400.30');
    await h.syncAccount();

    for (let i = 0; i < 6; i++) {
      await h.run(
        h.supervisor.submit({
          intentId: uuidFor(31, i),
          canonical: 'XAUUSD',
          side: 'buy',
          kind: 'market',
          timeInForce: 'GTC',
          stopPrice: d('2380.00'),
          riskPct: d('0.003'),
          acknowledgeManualSize: false,
          preTradeNote: `flatten test ${i}`,
          tags: [],
        }),
      );
      await h.clock.advance(20_000);
      h.quote('XAUUSD', '2400.00', '2400.30');
      await h.syncAccount();
    }

    const report = await h.run(h.guard.flatten('manual', 'chaos'));
    const remaining = h.broker.isConnected() ? (await h.run(h.broker.getPositions())).length : -1;

    if (report.status === 'complete') {
      expect(remaining, 'reported complete while positions remain').toBe(0);
    } else {
      // Partial or failed is fine — what matters is that it said so.
      expect(['partial', 'failed']).toContain(report.status);
      expect(report.detail.length).toBeGreaterThan(0);
    }
    h.close();
  }, 60_000);
});

describe('chaos: reconciliation converges', () => {
  it('reaches a clean book once the chaos stops', async () => {
    const h = createHarness({ seed: 64, faults: CHAOS, medianLatencyMs: 20 });
    await h.run(h.broker.connect());
    h.quote('XAUUSD', '2400.00', '2400.30');
    await h.syncAccount();

    for (let i = 0; i < 8; i++) {
      await h.run(
        h.supervisor.submit({
          intentId: uuidFor(64, i),
          canonical: 'XAUUSD',
          side: i % 2 === 0 ? 'buy' : 'sell',
          kind: 'market',
          timeInForce: 'GTC',
          stopPrice: i % 2 === 0 ? d('2380.00') : d('2420.00'),
          riskPct: d('0.003'),
          acknowledgeManualSize: false,
          preTradeNote: `converge ${i}`,
          tags: [],
        }),
      );
      await h.clock.advance(20_000);
      h.quote('XAUUSD', '2400.00', '2400.30');
      await h.syncAccount();
    }

    // Stop the chaos: reconnect, settle, flatten, and let everything drain.
    if (!h.broker.isConnected()) await h.run(h.broker.connect());
    await h.clock.advance(600_000);
    await h.run(h.guard.flatten('manual', 'converge'));
    await h.clock.advance(60_000);

    const finalRun = await h.run(h.reconciler.runOnce());
    // Divergences that remain must all be resolvable ones, not contradictions
    // needing a human. A system that cannot converge after the noise stops is
    // one that accumulates unexplained state.
    const needsHuman = finalRun.divergences.filter((x) => x.action === 'alert-operator');
    expect(
      needsHuman.map((x) => `${x.kind}: ${x.detail}`),
      'unresolvable divergences remained after the chaos stopped',
    ).toEqual([]);

    h.close();
  }, 90_000);
});
