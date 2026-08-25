import * as D from '@keel/core';
import { defaultRiskPolicy } from '@keel/core';
import pino from 'pino';
import { AlertEngine, NullPushSender } from './alerts/engine.js';
import { ExpoPushSender } from './alerts/push.js';
import { PaperBroker, REALISTIC_FAULTS } from './broker/paper.js';
import type { BrokerPort } from './broker/port.js';
import { describeCapabilities } from './broker/port.js';
import { loadConfig } from './config.js';
import type { DeskConfig } from './config.js';
import { Guard } from './engine/guard.js';
import { Reconciler } from './engine/reconciler.js';
import { UnknownResolver, pendingResolutions } from './engine/resolver.js';
import { DeskState, specToJson } from './engine/state.js';
import { ExecutionSupervisor, clientOrderIdFor } from './engine/supervisor.js';
import { buildServer, buildSnapshot, orderToWire } from './http/server.js';
import { Authenticator } from './http/auth.js';
import { Ledger } from './ledger/ledger.js';
import { Projector } from './ledger/projections.js';
import { CryptoComProvider } from './marketdata/cryptocom.js';
import { RealtimeHub } from './realtime/hub.js';
import { systemClock } from './sim/clock.js';

/**
 * The desk, assembled.
 *
 * Boot order matters and is deliberate:
 *
 *   1. Open the ledger and verify its hash chain. A corrupted history is a
 *      refuse-to-start condition, not a warning — everything downstream treats
 *      the ledger as ground truth.
 *   2. Rebuild projections up to the ledger head.
 *   3. Recover in-flight intents *before* accepting any new ones, so an order
 *      left unresolved by a crash is being chased before the operator can add
 *      to the problem.
 *   4. Only then open the socket.
 */

export interface Desk {
  readonly stop: () => Promise<void>;
  readonly url: string;
  /**
   * Mint a one-time enrolment code.
   *
   * Deliberately not a network endpoint: an endpoint that hands out enrolment
   * codes is a way in for anyone who can reach the port. Codes are produced by
   * the desk process itself — printed to its console, or minted by operator
   * tooling running on the same host.
   */
  readonly createEnrolmentCode: (label: string, ttlMs?: number) => string;
}

