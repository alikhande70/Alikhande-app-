import * as D from '@keel/core';
import { defaultRiskPolicy } from '@keel/core';
import type { Logger } from 'pino';
import pino from 'pino';
import { AlertEngine, NullPushSender } from './alerts/engine.js';
import { ExpoPushSender } from './alerts/push.js';
import { Mt5BrokerAdapter } from './broker/mt5/adapter.js';
import { Mt5HostClient } from './broker/mt5/host-client.js';
import {
  Mt5InstrumentBinding,
  type Mt5InstrumentMetadataByCanonical,
} from './broker/mt5/instrument-binding.js';
import { Mt5SymbolMap } from './broker/mt5/symbol-map.js';
import { OandaBroker } from './broker/oanda/adapter.js';
import { OandaClient } from './broker/oanda/client.js';
import { PaperBroker, REALISTIC_FAULTS } from './broker/paper.js';
import type { BrokerPort } from './broker/port.js';
import { describeCapabilities } from './broker/port.js';
import type { DeskConfig } from './config.js';
import { loadConfig } from './config.js';
import { Guard } from './engine/guard.js';
import { Reconciler } from './engine/reconciler.js';
import { pendingResolutions, UnknownResolver } from './engine/resolver.js';
import { DeskState, specToJson } from './engine/state.js';
import { clientOrderIdFor, ExecutionSupervisor } from './engine/supervisor.js';
import { Authenticator } from './http/auth.js';
import { buildServer, buildSnapshot, orderToWire } from './http/server.js';
import { Ledger } from './ledger/ledger.js';
import { Projector } from './ledger/projections.js';
import { CryptoComProvider } from './marketdata/cryptocom.js';
import { MissionRuntime } from './missions/runtime.js';
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
  const missionRuntime = new MissionRuntime(ledger);

  // --- Broker ---------------------------------------------------------------
  const broker = buildBroker(config, clock, log);
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

  /**
   * One place anomalies become alerts, shared by the supervisor, the resolver
   * and the reconciler — so a contradiction surfaces identically whichever
   * component noticed it.
   */
  function raiseAnomaly(intentId: string, anomaly: D.Anomaly): void {
    if (anomaly.severity !== 'critical') return;
    alerts.raise({
      kind: 'anomaly',
      severity: 'critical',
      title: `Broker contradiction on ${intentId.slice(0, 8)}`,
      body: anomaly.detail,
      route: `/orders/${intentId}`,
      dedupeKey: `anomaly:${intentId}:${anomaly.kind}`,
    });
  }

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
    onAnomaly: (intentId, anomaly) => raiseAnomaly(intentId, anomaly),
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
    onAnomaly: (intentId, anomaly) => raiseAnomaly(intentId, anomaly),
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
    onAnomaly: (intentId, anomaly) => raiseAnomaly(intentId, anomaly),
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
      case 'fill': {
        // Routed through the supervisor, which is the single place an order
        // event enters the ledger — and therefore the only place that records
        // and escalates the anomalies the state machine computes.
        const intentId = intentForClientOrderId(ledger, e.clientOrderId);
        if (intentId !== undefined) {
          supervisor.applyVenueEvent(intentId, {
            type: 'fill',
            at: e.at,
            fillId: e.fillId,
            qty: e.qty,
            price: e.price,
          });
        } else {
          log.warn({ clientOrderId: e.clientOrderId }, 'fill for an order this desk did not place');
        }
        hub.publish('positions', buildSnapshot(serverDeps).positions);
        hub.publish('orders', buildSnapshot(serverDeps).orders);
        break;
      }
      case 'position': {
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
        const mission = missionRuntime.observeBrokerEvent(broker.name, e);
        hub.publish('positions', buildSnapshot(serverDeps).positions);
        if (mission !== undefined) hub.publish('missions', missionRuntime.listRecent());
        break;
      }
      case 'positionClosed': {
        ledger.append({
          kind: 'position.closed',
          positionId: e.positionId,
          exitPrice: D.Decimal.toString(e.exitPrice),
          netPnl: D.Decimal.toString(e.netPnl),
          costs: D.Decimal.toString(e.costs),
          closedAt: e.at,
        });
        projector.catchUp();
        const mission = missionRuntime.observeBrokerEvent(broker.name, e);
        hub.publish('positions', buildSnapshot(serverDeps).positions);
        if (mission !== undefined) hub.publish('missions', missionRuntime.listRecent());
        break;
      }
      case 'order':
        projector.catchUp();
        hub.publish('orders', buildSnapshot(serverDeps).orders);
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
      criticalDivergences: reconciler.openDivergences.filter((d) => d.severity === 'critical')
        .length,
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

  /**
   * Cancel an order, for real.
   *
   * An earlier version of this endpoint read the order's state and returned a
   * note saying a cancel had been requested, without sending anything. That is
   * worse than an unimplemented endpoint: the operator is told their cancel is
   * in flight while the order is still working. Found in audit.
   *
   * Like every other command path, an ambiguous outcome is reported as unknown
   * rather than as failure — a cancel that timed out may well have landed.
   */
  async function cancelOrder(intentId: string, reply: { status: (c: number) => unknown }) {
    projector.catchUp();
    const record = projector.loadOrderRecord(intentId);
    if (record === undefined) {
      reply.status(404);
      return { code: 'NOT_FOUND', title: 'No such intent', detail: intentId };
    }
    if (record.venueOrderId === undefined) {
      reply.status(409);
      return {
        code: 'NOT_AT_VENUE',
        title: 'Nothing to cancel yet',
        detail:
          `This order is ${record.state} and has no venue id, so there is nothing for the broker ` +
          'to cancel. If its outcome is unknown, resolution is already chasing it.',
      };
    }

    supervisor.applyVenueEvent(intentId, { type: 'cancel.requested', at: clock.now() });

    const result = await broker.cancelOrder(record.venueOrderId, clientOrderIdFor(intentId));
    switch (result.outcome) {
      case 'acked':
        supervisor.applyVenueEvent(intentId, { type: 'cancel.acked', at: result.at });
        return { ok: true, state: 'CANCELLED', detail: 'the broker acknowledged the cancel' };
      case 'rejected':
        supervisor.applyVenueEvent(intentId, {
          type: 'cancel.rejected',
          at: result.at,
          reason: result.reason,
        });
        reply.status(409);
        return {
          code: result.code ?? 'CANCEL_REJECTED',
          title: 'The broker refused the cancel',
          detail: `${result.reason}. The order is still live.`,
          outcomeUnknown: false,
        };
      case 'ambiguous':
        supervisor.applyVenueEvent(intentId, {
          type: 'submit.ambiguous',
          at: result.at,
          reason: `cancel: ${result.reason}`,
        });
        reply.status(202);
        return {
          code: 'OUTCOME_UNKNOWN',
          title: 'Cancel outcome unknown',
          detail:
            `${result.reason}. The cancel may or may not have reached the broker. Reconciliation ` +
            'will settle it — do not resend.',
          outcomeUnknown: true,
        };
    }
  }

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
    missions: missionRuntime,
    health,
    cancelOrder,
  };

  // --- Topics ---------------------------------------------------------------
  hub.registerTopic('health', () => health());
  hub.registerTopic('account', () => buildSnapshot(serverDeps).account);
  hub.registerTopic('positions', () => buildSnapshot(serverDeps).positions);
  hub.registerTopic('orders', () => buildSnapshot(serverDeps).orders);
  hub.registerTopic('missions', () => missionRuntime.listRecent());
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

