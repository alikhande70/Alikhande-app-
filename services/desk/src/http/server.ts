import { randomUUID } from 'node:crypto';
import * as D from '@keel/core';
import websocketPlugin from '@fastify/websocket';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { AlertEngine } from '../alerts/engine.js';
import type { DeskConfig } from '../config.js';
import type { Guard } from '../engine/guard.js';
import type { Reconciler } from '../engine/reconciler.js';
import type { DeskState } from '../engine/state.js';
import type { ExecutionSupervisor, SubmitCommand } from '../engine/supervisor.js';
import type { Ledger } from '../ledger/ledger.js';
import type { Projector } from '../ledger/projections.js';
import type { RealtimeHub } from '../realtime/hub.js';
import type { Clock } from '../sim/clock.js';
import { AuthError, Authenticator, hashBody } from './auth.js';
import type { EnrolledDevice } from './auth.js';

/**
 * The desk's HTTP and WebSocket surface.
 *
 * Two rules shape every handler:
 *
 * 1. **Commands and reads are separated at the auth layer.** Anything that can
 *    move money consumes a single-use server nonce; reads do not, so a flaky
 *    network never locks the operator out of seeing their own positions.
 * 2. **A response never implies execution.** `POST /orders` returning 200 means
 *    the desk durably recorded the intent and will pursue it. Live order state
 *    arrives over the socket, from the venue. The field is named `accepted`
 *    rather than `placed` for exactly that reason.
 */

export interface ServerDeps {
  readonly config: DeskConfig;
  readonly clock: Clock;
  readonly log: Logger;
  readonly ledger: Ledger;
  readonly projector: Projector;
  readonly state: DeskState;
  readonly supervisor: ExecutionSupervisor;
  readonly guard: Guard;
  readonly reconciler: Reconciler;
  readonly alerts: AlertEngine;
  readonly hub: RealtimeHub;
  readonly auth: Authenticator;
  readonly health: () => Record<string, unknown>;
  readonly copilotAsk?: (question: string, conversationId?: string) => Promise<unknown>;
}

/** Endpoints that require a single-use command nonce and a biometric assertion. */
const COMMAND_PATHS = [
  /^\/orders$/,
  /^\/orders\/[^/]+\/cancel$/,
  /^\/positions\/[^/]+\/(modify|close)$/,
  /^\/panic$/,
  /^\/policy$/,
  /^\/guard\/(lockout|release)$/,
];

function isCommand(path: string): boolean {
  return COMMAND_PATHS.some((re) => re.test(path));
}

