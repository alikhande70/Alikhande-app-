import type { InstrumentSpec, RiskPolicy } from '@keel/core';
import * as D from '@keel/core';
import { defaultRiskPolicy } from '@keel/core';
import type { Logger } from 'pino';
import pino from 'pino';
import type { PaperConfig, PaperFaults } from '../broker/paper.js';
import { NO_FAULTS, PaperBroker } from '../broker/paper.js';
import type { BrokerQuote } from '../broker/port.js';
import { Ledger } from '../ledger/ledger.js';
import { Projector } from '../ledger/projections.js';
import { TestClock } from '../sim/clock.js';
import { Guard } from './guard.js';
import { Reconciler } from './reconciler.js';
import { UnknownResolver } from './resolver.js';
import { DeskState, specToJson } from './state.js';
import { ExecutionSupervisor } from './supervisor.js';

/**
 * A whole desk, wired up, in memory, on a clock the test controls.
 *
 * Shared by the integration and chaos suites so both exercise the *same*
 * assembly the production entry point builds — a test harness that wires
 * components differently from production tests a system nobody runs.
 */

export interface HarnessOptions {
  readonly seed?: number;
  readonly startAt?: number;
  readonly instruments?: readonly InstrumentSpec[];
  readonly faults?: Partial<PaperFaults>;
  readonly policy?: Partial<RiskPolicy>;
  readonly startingBalance?: string;
  readonly medianLatencyMs?: number;
  readonly slippageTicks?: number;
  readonly silent?: boolean;
}

export interface Harness {
  readonly clock: TestClock;
  readonly ledger: Ledger;
  readonly projector: Projector;
  readonly state: DeskState;
  readonly broker: PaperBroker;
  readonly supervisor: ExecutionSupervisor;
  readonly resolver: UnknownResolver;
  readonly reconciler: Reconciler;
  readonly guard: Guard;
  readonly log: Logger;
  readonly escalations: Array<{ intentId: string; attempts: number; detail: string }>;
  readonly anomalies: Array<{ intentId: string; anomaly: D.Anomaly }>;
  readonly alerts: Array<{ kind: string; severity: string; title: string; body: string }>;
  readonly divergenceEvents: Array<{ kind: string; id: string; isNew: boolean }>;
  quote(canonical: string, bid: string, ask: string): void;
  syncAccount(): Promise<void>;
  /** Await a promise while driving the test clock. See `TestClock.settle`. */
  run<T>(p: Promise<T>): Promise<T>;
  /** Stop consuming broker events, modelling the desk being down. */
  detachBrokerEvents(): void;
  close(): void;
}

/** Monday 15 June 2026, 14:00 UTC — London/New York overlap, market open. */
export const HARNESS_START = Date.UTC(2026, 5, 15, 14, 0);