function buildBroker(config: DeskConfig, clock: typeof systemClock, log: Logger): BrokerPort {
  switch (config.broker) {
    case 'mt5': {
      // loadConfig has already refused to reach here without a host, a token
      // and instrument metadata, so these narrowings are not checks.
      const client = new Mt5HostClient({
        baseUrl: config.mt5HostUrl as string,
        token: config.mt5HostToken as string,
      });
      const symbolMap = new Mt5SymbolMap(
        config.mt5SymbolAliases === undefined
          ? {}
          : (JSON.parse(config.mt5SymbolAliases) as Record<string, string>),
      );
      const binding = new Mt5InstrumentBinding(
        symbolMap,
        JSON.parse(config.mt5InstrumentMetadata as string) as Mt5InstrumentMetadataByCanonical,
      );
      const adapter = new Mt5BrokerAdapter({
        client,
        systemPrefix: config.mt5SystemPrefix,
        instrumentBinding: binding,
        allowedTradeModes: config.mt5AllowedTradeModes,
        allowRealTrading: config.mt5AllowRealTrading,
      });
      log.warn(
        { executionEnabled: adapter.executionEnabled },
        'MT5 adapter selected; OrderSend is deliberately absent from the agent in this build, ' +
          'so orders are preflighted and never transmitted',
      );
      return adapter;
    }
    case 'oanda': {
      // loadConfig has already refused to get here without both credentials,
      // so the assertions below are a type narrowing rather than a check.
      const client = new OandaClient({
        token: config.oandaToken as string,
        accountId: config.oandaAccountId as string,
        environment: config.oandaEnvironment,
      });
      return new OandaBroker({
        client,
        clock,
        log,
        instruments: config.instruments,
      });
    }
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

/** Find the intent that produced a venue-side client order id. */
function intentForClientOrderId(
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

function orderRow(ledger: Ledger, intentId: string): Record<string, unknown> {
  return (ledger.db.prepare('SELECT * FROM orders WHERE intent_id = ?').get(intentId) ??
    {}) as Record<string, unknown>;
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url.endsWith(process.argv[1].replace(/^.*[/\\]/, ''));
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
      process.stderr.write(
        `desk failed to start: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    });
}
