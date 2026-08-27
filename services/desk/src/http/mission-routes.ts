import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { SubmitCommand, SubmitOutcome } from '../engine/supervisor.js';
import { MissionExecutionCoordinator } from '../missions/execution-coordinator.js';
import { MissionInvariantError } from '../missions/service.js';
import type { DecisionSnapshot, MissionOrigin } from '../missions/types.js';

export interface MissionRouteDeps {
  readonly clock: { now(): number };
  readonly log: { info(obj: unknown, msg: string): void };
  readonly ledger: ConstructorParameters<typeof MissionExecutionCoordinator>[0];
  readonly supervisor: ConstructorParameters<typeof MissionExecutionCoordinator>[2];
  readonly missions?: {
    readonly missions: ConstructorParameters<typeof MissionExecutionCoordinator>[1];
    readonly scans: {
      ingest(input: {
        readonly scanId: string;
        readonly canonical: string;
        readonly timeframe: string;
        readonly trigger: string;
        readonly scanConfigVersion: string;
        readonly observedAt: number;
        readonly marketState: Readonly<Record<string, unknown>>;
        readonly disposition: 'observed' | 'candidate' | 'rejected';
        readonly decisionSnapshot?: DecisionSnapshot;
        readonly rejectionReason?: string;
      }): unknown;
    };
  };
}

export type SubmitParser = (body: unknown, intentId: string) => SubmitCommand;
export type OutcomeWire = (out: SubmitOutcome, missionId: string) => Record<string, unknown>;

const operatorOrigin = z.enum(['operator:android', 'operator:desktop']);

const planSchema = z.object({
  side: z.enum(['buy', 'sell']),
  entry: z.string().optional(),
  stop: z.string().optional(),
  target: z.string().optional(),
  volume: z.string().optional(),
  invalidation: z.array(z.string().min(1)).max(50),
});

const snapshotSchema = z.object({
  snapshotVersion: z.number().int().min(1),
  asOf: z.number().finite().nonnegative(),
  known: z.record(z.string(), z.unknown()),
  missing: z.array(z.string().min(1)).max(200),
  plan: planSchema.optional(),
  riskVerdict: z.record(z.string(), z.unknown()).optional(),
});

const scanSchema = z
  .object({
    scanId: z.string().min(1).max(200),
    canonical: z.string().min(1).max(64),
    timeframe: z.string().min(1).max(32),
    trigger: z.string().min(1).max(200),
    scanConfigVersion: z.string().min(1).max(100),
    observedAt: z.number().finite().nonnegative(),
    marketState: z.record(z.string(), z.unknown()),
    disposition: z.enum(['observed', 'candidate', 'rejected']),
    decisionSnapshot: snapshotSchema.optional(),
    rejectionReason: z.string().min(1).max(1000).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.disposition === 'rejected') {
      if (value.decisionSnapshot === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['decisionSnapshot'],
          message: 'rejected scan requires decisionSnapshot',
        });
      }
      if (value.rejectionReason === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['rejectionReason'],
          message: 'rejected scan requires rejectionReason',
        });
      }
    } else if (value.decisionSnapshot !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['decisionSnapshot'],
        message: 'candidate/observed scan cannot seal a decision snapshot during ingestion',
      });
    }
  });

function conflict(reply: FastifyReply, error: unknown): Record<string, unknown> {
  void reply.status(409);
  return {
    code: 'MISSION_CONFLICT',
    title: 'Mission state does not permit this command',
    detail: error instanceof Error ? error.message : String(error),
    retryable: false,
    outcomeUnknown: false,
  };
}

/**
 * Register the durable ADR-0018 command surface.
 *
 * These routes deliberately sit beside the legacy /orders endpoint while the
 * Android/Windows clients migrate. A mission-bound order can only enter the
 * execution supervisor through MissionExecutionCoordinator, which persists the
 * ownership claim before the intent is created and repairs a crash-gap link on
 * restart. The legacy endpoint remains compatibility-only and is not used by
 * this spine.
 */
export function registerMissionRoutes(
  app: FastifyInstance,
  deps: MissionRouteDeps,
  parseSubmit: SubmitParser,
  outcomeToWire: OutcomeWire,
): void {
  const runtime = deps.missions;
  if (runtime === undefined) return;

  const execution = new MissionExecutionCoordinator(deps.ledger, runtime.missions, deps.supervisor);
  const repaired = execution.recoverPendingLinks();
  if (repaired > 0) {
    deps.log.info({ repaired }, 'recovered durable mission-to-intent links before serving commands');
  }

  app.post('/scans', async (req, reply) => {
    try {
      const body = scanSchema.parse(req.body);
      const mission = runtime.scans.ingest(body);
      return { mission };
    } catch (error) {
      if (error instanceof MissionInvariantError) return conflict(reply, error);
      throw error;
    }
  });

  app.post('/missions/:missionId/plan', async (req, reply) => {
    try {
      const { missionId } = z.object({ missionId: z.string().min(1) }).parse(req.params);
      const body = z
        .object({
          origin: operatorOrigin,
          snapshot: snapshotSchema,
        })
        .parse(req.body);
      const mission = runtime.missions.plan(
        missionId,
        body.snapshot,
        body.origin as MissionOrigin,
        deps.clock.now(),
      );
      return { mission };
    } catch (error) {
      if (error instanceof MissionInvariantError) return conflict(reply, error);
      throw error;
    }
  });

  app.post('/missions/:missionId/orders', async (req, reply) => {
    try {
      const { missionId } = z.object({ missionId: z.string().min(1) }).parse(req.params);
      const body = z
        .object({
          intentId: z.string().uuid(),
          origin: operatorOrigin,
        })
        .passthrough()
        .parse(req.body);
      const cmd = parseSubmit(body, body.intentId);
      const out = await execution.submit(
        missionId,
        cmd,
        body.origin as MissionOrigin,
        deps.clock.now(),
      );
      void reply.status(out.accepted ? 202 : 409);
      return outcomeToWire(out, missionId);
    } catch (error) {
      if (error instanceof MissionInvariantError) return conflict(reply, error);
      throw error;
    }
  });
}
