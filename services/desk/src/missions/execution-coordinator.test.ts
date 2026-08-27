import type { RiskDecision } from '@keel/core';
import * as D from '@keel/core';
import { describe, expect, it } from 'vitest';
import type { SubmitCommand, SubmitOutcome } from '../engine/supervisor.js';
import type { OrderIntent, RiskDecisionRecord } from '../ledger/events.js';
import { Ledger } from '../ledger/ledger.js';
import { MissionExecutionCoordinator } from './execution-coordinator.js';
import { MissionInvariantError, MissionService } from './service.js';
import type { DecisionSnapshot, MissionObservation } from './types.js';

function makeLedger(): Ledger {
  return new Ledger({ path: ':memory:', synchronous: 'OFF', now: () => 2_000 });
}

function observation(id: string, canonical = 'XAUUSD'): MissionObservation {
  return {
    missionId: id,
    origin: 'scanner',
    canonical,
    timeframe: 'M15',
    trigger: 'scanner:candidate',
    observedAt: 1_000,
    scanConfigVersion: 'scan-v1',
    marketState: { bid: '2400.10', ask: '2400.30' },
  };
}

function snapshot(canonical = 'XAUUSD'): DecisionSnapshot {
  return {
    snapshotVersion: 1,
    asOf: 1_100,
    known: { canonical, quoteAsOf: 1_090 },
    missing: ['economic-calendar'],
    plan: {
      side: 'buy',
      entry: '2400.30',
      stop: '2395.00',
      target: '2410.90',
      invalidation: ['M15 close below 2395.00'],
    },
  };
}

function planMission(missions: MissionService, id: string, canonical = 'XAUUSD'): void {
  missions.observe(observation(id, canonical));
  missions.markCandidate(id, 'scanner', 1_050);
  missions.plan(id, snapshot(canonical), 'operator:android', 1_200);
}

function command(intentId = 'intent-1', canonical = 'XAUUSD'): SubmitCommand {
  return {
    intentId,
    canonical,
    side: 'buy',
    kind: 'market',
    timeInForce: 'GTC',
    stopPrice: D.dec('2395.00'),
    explicitVolume: D.dec('0.10'),
    acknowledgeManualSize: true,
    preTradeNote: 'mission execution test',
    tags: [],
  };
}

const riskRecord: RiskDecisionRecord = {
  verdict: 'pass',
  checks: [],
  policyVersion: 1,
  evaluatedAt: 1_250,
};

const passRisk: RiskDecision = {
  verdict: 'pass',
  checks: [],
  policyVersion: 1,
  evaluatedAt: 1_250,
};

function createdIntent(cmd: SubmitCommand): OrderIntent {
  return {
    intentId: cmd.intentId,
    canonical: cmd.canonical,
    symbol: cmd.canonical,
    side: cmd.side,
    kind: cmd.kind,
    timeInForce: cmd.timeInForce,
    volume: '0.10',
    attachedStop: '2395.00',
    preTradeNote: cmd.preTradeNote,
    tags: cmd.tags,
    clientOrderId: `client-${cmd.intentId}`,
  };
}

function accepted(intentId: string): SubmitOutcome {
  return {
    intentId,
    accepted: true,
    risk: passRisk,
    deduplicated: false,
  };
}

function refused(intentId: string): SubmitOutcome {
  return {
    intentId,
    accepted: false,
    risk: {
      verdict: 'block',
      checks: [
        {
          rule: 'margin-unknown',
          verdict: 'block',
          observed: 'unknown',
          limit: 'known',
          message: 'margin unavailable',
        },
      ],
      policyVersion: 1,
      evaluatedAt: 1_250,
    },
    deduplicated: false,
    problem: {
      code: 'RISK_BLOCKED',
      title: 'Blocked',
      detail: 'margin unavailable',
      retryable: false,
      outcomeUnknown: false,
    },
  };
}

