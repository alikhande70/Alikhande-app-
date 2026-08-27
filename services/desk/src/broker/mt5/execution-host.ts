import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import Fastify from 'fastify';
import type { Mt5DeskCommandMessage } from './agent-protocol.js';
import type { Mt5AgentSession } from './agent-session.js';
import type { Mt5HostSnapshot, Mt5HostSubmitResult } from './host-types.js';

export interface Mt5ExecutionAgent {
  isLive(now?: number): boolean;
  epoch(): string | undefined;
  snapshot(): Promise<Mt5HostSnapshot>;
  command(
    command: Exclude<Mt5DeskCommandMessage['command'], 'snapshot'>,
    payload: unknown,
  ): Promise<Mt5HostSubmitResult>;
}

export interface Mt5ExecutionHostOptions {
  readonly token: string;
  readonly session: () => Mt5ExecutionAgent | Mt5AgentSession | undefined;
}

export class Mt5ExecutionHostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Mt5ExecutionHostError';
  }
}

function tokenMatches(expected: string, actual: string): boolean {
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(actual, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function bearer(req: FastifyRequest): string | undefined {
  const value = req.headers.authorization;
  if (typeof value !== 'string' || !value.startsWith('Bearer ')) return undefined;
  return value.slice('Bearer '.length);
}

/**
 * HTTP facade for the co-located Windows MT5 execution bridge.
 *
 * It deliberately owns no broker state. The authenticated EA session remains
 * the only path into MT5, and every request is validated again by
 * `Mt5AgentSession.command` before it crosses the socket boundary. A missing or
 * stale agent is HTTP 503, never a synthetic rejection or zero-valued fact.
 */
export async function buildMt5ExecutionHost(
  options: Mt5ExecutionHostOptions,
): Promise<FastifyInstance> {
  if (options.token.length < 16) {
    throw new Mt5ExecutionHostError('MT5 execution host token must be at least 16 characters');
  }

  const app = Fastify({ logger: false, bodyLimit: 256 * 1024 });

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/v1/')) return;
    const supplied = bearer(req);
    if (supplied === undefined || !tokenMatches(options.token, supplied)) {
      void reply.status(401).send({
        code: 'UNAUTHENTICATED',
        detail: 'valid MT5 execution-host bearer token required',
      });
    }
  });

  function liveSession(reply: FastifyReply): Mt5ExecutionAgent | Mt5AgentSession | undefined {
    const session = options.session();
    if (session !== undefined && session.isLive()) return session;
    void reply.status(503).send({
      code: 'NO_EXECUTION_PATH',
      detail: 'MT5 agent is absent, stale, or terminal-disconnected',
    });
    return undefined;
  }

  app.get('/health', async () => {
    const session = options.session();
    return {
      agentPresent: session !== undefined,
      agentLive: session?.isLive() ?? false,
      agentEpoch: session?.epoch(),
    };
  });

  app.get('/v1/snapshot', async (_req, reply) => {
    const session = liveSession(reply);
    if (session === undefined) return reply;
    return session.snapshot();
  });

  app.post('/v1/margin', async (req, reply) => {
    const session = liveSession(reply);
    if (session === undefined) return reply;
    // `calc_margin` is read-only. The EA validates the exact proposal and calls
    // OrderCalcMargin; no OrderSend exists in this path.
    return session.command('calc_margin', req.body);
  });

  app.post('/v1/orders/place', async (req, reply) => {
    const session = liveSession(reply);
    if (session === undefined) return reply;
    return session.command('place_order', req.body);
  });

  app.post('/v1/orders/cancel', async (req, reply) => {
    const session = liveSession(reply);
    if (session === undefined) return reply;
    return session.command('cancel_order', req.body);
  });

  app.post('/v1/positions/modify', async (req, reply) => {
    const session = liveSession(reply);
    if (session === undefined) return reply;
    return session.command('modify_position', req.body);
  });

  app.post('/v1/positions/close', async (req, reply) => {
    const session = liveSession(reply);
    if (session === undefined) return reply;
    return session.command('close_position', req.body);
  });

  app.post('/v1/reconcile', async (req, reply) => {
    const session = liveSession(reply);
    if (session === undefined) return reply;
    return session.command('reconcile', req.body);
  });

  return app;
}