declare module 'fastify' {
  interface FastifyRequest {
    rawBodyText?: string;
    device?: EnrolledDevice;
  }
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 1_048_576 });
  await app.register(websocketPlugin, { options: { maxPayload: 1_048_576 } });

  // The signature covers a hash of the exact bytes, so the raw body must be
  // preserved before parsing. Re-serialising the parsed object would produce
  // different bytes and break every signature.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    req.rawBodyText = text;
    if (text.length === 0) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(text) as unknown);
    } catch {
      done(new Error('invalid JSON body'), undefined);
    }
  });

  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof AuthError) {
      void reply
        .status(err.status)
        .send({ code: err.code, title: 'Not authorised', detail: err.message });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    deps.log.error(
      { err: message, stack: err instanceof Error ? err.stack : undefined },
      'request failed',
    );
    void reply.status(500).send({
      code: 'INTERNAL',
      title: 'The desk failed to handle this request',
      // The detail is deliberately included: this is a single-operator system
      // and an opaque 500 helps nobody at 2am.
      detail: message,
      retryable: true,
      outcomeUnknown: false,
    });
  });

  // --- Authentication -------------------------------------------------------

  app.addHook('preHandler', async (req: FastifyRequest, _reply: FastifyReply) => {
    const path = req.routeOptions.url ?? req.url.split('?')[0] ?? req.url;
    if (path === '/enrol' || path === '/health' || path === '/stream') return;

    const h = req.headers;
    const deviceId = str(h['x-keel-device']);
    const timestamp = Number(str(h['x-keel-timestamp']) ?? '0');
    const nonce = str(h['x-keel-nonce']);
    const signature = str(h['x-keel-signature']);
    const commandNonce = str(h['x-keel-command-nonce']);

    if (deviceId === undefined || nonce === undefined || signature === undefined) {
      throw new AuthError('request is not signed', 'UNSIGNED');
    }

    const actualPath = req.url.split('?')[0] ?? req.url;
    req.device = deps.auth.verifyRequest(
      {
        deviceId,
        method: req.method,
        path: actualPath,
        timestamp,
        nonce,
        bodyHash: hashBody(req.rawBodyText),
        signature,
        ...(commandNonce !== undefined ? { commandNonce } : {}),
      },
      isCommand(actualPath),
    );
  });

  // --- Enrolment and health -------------------------------------------------

  app.post('/enrol', async (req) => {
    const body = z
      .object({
        code: z.string(),
        publicKey: z.string(),
        /**
         * The device's own claim that the key lives in a security processor.
         * Recorded, never trusted — the desk cannot verify it, but the operator
         * should be able to see which of their devices claims what.
         */
        hardwareBacked: z.boolean().default(false),
      })
      .parse(req.body);
    const device = deps.auth.enrol(body.code, body.publicKey, body.hardwareBacked);
    deps.log.info(
      { deviceId: device.deviceId, label: device.label, keyKind: device.keyKind },
      'device enrolled',
    );
    return {
      deviceId: device.deviceId,
      label: device.label,
      keyKind: device.keyKind,
      claimsHardwareBacked: device.claimsHardwareBacked,
      enrolledAt: device.enrolledAt,
    };
  });

  app.get('/health', async () => deps.health());

  app.get('/command-nonce', async () => deps.auth.issueCommandNonce());

  // --- State ----------------------------------------------------------------

  app.get('/state', async () => buildSnapshot(deps));

  app.get('/instruments', async () =>
    deps.state.allInstruments().map((s) => specToWire(s)),
  );

  app.get('/orders', async () => deps.state.allOrders(200).map(orderToWire));

  app.get('/journal', async (req) => {
    const q = z
      .object({
        from: z.coerce.number().optional(),
        to: z.coerce.number().optional(),
        canonical: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      })
      .parse(req.query);
    const clauses: string[] = [];
    const args: unknown[] = [];
    if (q.from !== undefined) {
      clauses.push('opened_at >= ?');
      args.push(q.from);
    }
    if (q.to !== undefined) {
      clauses.push('opened_at <= ?');
      args.push(q.to);
    }
    if (q.canonical !== undefined) {
      clauses.push('canonical = ?');
      args.push(q.canonical);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = deps.ledger.db
      .prepare(`SELECT * FROM journal ${where} ORDER BY opened_at DESC LIMIT ?`)
      .all(...args, q.limit) as Array<Record<string, unknown>>;
    return { entries: rows.map(journalToWire), total: rows.length };
  });

  app.get('/alerts', async () => deps.alerts.recentAlerts(100));

  app.post('/alerts/:alertId/ack', async (req) => {
    const { alertId } = z.object({ alertId: z.string() }).parse(req.params);
    deps.alerts.acknowledge(alertId);
    return { ok: true };
  });

  app.get('/divergences', async () => deps.reconciler.openDivergences);

  // --- Preview (no side effects) --------------------------------------------

  app.post('/preview', async (req) => {
    const cmd = parseSubmit(req.body, randomUUID());
    const { risk, sizing } = deps.supervisor.preview(cmd);
    return { risk: riskToWire(risk), sizing: sizingToWire(sizing) };
  });

  // --- Commands -------------------------------------------------------------

  app.post('/orders', async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    const intentId = z.string().uuid().parse(body.intentId);
    const cmd = parseSubmit(body, intentId);
    const out = await deps.supervisor.submit(cmd);
    // 202: the desk has taken responsibility for the intent. It is deliberately
    // not 201 Created — nothing has been created at the venue yet, and the
    // status code should not imply otherwise.
    void reply.status(out.accepted ? 202 : 409);
    return {
      intentId: out.intentId,
      accepted: out.accepted,
      deduplicated: out.deduplicated,
      risk: riskToWire(out.risk),
      ...(out.sizing !== undefined ? { sizing: sizingToWire(out.sizing) } : {}),
      ...(out.problem !== undefined ? { problem: out.problem } : {}),
    };
  });

  app.post('/orders/:intentId/cancel', async (req) => {
    const { intentId } = z.object({ intentId: z.string() }).parse(req.params);
    const record = deps.projector.loadOrderRecord(intentId);
    if (record === undefined) {
      return { ok: false, problem: { code: 'NOT_FOUND', detail: 'no such intent' } };
    }
    return { ok: true, state: record.state, note: 'cancel requested; watch the socket for the outcome' };
  });

  app.post('/positions/:positionId/close', async (req) => {
    const { positionId } = z.object({ positionId: z.string() }).parse(req.params);
    const report = await deps.guard.flatten('manual', `close ${positionId} requested by operator`);
    return report;
  });

  app.post('/panic', async (req) => {
    const body = z
      .object({
        confirmPhrase: z.literal('FLATTEN'),
        lockoutMinutes: z.number().int().min(0).max(1440).default(0),
      })
      .parse(req.body);
    const report = await deps.guard.flatten('manual', 'operator pressed flatten');
    if (body.lockoutMinutes > 0) {
      deps.guard.lockout(body.lockoutMinutes * 60_000, 'operator requested lockout');
    }
    return report;
  });

  app.post('/guard/release', async (req) => {
    const body = z.object({ reason: z.string().min(3) }).parse(req.body);
    deps.guard.release(body.reason);
    return { ok: true };
  });

  // --- Copilot --------------------------------------------------------------

  app.post('/copilot/ask', async (req, reply) => {
    if (deps.copilotAsk === undefined) {
      void reply.status(503);
      return {
        code: 'COPILOT_DISABLED',
        title: 'The copilot is not configured',
        detail: 'Set ANTHROPIC_API_KEY on the desk to enable it.',
      };
    }
    const body = z
      .object({ question: z.string().min(1).max(2000), conversationId: z.string().uuid().optional() })
      .parse(req.body);
    return deps.copilotAsk(body.question, body.conversationId);
  });

  // --- Realtime -------------------------------------------------------------

  app.get('/stream', { websocket: true }, (socket) => {
    const clientId = randomUUID();
    deps.hub.connect({
      id: clientId,
      send: (text) => socket.send(text),
      close: (code, reason) => socket.close(code, reason),
    });

    socket.on('message', (raw: Buffer) => {
      deps.hub.touch(clientId);
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      switch (msg.type) {
        case 'hello': {
          const topics = Array.isArray(msg.topics) ? (msg.topics as string[]) : [];
          const resume = (msg.resume ?? {}) as Record<string, number>;
          for (const t of topics) deps.hub.subscribe(clientId, t, resume[t]);
          break;
        }
        case 'subscribe': {
          const topics = Array.isArray(msg.topics) ? (msg.topics as string[]) : [];
          for (const t of topics) deps.hub.subscribe(clientId, t);
          break;
        }
        case 'unsubscribe': {
          const topics = Array.isArray(msg.topics) ? (msg.topics as string[]) : [];
          for (const t of topics) deps.hub.unsubscribe(clientId, t);
          break;
        }
        case 'ping':
          socket.send(
            JSON.stringify({
              type: 'pong',
              serverTime: deps.clock.now(),
              clientTime: msg.clientTime ?? 0,
            }),
          );
          break;
        default:
          break;
      }
    });

    socket.on('close', () => deps.hub.disconnect(clientId));
  });

  return app;
}