describe('MissionExecutionCoordinator', () => {
  it('records explicit ownership before submission and links only a durable created intent', async () => {
    const ledger = makeLedger();
    const missions = new MissionService(ledger);
    planMission(missions, 'mission-1');

    const submitter = {
      submit: async (cmd: SubmitCommand): Promise<SubmitOutcome> => {
        const before = missions.load('mission-1');
        expect(before?.actions.some((action) => action.type === 'submit')).toBe(true);
        expect(before?.intentIds).toEqual([]);
        ledger.append({ kind: 'intent.created', intent: createdIntent(cmd), risk: riskRecord });
        return accepted(cmd.intentId);
      },
    };
    const coordinator = new MissionExecutionCoordinator(ledger, missions, submitter);

    const out = await coordinator.submit('mission-1', command(), 'operator:android', 1_250);

    expect(out.accepted).toBe(true);
    const mission = missions.load('mission-1');
    expect(mission?.stage).toBe('ARMED');
    expect(mission?.intentIds).toEqual(['intent-1']);
    expect(mission?.actions.map((action) => action.type)).toEqual([
      'plan',
      'authorise',
      'submit',
    ]);
    expect(ledger.verifyChain().ok).toBe(true);
    ledger.close();
  });

  it('keeps a risk-refused attempt as mission data without pretending an order intent was created', async () => {
    const ledger = makeLedger();
    const missions = new MissionService(ledger);
    planMission(missions, 'mission-1');

    const submitter = {
      submit: async (cmd: SubmitCommand): Promise<SubmitOutcome> => {
        ledger.append({ kind: 'intent.refused', intentId: cmd.intentId, risk: riskRecord });
        return refused(cmd.intentId);
      },
    };
    const coordinator = new MissionExecutionCoordinator(ledger, missions, submitter);

    const out = await coordinator.submit('mission-1', command(), 'operator:desktop', 1_250);

    expect(out.accepted).toBe(false);
    const mission = missions.load('mission-1');
    expect(mission?.stage).toBe('ARMED');
    expect(mission?.intentIds).toEqual([]);
    expect(mission?.actions.some((action) => action.type === 'submit')).toBe(true);
    expect(coordinator.recoverPendingLinks()).toBe(0);
    ledger.close();
  });

  it('recovers the mission link after a crash in the gap following intent durability', async () => {
    const ledger = makeLedger();
    const missions = new MissionService(ledger);
    planMission(missions, 'mission-1');

    const submitter = {
      submit: async (cmd: SubmitCommand): Promise<SubmitOutcome> => {
        ledger.append({ kind: 'intent.created', intent: createdIntent(cmd), risk: riskRecord });
        throw new Error('simulated process failure after intent fsync');
      },
    };
    const coordinator = new MissionExecutionCoordinator(ledger, missions, submitter);

    await expect(
      coordinator.submit('mission-1', command(), 'operator:android', 1_250),
    ).rejects.toThrow('simulated process failure');
    expect(missions.load('mission-1')?.intentIds).toEqual([]);

    const afterRestart = new MissionExecutionCoordinator(ledger, missions, {
      submit: async (cmd: SubmitCommand) => accepted(cmd.intentId),
    });
    expect(afterRestart.recoverPendingLinks()).toBe(1);
    expect(missions.load('mission-1')?.intentIds).toEqual(['intent-1']);
    expect(afterRestart.recoverPendingLinks()).toBe(0);
    ledger.close();
  });

  it('fails closed when two missions explicitly claim the same intent id', () => {
    const ledger = makeLedger();
    const missions = new MissionService(ledger);
    planMission(missions, 'mission-a');
    planMission(missions, 'mission-b');
    const detail = { intentId: 'intent-shared', canonical: 'XAUUSD' };
    missions.recordAction('mission-a', {
      actionId: 'a-submit',
      origin: 'operator:android',
      type: 'submit',
      at: 1_250,
      detail,
    });
    missions.recordAction('mission-b', {
      actionId: 'b-submit',
      origin: 'operator:desktop',
      type: 'submit',
      at: 1_251,
      detail,
    });
    ledger.append({
      kind: 'intent.created',
      intent: createdIntent(command('intent-shared')),
      risk: riskRecord,
    });

    const coordinator = new MissionExecutionCoordinator(ledger, missions, {
      submit: async (cmd: SubmitCommand) => accepted(cmd.intentId),
    });
    expect(() => coordinator.recoverPendingLinks()).toThrow(MissionInvariantError);
    expect(missions.load('mission-a')?.intentIds).toEqual([]);
    expect(missions.load('mission-b')?.intentIds).toEqual([]);
    ledger.close();
  });

  it('fails closed when the durable intent canonical contradicts the mission submit claim', () => {
    const ledger = makeLedger();
    const missions = new MissionService(ledger);
    planMission(missions, 'mission-1');
    missions.recordAction('mission-1', {
      actionId: 'submit-wrong-canonical',
      origin: 'operator:android',
      type: 'submit',
      at: 1_250,
      detail: { intentId: 'intent-1', canonical: 'XAUUSD' },
    });
    ledger.append({
      kind: 'intent.created',
      intent: createdIntent(command('intent-1', 'EURUSD')),
      risk: riskRecord,
    });

    const coordinator = new MissionExecutionCoordinator(ledger, missions, {
      submit: async (cmd: SubmitCommand) => accepted(cmd.intentId),
    });
    expect(() => coordinator.recoverPendingLinks()).toThrow(/durable intent says 'EURUSD'/);
    expect(missions.load('mission-1')?.intentIds).toEqual([]);
    ledger.close();
  });

  it('rejects a new intent for an unplanned mission before recording a submit action', async () => {
    const ledger = makeLedger();
    const missions = new MissionService(ledger);
    missions.observe(observation('mission-1'));
    const coordinator = new MissionExecutionCoordinator(ledger, missions, {
      submit: async (cmd: SubmitCommand) => accepted(cmd.intentId),
    });

    await expect(
      coordinator.submit('mission-1', command(), 'operator:android', 1_250),
    ).rejects.toThrow(/requires PLANNED or ARMED/);
    expect(missions.load('mission-1')?.actions).toEqual([]);
    ledger.close();
  });
});
