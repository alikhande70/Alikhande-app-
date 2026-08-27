import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { SubmitCommand, SubmitOutcome } from '../engine/supervisor.js';
import { Ledger } from '../ledger/ledger.js';
import { MissionRuntime } from '../missions/runtime.js';
import { registerMissionRoutes } from './mission-routes.js';

function submitCommand(body: unknown, intentId: string): SubmitCommand {
  const row = body as Record<string, unknown>;
  return {
    intentId,
    canonical: row.canonical as string,
    side: row.side as 'buy' | 'sell',
    kind: 'market',
    timeInForce: 'GTC',
    acknowledgeManualSize: false,
    preTradeNote: String(row.preTradeNote ?? ''),
    tags: [],
  };
}

function outcome(intentId: string, at: number): SubmitOutcome {
  return {
    intentId,
    accepted: true,
    deduplicated: false,
    risk: {
      verdict: 'pass',
      checks: [],
      policyVersion: 1,
      evaluatedAt: at,
    },
  };
}

describe('mission HTTP spine', () => {
  it('persists Scan -> Plan -> Submit ownership before linking the durable intent', async () => {
    const ledger = new Ledger({ path: ':memory:', synchronous: 'OFF' });
    const runtime = new MissionRuntime(ledger);
    let now = 10_000;
    const supervisor = {
      submit: async (cmd: SubmitCommand): Promise<SubmitOutcome> => {
        ledger.append({
          kind: 'intent.created',
          intent: {
            intentId: cmd.intentId,
            canonical: cmd.canonical,
            symbol: cmd.canonical,
            side: cmd.side,
            kind: cmd.kind,
            timeInForce: cmd.timeInForce,
            volume: '0.10',
            preTradeNote: cmd.preTradeNote,
            tags: [],
            clientOrderId: `test-${cmd.intentId}`,
          },
          risk: { verdict: 'pass', checks: [], policyVersion: 1, evaluatedAt: now },
        } as never);
        return outcome(cmd.intentId, now);
      },
    };
    const app = Fastify();
    registerMissionRoutes(
      app,
      {
        clock: { now: () => now },
        log: { info: () => undefined },
        ledger,
        supervisor,
        missions: runtime,
      },
      submitCommand,
      (out, missionId) => ({ missionId, intentId: out.intentId, accepted: out.accepted }),
    );

    const scan = await app.inject({
      method: 'POST',
      url: '/scans',
      payload: {
        scanId: 'scan-http-1',
        canonical: 'XAUUSD',
        timeframe: 'M15',
        trigger: 'structure-break',
        scanConfigVersion: 'scan-v1',
        observedAt: now,
        marketState: { bid: '2400.00', ask: '2400.20' },
        disposition: 'candidate',
      },
    });
    expect(scan.statusCode).toBe(200);
    const missionId = (scan.json() as { mission: { missionId: string } }).mission.missionId;

    now += 100;
    const plan = await app.inject({
      method: 'POST',
      url: `/missions/${missionId}/plan`,
      payload: {
        origin: 'operator:desktop',
        snapshot: {
          snapshotVersion: 1,
          asOf: now,
          known: { spread: '0.20', setup: 'structure-break' },
          missing: ['news-calendar'],
          plan: {
            side: 'buy',
            stop: '2395.00',
            invalidation: ['M15 structure fails'],
          },
        },
      },
    });
    expect(plan.statusCode).toBe(200);

    now += 100;
    const intentId = '0f3f55d0-e149-49dd-9dc3-2aa4eb2cdf3d';
    const order = await app.inject({
      method: 'POST',
      url: `/missions/${missionId}/orders`,
      payload: {
        intentId,
        origin: 'operator:desktop',
        canonical: 'XAUUSD',
        side: 'buy',
        stopPrice: '2395.00',
        preTradeNote: 'mission-bound test',
      },
    });
    expect(order.statusCode).toBe(202);
    expect(order.json()).toMatchObject({ missionId, intentId, accepted: true });

    const durable = runtime.missions.load(missionId);
    expect(durable?.stage).toBe('ARMED');
    expect(durable?.intentIds).toEqual([intentId]);
    expect(durable?.decisionSnapshot?.missing).toEqual(['news-calendar']);
    expect(durable?.actions.map((action) => action.type)).toEqual([
      'scan',
      'plan',
      'authorise',
      'submit',
    ]);

    await app.close();
    ledger.close();
  });

  it('fails closed when the mission and order canonical instruments disagree', async () => {
    const ledger = new Ledger({ path: ':memory:', synchronous: 'OFF' });
    const runtime = new MissionRuntime(ledger);
    const now = 20_000;
    const app = Fastify();
    registerMissionRoutes(
      app,
      {
        clock: { now: () => now },
        log: { info: () => undefined },
        ledger,
        supervisor: { submit: async (cmd) => outcome(cmd.intentId, now) },
        missions: runtime,
      },
      submitCommand,
      (out, missionId) => ({ missionId, intentId: out.intentId }),
    );

    const scan = await app.inject({
      method: 'POST',
      url: '/scans',
      payload: {
        scanId: 'scan-http-2',
        canonical: 'XAUUSD',
        timeframe: 'M15',
        trigger: 'candidate',
        scanConfigVersion: 'scan-v1',
        observedAt: now,
        marketState: {},
        disposition: 'candidate',
      },
    });
    const missionId = (scan.json() as { mission: { missionId: string } }).mission.missionId;
    await app.inject({
      method: 'POST',
      url: `/missions/${missionId}/plan`,
      payload: {
        origin: 'operator:desktop',
        snapshot: {
          snapshotVersion: 1,
          asOf: now,
          known: {},
          missing: ['quote'],
          plan: { side: 'buy', invalidation: ['no quote'] },
        },
      },
    });

    const order = await app.inject({
      method: 'POST',
      url: `/missions/${missionId}/orders`,
      payload: {
        intentId: '24b3f78e-cfe6-46a7-a41e-16d8b723b82d',
        origin: 'operator:desktop',
        canonical: 'EURUSD',
        side: 'buy',
      },
    });
    expect(order.statusCode).toBe(409);
    expect(order.json()).toMatchObject({ code: 'MISSION_CONFLICT', outcomeUnknown: false });

    await app.close();
    ledger.close();
  });
});