export async function startDesk(config: DeskConfig = loadConfig()): Promise<Desk> {
  const log = pino({ level: config.logLevel });
  const clock = systemClock;

  // --- 1. Ledger ------------------------------------------------------------
  const ledger = new Ledger({
    path: config.dataDir === ':memory:' ? ':memory:' : `${config.dataDir}/keel.db`,
    synchronous: config.synchronous,
  });

  const integrity = ledger.verifyChain();
  if (!integrity.ok) {
    log.fatal(
      { failedAt: integrity.failedAt, reason: integrity.reason },
      'ledger integrity check failed; refusing to start',
    );
    throw new Error(
      `ledger integrity check failed at seq ${integrity.failedAt}: ${integrity.reason}. ` +
        'The trading history has been altered or truncated. Restore from a backup rather than ' +
        'starting on top of it.',
    );
  }
  log.info({ rows: integrity.rows, head: ledger.head.seq }, 'ledger verified');

  // --- 2. Projections -------------------------------------------------------
  const projector = new Projector(ledger);
  const applied = projector.catchUp();
  log.info({ applied, watermark: projector.watermark }, 'projections up to date');

  const policy = defaultRiskPolicy({ accountCurrency: config.accountCurrency });
  const state = new DeskState(ledger, projector, clock, policy);

  // --- Broker ---------------------------------------------------------------
  const broker = buildBroker(config, clock);
  log.info(
    { broker: broker.name, notes: describeCapabilities(broker.capabilities) },
    'broker adapter selected',
  );

  const hub = new RealtimeHub({ clock, log });
  const auth = new Authenticator(clock);

  const push =
    config.expoPushToken === undefined
      ? new NullPushSender()
      : new ExpoPushSender({ token: config.expoPushToken });

  const alerts = new AlertEngine({
    ledger,
    projector,
    clock,
    log,
    push,
    onAlert: (a) => hub.publish('alerts', [a]),
  });

  const resolver = new UnknownResolver({
    ledger,
    projector,
    broker,
    clock,
    log,
    onEscalate: (intentId, attempts, detail) => {
      alerts.raise({
        kind: 'execution',
        severity: 'critical',
        title: 'Order outcome still unknown',
        body:
          `Intent ${intentId} has not been resolved after ${attempts} attempts. ${detail}. ` +
          'Check the broker terminal before placing anything else on this instrument.',
        route: `/orders/${intentId}`,
        dedupeKey: `unresolved:${intentId}`,
      });
    },
    onResolved: (intentId, how) => {
      alerts.clear(`unresolved:${intentId}`);
      log.info({ intentId, how }, 'unknown outcome resolved');
      hub.publish('orders', [orderToWire(orderRow(ledger, intentId))]);
    },
  });

  const supervisor = new ExecutionSupervisor({
    ledger,
    projector,
    state,
    broker,
    clock,
    log,
    onUnknown: (intentId, clientOrderId) => resolver.start(intentId, clientOrderId),
    onAnomaly: (intentId, anomaly) => {
      if (anomaly.severity !== 'critical') return;
      alerts.raise({
        kind: 'anomaly',
        severity: 'critical',
        title: `Broker contradiction on ${intentId}`,
        body: anomaly.detail,
        route: `/orders/${intentId}`,
        dedupeKey: `anomaly:${intentId}:${anomaly.kind}`,
      });
    },
  });

  const guard = new Guard({
    ledger,
    projector,
    state,
    broker,
    clock,
    log,
    intervalMs: config.guardIntervalMs,
    onAlert: (a) => alerts.raise({ ...a, dedupeKey: `guard:${a.title}` }),
  });

  const reconciler = new Reconciler({
    ledger,
    projector,
    state,
    broker,
    clock,
    log,
    intervalMs: config.reconcileIntervalMs,
    onDivergence: (d, id, isNew) => {
      if (!isNew) return;
      hub.publish('divergences', reconciler.openDivergences);
      if (d.severity !== 'critical') return;
      alerts.raise({
        kind: 'divergence',
        severity: 'critical',
        title: `Broker disagrees: ${d.kind}`,
        body: d.detail,
        route: '/divergences',
        dedupeKey: `divergence:${id}`,
      });
    },
  });

  // --- Broker event wiring --------------------------------------------------
  broker.on((e) => {
    switch (e.type) {
      case 'connected':
        ledger.append({
          kind: 'broker.connected',
          broker: broker.name,
          capabilities: broker.capabilities as unknown as Record<string, unknown>,
        });
        hub.publish('health', health());
        break;
      case 'disconnected':
        ledger.append({ kind: 'broker.disconnected', broker: broker.name, reason: e.reason });
        alerts.raise({
          kind: 'connection',
          severity: 'critical',
          title: 'Broker disconnected',
          body: `${broker.name}: ${e.reason}. Order entry is blocked until it returns.`,
          dedupeKey: 'broker-disconnected',
        });
        hub.publish('health', health());
        break;
      case 'quote':
        state.setExecutionQuote(e.quote);
        hub.publish('quotes', [
          {
            canonical: e.quote.canonical,
            bid: D.Decimal.toString(e.quote.bid),
            ask: D.Decimal.toString(e.quote.ask),
            spread: D.Decimal.toString(D.Decimal.sub(e.quote.ask, e.quote.bid)),
            provenance: { source: 'broker', asOf: e.quote.asOf },
            stale: false,
          },
        ]);
        break;
      case 'account':
        ledger.append({
          kind: 'account.observed',
          currency: e.account.currency,
          balance: D.Decimal.toString(e.account.balance),
          equity: D.Decimal.toString(e.account.equity),
          marginUsed: D.Decimal.toString(e.account.marginUsed),
          marginFree: D.Decimal.toString(e.account.marginFree),
          asOf: e.account.asOf,
          source: 'broker',
        });
        projector.catchUp();
        void guard.evaluate();
        hub.publish('account', buildSnapshot(serverDeps).account);
        break;
      case 'fill':
      case 'order':
      case 'position':
      case 'positionClosed':
        // These are folded in by the reconciler and the supervisor; publishing
        // the projection rather than the raw event keeps one shape on the wire.
        projector.catchUp();
        hub.publish('positions', buildSnapshot(serverDeps).positions);
        break;
      default:
        break;
    }
  });

  function health(): Record<string, unknown> {
    const undelivered = alerts.undeliveredCritical();
    return {
      brokerConnected: broker.isConnected(),
      brokerName: broker.name,
      referenceFeedConnected: reference?.isConnected() ?? false,
      openDivergences: reconciler.openDivergences.length,
      criticalDivergences: reconciler.openDivergences.filter((d) => d.severity === 'critical').length,
      unresolvedOrders: resolver.activeJobs,
      undeliveredCriticalAlerts: undelivered.length,
      lockout: state.lockout(),
      credentialsLocked: false,
      deskStartedAt: startedAt,
      version: process.env.KEEL_VERSION ?? '0.1.0',
    };
  }

  const startedAt = clock.now();
  const reference =
    config.referenceProvider === 'cryptocom' ? new CryptoComProvider({ clock }) : undefined;

  const serverDeps = {
    config,
    clock,
    log,
    ledger,
    projector,
    state,
    supervisor,
    guard,
    reconciler,
    alerts,
    hub,
    auth,
    health,
  };

  // --- Topics ---------------------------------------------------------------
  hub.registerTopic('health', () => health());
  hub.registerTopic('account', () => buildSnapshot(serverDeps).account);
  hub.registerTopic('positions', () => buildSnapshot(serverDeps).positions);
  hub.registerTopic('orders', () => buildSnapshot(serverDeps).orders);
  hub.registerTopic('divergences', () => reconciler.openDivergences);
  hub.registerTopic('drawdown', () => buildSnapshot(serverDeps).drawdown);
  hub.registerTopic('alerts', () => alerts.recentAlerts(30));
  hub.registerTopic('quotes', () => buildSnapshot(serverDeps).quotes);

  ledger.append({
    kind: 'desk.started',
    version: process.env.KEEL_VERSION ?? '0.1.0',
    config: { broker: config.broker, instruments: config.instruments, host: config.host },
  });
  projector.catchUp();

  // --- 3. Recover before accepting anything new -----------------------------
  await broker.connect();
  const instruments = await broker.getInstruments();
  for (const spec of instruments) {
    ledger.append({
      kind: 'instrument.observed',
      canonical: spec.canonical,
      spec: specToJson(spec),
      asOf: spec.asOf,
    });
  }
  projector.catchUp();

  const pending = pendingResolutions(projector, ledger.db);
  if (pending.length > 0) {
    log.warn({ count: pending.length }, 'resuming unresolved intents from a previous run');
    resolver.resumeAll(pending.map((p) => ({ ...p, clientOrderId: clientOrderIdFor(p.intentId) })));
  }

  guard.start();
  reconciler.start();
  hub.start();

  if (reference !== undefined) {
    await reference.connect();
    await reference.subscribe(config.instruments);
    reference.on((e) => {
      if (e.type === 'tick') state.setReferenceQuote({ ...e.tick, canonical: e.tick.canonical });
    });
  }

  // --- 4. Serve -------------------------------------------------------------
  const app = await buildServer(serverDeps);
  await app.listen({ host: config.host, port: config.port });
  const url = `http://${config.host}:${config.port}`;
  log.info({ url }, 'desk listening');

  // An enrolment code on every cold start with no devices: the operator needs
  // a way in, and printing it only to the desk's own console keeps it out of
  // any network path.
  if (auth.listDevices().length === 0) {
    const code = auth.createEnrolmentCode('first device', 900_000);
    log.info({ code }, 'no devices enrolled — pair within 15 minutes using this code');
  }

  return {
    url,
    createEnrolmentCode: (label: string, ttlMs = 300_000) => auth.createEnrolmentCode(label, ttlMs),
    stop: async () => {
      guard.stop();
      reconciler.stop();
      resolver.stopAll();
      hub.stop();
      await reference?.disconnect();
      ledger.append({ kind: 'desk.stopping', reason: 'shutdown requested' });
      await app.close();
      await broker.disconnect();
      ledger.close();
    },
  };
}

