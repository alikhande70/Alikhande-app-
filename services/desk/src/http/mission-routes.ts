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

const abandonSchema = z.object({
  origin: operatorOrigin,
  reason: z.string().trim().min(1).max(1000),
  snapshot: snapshotSchema.optional(),
});

const reviewSchema = z.object({
  origin: operatorOrigin,
  reviewVersion: z.number().int().min(1),
  decision: z.record(z.string(), z.unknown()),
  outcome: z.record(z.string(), z.unknown()).optional(),
  counterfactual: z.record(z.string(), z.unknown()).optional(),
  evidenceSeqs: z
    .array(z.number().int().nonnegative())
    .max(2000)
    .superRefine((values, ctx) => {
      if (new Set(values).size !== values.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'evidenceSeqs must not contain duplicates',
        });
      }
    }),
});

type ParsedSnapshot = z.infer<typeof snapshotSchema>;

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

function toDecisionSnapshot(value: ParsedSnapshot): DecisionSnapshot {
  const plan =
    value.plan === undefined
      ? undefined
      : {
          side: value.plan.side,
          invalidation: value.plan.invalidation,
          ...(value.plan.entry === undefined ? {} : { entry: value.plan.entry }),
          ...(value.plan.stop === undefined ? {} : { stop: value.plan.stop }),
          ...(value.plan.target === undefined ? {} : { target: value.plan.target }),
          ...(value.plan.volume === undefined ? {} : { volume: value.plan.volume }),
        };
  return {
    snapshotVersion: value.snapshotVersion,
    asOf: value.asOf,
    known: value.known,
    missing: value.missing,
    ...(plan === undefined ? {} : { plan }),
    ...(value.riskVerdict === undefined ? {} : { riskVerdict: value.riskVerdict }),
  };
}

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

function invalid(reply: FastifyReply, error: z.ZodError): Record<string, unknown> {
  void reply.status(400);
  return {
    code: 'INVALID_MISSION_COMMAND',
    title: 'Mission command is malformed',
    detail: error.issues.map((issue) => issue.message).join('; '),
    retryable: false,
    outcomeUnknown: false,
  };
}

function routeFailure(reply: FastifyReply, error: unknown): Record<string, unknown> | undefined {
  if (error instanceof MissionInvariantError) return conflict(reply, error);
  if (error instanceof z.ZodError) return invalid(reply, error);
  return undefined;
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
    deps.log.info(
      { repaired },
      'recovered durable mission-to-intent links before serving commands',
    );
  }

  app.post('/scans', async (req, reply) => {
    try {
      const body = scanSchema.parse(req.body);
      const mission = runtime.scans.ingest({
        scanId: body.scanId,
        canonical: body.canonical,
        timeframe: body.timeframe,
        trigger: body.trigger,
        scanConfigVersion: body.scanConfigVersion,
        observedAt: body.observedAt,
        marketState: body.marketState,
        disposition: body.disposition,
        ...(body.decisionSnapshot === undefined
          ? {}
          : { decisionSnapshot: toDecisionSnapshot(body.decisionSnapshot) }),
        ...(body.rejectionReason === undefined ? {} : { rejectionReason: body.rejectionReason }),
      });
      return { mission };
    } catch (error) {
      const failure = routeFailure(reply, error);
      if (failure !== undefined) return failure;
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
        toDecisionSnapshot(body.snapshot),
        body.origin as MissionOrigin,
        deps.clock.now(),
      );
      return { mission };
    } catch (error) {
      const failure = routeFailure(reply, error);
      if (failure !== undefined) return failure;
      throw error;
    }
  });

  app.post('/missions/:missionId/abandon', async (req, reply) => {
    try {
      const { missionId } = z.object({ missionId: z.string().min(1) }).parse(req.params);
      const body = abandonSchema.parse(req.body);
      const at = deps.clock.now();
      const mission = runtime.missions.abandon(
        missionId,
        body.origin as MissionOrigin,
        at,
        body.reason,
        body.snapshot === undefined ? undefined : toDecisionSnapshot(body.snapshot),
      );
      return { mission };
    } catch (error) {
      const failure = routeFailure(reply, error);
      if (failure !== undefined) return failure;
      throw error;
    }
  });

  app.post('/missions/:missionId/review', async (req, reply) => {
    try {
      const { missionId } = z.object({ missionId: z.string().min(1) }).parse(req.params);
      const body = reviewSchema.parse(req.body);
      const reviewedAt = deps.clock.now();
      const current = runtime.missions.load(missionId);
      if (current === undefined) {
        throw new MissionInvariantError(`mission '${missionId}' does not exist`);
      }
      if (current.stage !== 'CLOSED' && current.stage !== 'ABANDONED') {
        throw new MissionInvariantError(
          `review requires CLOSED or ABANDONED, found ${current.stage}`,
        );
      }
      if (current.review !== undefined)
        throw new MissionInvariantError('mission is already reviewed');

      // Review data deliberately separates decision assessment from outcome.
      // Client clocks are not accepted as transaction truth; Desk time records when
      // the immutable review entered the ledger. The operator action is persisted
      // before the review only after all route/service invariants have been checked.
      runtime.missions.recordAction(missionId, {
        actionId: `${missionId}:review:${reviewedAt}`,
        origin: body.origin as MissionOrigin,
        type: 'note',
        at: reviewedAt,
        reason: 'operator review recorded',
      });
      const mission = runtime.missions.review(missionId, {
        reviewVersion: body.reviewVersion,
        reviewedAt,
        decision: body.decision,
        evidenceSeqs: body.evidenceSeqs,
        ...(body.outcome === undefined ? {} : { outcome: body.outcome }),
        ...(body.counterfactual === undefined ? {} : { counterfactual: body.counterfactual }),
      });
      return { mission };
    } catch (error) {
      const failure = routeFailure(reply, error);
      if (failure !== undefined) return failure;
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
      const failure = routeFailure(reply, error);
      if (failure !== undefined) return failure;
      throw error;
    }
  });
}