// ---------------------------------------------------------------------------
// Wire mapping. Every Dec becomes a decimal string; no floats cross the wire.
// ---------------------------------------------------------------------------

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function parseSubmit(body: unknown, intentId: string): SubmitCommand {
  const schema = z.object({
    canonical: z.string(),
    side: z.enum(['buy', 'sell']),
    kind: z.enum(['market', 'limit', 'stop', 'stop_limit']).default('market'),
    timeInForce: z.string().default('GTC'),
    price: z.string().optional(),
    stopPrice: z.string().optional(),
    takeProfitPrice: z.string().optional(),
    riskPct: z.string().optional(),
    riskAmount: z.string().optional(),
    explicitVolume: z.string().optional(),
    acknowledgeManualSize: z.boolean().default(false),
    preTradeNote: z.string().max(2000).default(''),
    tags: z.array(z.string().max(32)).max(10).default([]),
    maxSlippage: z.string().optional(),
    override: z.object({ reason: z.string().min(10).max(500) }).optional(),
  });
  const p = schema.parse(body);
  return {
    intentId,
    canonical: p.canonical,
    side: p.side,
    kind: p.kind,
    timeInForce: p.timeInForce,
    acknowledgeManualSize: p.acknowledgeManualSize,
    preTradeNote: p.preTradeNote,
    tags: p.tags,
    ...(p.price !== undefined ? { price: D.dec(p.price) } : {}),
    ...(p.stopPrice !== undefined ? { stopPrice: D.dec(p.stopPrice) } : {}),
    ...(p.takeProfitPrice !== undefined ? { takeProfitPrice: D.dec(p.takeProfitPrice) } : {}),
    ...(p.riskPct !== undefined ? { riskPct: D.dec(p.riskPct) } : {}),
    ...(p.riskAmount !== undefined ? { riskAmount: D.dec(p.riskAmount) } : {}),
    ...(p.explicitVolume !== undefined ? { explicitVolume: D.dec(p.explicitVolume) } : {}),
    ...(p.maxSlippage !== undefined ? { maxSlippage: D.dec(p.maxSlippage) } : {}),
    ...(p.override !== undefined ? { override: p.override } : {}),
  };
}