export function createHarness(opts: HarnessOptions = {}): Harness {
  const clock = new TestClock(opts.startAt ?? HARNESS_START);
  const log = pino({ level: opts.silent === false ? 'info' : 'silent' });
  const instruments = opts.instruments ?? [
    { ...D.Fixtures.XAUUSD, asOf: clock.now() },
    { ...D.Fixtures.EURUSD, asOf: clock.now() },
  ];

  const ledger = new Ledger({ path: ':memory:', synchronous: 'OFF', now: () => clock.now() });
  const projector = new Projector(ledger);

  const paperConfig: PaperConfig = {
    seed: opts.seed ?? 1,
    currency: 'USD',
    startingBalance: D.dec(opts.startingBalance ?? '10000.00'),
    instruments,
    faults: { ...NO_FAULTS, ...opts.faults },
    medianLatencyMs: opts.medianLatencyMs ?? 40,
    slippageTicks: opts.slippageTicks ?? 0,
    commissionPerLot: D.dec('3.50'),
  };
  const broker = new PaperBroker(paperConfig, clock);

  const policy = defaultRiskPolicy({
    // The harness's default day starts flat at the harness start time.
    ...opts.policy,
  });
  const state = new DeskState(ledger, projector, clock, policy);

  for (const spec of instruments) {
    ledger.append({
      kind: 'instrument.observed',
      canonical: spec.canonical,
      spec: specToJson(spec),
      asOf: spec.asOf,
    });
  }
  projector.catchUp();

  const escalations: Array<{ intentId: string; attempts: number; detail: string }> = [];
  const anomalies: Array<{ intentId: string; anomaly: D.Anomaly }> = [];

  const resolver = new UnknownResolver({
    ledger,
    projector,
    broker,
    clock,
    log,
    onEscalate: (intentId, attempts, detail) => escalations.push({ intentId, attempts, detail }),
    onResolved: () => undefined,
  });

  const alerts: Array<{ kind: string; severity: string; title: string; body: string }> = [];
  const divergenceEvents: Array<{ kind: string; id: string; isNew: boolean }> = [];

  const reconciler = new Reconciler({
    ledger,
    projector,
    state,
    broker,
    clock,
    log,
    onDivergence: (d, id, isNew) => divergenceEvents.push({ kind: d.kind, id, isNew }),
  });

  const guard = new Guard({
    ledger,
    projector,
    state,
    broker,
    clock,
    log,
    onAlert: (a) => alerts.push(a),
  });

  const supervisor = new ExecutionSupervisor({
    ledger,
    projector,
    state,
    broker,
    clock,
    log,
    onUnknown: (intentId, clientOrderId) => resolver.start(intentId, clientOrderId),
    onAnomaly: (intentId, anomaly) => anomalies.push({ intentId, anomaly }),
  });

  // Registered after the supervisor exists, because fills route through it.
  const detach = broker.on((e) => {
    switch (e.type) {
      case 'quote':
        state.setExecutionQuote(e.quote);
        break;
      case 'fill': {
        const intentId = intentFromClientOrderId(ledger, e.clientOrderId);
        if (intentId === undefined) break;
        // Through the supervisor, which is the single route an order event
        // takes into the ledger — the same route production uses, so anomalies
        // are recorded and escalated here too.
        supervisor.applyVenueEvent(intentId, {
          type: 'fill',
          at: e.at,
          fillId: e.fillId,
          qty: e.qty,
          price: e.price,
        });
        break;
      }
      case 'position':
        ledger.append({
          kind: 'position.observed',
          positionId: e.position.positionId,
          canonical: e.position.canonical,
          symbol: e.position.symbol,
          side: e.position.side,
          volume: D.Decimal.toString(e.position.volume),
          entryPrice: D.Decimal.toString(e.position.entryPrice),
          openedAt: e.position.openedAt,
          foreign: e.position.clientOrderId === undefined,
          asOf: e.at,
          ...(e.position.stopPrice !== undefined
            ? { stopPrice: D.Decimal.toString(e.position.stopPrice) }
            : {}),
          ...(e.position.takeProfitPrice !== undefined
            ? { takeProfitPrice: D.Decimal.toString(e.position.takeProfitPrice) }
            : {}),
        });
        projector.catchUp();
        break;
      case 'positionClosed':
        ledger.append({
          kind: 'position.closed',
          positionId: e.positionId,
          exitPrice: D.Decimal.toString(e.exitPrice),
          netPnl: D.Decimal.toString(e.netPnl),
          costs: D.Decimal.toString(e.costs),
          closedAt: e.at,
        });
        projector.catchUp();
        break;
      case 'account':
        ledger.append({
          kind: 'account.observed',
          currency: e.account.currency,
          balance: D.Decimal.toString(e.account.balance),
          equity: D.Decimal.toString(e.account.equity),
          marginUsed: D.Decimal.toString(e.account.marginUsed),
          marginFree: D.Decimal.toString(e.account.marginFree),
          asOf: e.at,
          source: 'broker',
        });
        projector.catchUp();
        break;
      default:
        break;
    }
  });

  return {
    clock,
    ledger,
    projector,
    state,
    broker,
    supervisor,
    resolver,
    reconciler,
    guard,
    log,
    escalations,
    anomalies,
    alerts,
    divergenceEvents,
    quote(canonical, bid, ask) {
      broker.setQuote({
        canonical,
        bid: D.dec(bid),
        ask: D.dec(ask),
        asOf: clock.now(),
      });
      state.setExecutionQuote({
        canonical,
        bid: D.dec(bid),
        ask: D.dec(ask),
        asOf: clock.now(),
      } as BrokerQuote);
    },
    run<T>(p: Promise<T>) {
      return clock.settle(p);
    },
    detachBrokerEvents() {
      detach();
    },
    async syncAccount() {
      const acct = await clock.settle(broker.getAccount());
      ledger.append({
        kind: 'account.observed',
        currency: acct.currency,
        balance: D.Decimal.toString(acct.balance),
        equity: D.Decimal.toString(acct.equity),
        marginUsed: D.Decimal.toString(acct.marginUsed),
        marginFree: D.Decimal.toString(acct.marginFree),
        asOf: clock.now(),
        source: 'broker',
      });
      projector.catchUp();
    },
    close() {
      resolver.stopAll();
      reconciler.stop();
      guard.stop();
      ledger.close();
    },
  };
}

function intentFromClientOrderId(
  ledger: Ledger,
  clientOrderId: string | undefined,
): string | undefined {
  if (clientOrderId === undefined) return undefined;
  const row = ledger.db
    .prepare(
      `SELECT stream FROM ledger
       WHERE kind = 'intent.created' AND json_extract(payload, '$.intent.clientOrderId') = ?
       LIMIT 1`,
    )
    .get(clientOrderId) as { stream: string } | undefined;
  return row?.stream;
}