function buildBroker(config: DeskConfig, clock: typeof systemClock): BrokerPort {
  switch (config.broker) {
    case 'paper':
      return new PaperBroker(
        {
          seed: Date.now() & 0xffff,
          currency: config.accountCurrency,
          startingBalance: D.dec('10000.00'),
          instruments: [D.Fixtures.XAUUSD, D.Fixtures.EURUSD, D.Fixtures.GBPJPY],
          faults: REALISTIC_FAULTS,
          medianLatencyMs: 60,
          slippageTicks: 1,
          commissionPerLot: D.dec('3.50'),
        },
        clock,
      );
    default:
      throw new Error(
        `broker '${config.broker}' is configured but its adapter is not available in this build. ` +
          'See docs/VERIFICATION.md for the status of each adapter.',
      );
  }
}

function orderRow(ledger: Ledger, intentId: string): Record<string, unknown> {
  return (ledger.db.prepare('SELECT * FROM orders WHERE intent_id = ?').get(intentId) ?? {}) as Record<
    string,
    unknown
  >;
}

const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/^.*[/\\]/, ''));
if (isMain) {
  startDesk()
    .then((desk) => {
      const shutdown = (signal: string): void => {
        void desk.stop().then(() => process.exit(0));
        setTimeout(() => process.exit(1), 10_000).unref();
        process.stderr.write(`\nreceived ${signal}, shutting down\n`);
      };
      process.on('SIGINT', () => shutdown('SIGINT'));
      process.on('SIGTERM', () => shutdown('SIGTERM'));
    })
    .catch((err: unknown) => {
      process.stderr.write(`desk failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