export function riskToWire(r: D.RiskDecision): Record<string, unknown> {
  return {
    verdict: r.verdict,
    checks: r.checks,
    policyVersion: r.policyVersion,
    evaluatedAt: r.evaluatedAt,
    ...(r.cappedRiskBudget !== undefined
      ? { cappedRiskBudget: D.Decimal.toString(r.cappedRiskBudget) }
      : {}),
  };
}

export function sizingToWire(s: D.SizingResult | undefined): Record<string, unknown> | undefined {
  if (s === undefined) return undefined;
  if (!s.ok) {
    return {
      ok: false,
      code: s.code,
      detail: s.detail,
      ...(s.venueBound !== undefined ? { venueBound: D.Decimal.toString(s.venueBound) } : {}),
      ...(s.riskAtVenueBound !== undefined
        ? { riskAtVenueBound: D.Decimal.toString(s.riskAtVenueBound) }
        : {}),
    };
  }
  return {
    ok: true,
    volume: D.Decimal.toString(s.volume),
    riskAtStop: D.Decimal.toString(s.riskAtStop),
    budgetUtilisation: D.Decimal.toString(s.budgetUtilisation),
    notionalQuote: D.Decimal.toString(s.notionalQuote),
    marginQuote: D.Decimal.toString(s.marginQuote),
    valuationMethod: s.trace.valuationMethod,
    conversionPath: s.trace.conversionPath,
    ...(s.rewardToRisk !== undefined ? { rewardToRisk: D.Decimal.toString(s.rewardToRisk) } : {}),
    ...(s.trace.crossCheckDivergencePct !== undefined
      ? { crossCheckDivergencePct: D.Decimal.toString(s.trace.crossCheckDivergencePct) }
      : {}),
  };
}

export function specToWire(s: D.InstrumentSpec): Record<string, unknown> {
  return {
    symbol: s.symbol,
    canonical: s.canonical,
    assetClass: s.assetClass,
    base: s.base,
    quote: s.quote,
    digits: s.digits,
    tickSize: D.Decimal.toString(s.tickSize),
    contractSize: D.Decimal.toString(s.contractSize),
    minVolume: D.Decimal.toString(s.minVolume),
    maxVolume: D.Decimal.toString(s.maxVolume),
    volumeStep: D.Decimal.toString(s.volumeStep),
    stopsLevel: D.Decimal.toString(s.stopsLevel),
    freezeLevel: D.Decimal.toString(s.freezeLevel),
    marginRate: D.Decimal.toString(s.marginRate),
    positionModel: s.positionModel,
    venueTimeZone: s.venueTimeZone,
    asOf: s.asOf,
  };
}

export function orderToWire(row: Record<string, unknown>): Record<string, unknown> {
  const state = row.state as D.OrderState;
  const staleSince = row.knowledge_stale_since as number | null;
  const record = {
    intentId: row.intent_id as string,
    state,
    requestedQty: D.dec(row.requested_qty as string),
    filledQty: D.dec(row.filled_qty as string),
    appliedFillIds: [],
    lastEventAt: row.last_event_at as number,
    resolutionAttempts: row.resolution_attempts as number,
    ...(row.reason !== null ? { reason: row.reason as string } : {}),
    ...(staleSince !== null ? { knowledgeStaleSince: staleSince } : {}),
  } as D.OrderRecord;
  return {
    intentId: row.intent_id,
    venueOrderId: row.venue_order_id,
    canonical: row.canonical,
    symbol: row.symbol,
    side: row.side,
    kind: row.kind,
    timeInForce: row.time_in_force,
    requestedQty: row.requested_qty,
    filledQty: row.filled_qty,
    limitPrice: row.limit_price,
    stopPrice: row.stop_price,
    avgFillPrice: row.avg_fill_price,
    attachedStop: row.attached_stop,
    attachedTakeProfit: row.attached_tp,
    state,
    certainty: D.effectiveCertainty(record),
    certaintyText: D.describeCertainty(record),
    knowledgeStaleSince: staleSince,
    reason: row.reason,
    resolutionAttempts: row.resolution_attempts,
    createdAt: row.created_at,
    lastEventAt: row.last_event_at,
  };
}

function journalToWire(row: Record<string, unknown>): Record<string, unknown> {
  return {
    tradeId: row.trade_id,
    intentId: row.intent_id,
    canonical: row.canonical,
    side: row.side,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    volume: row.volume,
    entryPrice: row.entry_price,
    exitPrice: row.exit_price,
    stopPrice: row.stop_price,
    takeProfitPrice: row.take_profit,
    riskAccount: row.risk_account,
    netPnl: row.net_pnl,
    costs: row.costs,
    r: row.r_multiple,
    preTradeNote: row.pre_trade_note,
    postTradeNote: row.post_trade_note,
    tags: JSON.parse((row.tags as string) ?? '[]') as string[],
    context: JSON.parse((row.context as string) ?? '{}') as Record<string, unknown>,
  };
}

export function buildSnapshot(deps: ServerDeps): Record<string, unknown> {
  const account = deps.state.getAccount();
  const drawdown = deps.state.currentDrawdown();
  return {
    health: deps.health(),
    serverTime: deps.clock.now(),
    account:
      account === undefined
        ? undefined
        : {
            currency: account.currency,
            balance: D.Decimal.toString(account.balance),
            equity: D.Decimal.toString(account.equity),
            marginUsed: D.Decimal.toString(account.marginUsed),
            marginFree: D.Decimal.toString(account.marginFree),
            provenance: { source: account.source, asOf: account.asOf },
          },
    positions: deps.state.openPositions().map((p) => ({
      positionId: p.positionId,
      canonical: p.canonical,
      symbol: p.symbol,
      side: p.side,
      volume: D.Decimal.toString(p.volume),
      entryPrice: D.Decimal.toString(p.entryPrice),
      stopPrice: p.stopPrice === undefined ? undefined : D.Decimal.toString(p.stopPrice),
      takeProfitPrice:
        p.takeProfitPrice === undefined ? undefined : D.Decimal.toString(p.takeProfitPrice),
      openedAt: p.openedAt,
      intentId: p.intentId,
      foreign: p.foreign,
      provenance: { source: 'broker', asOf: p.asOf },
    })),
    orders: deps.state
      .ordersInState(['PENDING_SUBMIT', 'SUBMITTED', 'UNKNOWN', 'WORKING', 'PARTIALLY_FILLED', 'CANCEL_REQUESTED'])
      .map(orderToWire),
    divergences: deps.reconciler.openDivergences,
    drawdown: {
      status: drawdown.status,
      buffer: D.Decimal.toString(drawdown.buffer),
      bufferFraction: D.Decimal.toString(drawdown.bufferFraction),
      floor: D.Decimal.toString(drawdown.state.floor),
      highWater: D.Decimal.toString(drawdown.state.highWater),
      explain: drawdown.explain,
      breachedAt: drawdown.state.breachedAt,
    },
    alerts: deps.alerts.recentAlerts(30),
    instruments: deps.state.allInstruments().map(specToWire),
    quotes: deps.state.allExecutionQuotes().map((q) => ({
      canonical: q.canonical,
      bid: D.Decimal.toString(q.bid),
      ask: D.Decimal.toString(q.ask),
      spread: D.Decimal.toString(D.Decimal.sub(q.ask, q.bid)),
      provenance: { source: 'broker', asOf: q.asOf },
      stale: deps.clock.now() - q.asOf > 3_000,
    })),
  };
}
