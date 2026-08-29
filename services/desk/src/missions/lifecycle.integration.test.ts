import type { RiskDecision } from '@keel/core';
import * as D from '@keel/core';
import { describe, expect, it } from 'vitest';
import type { SubmitCommand, SubmitOutcome } from '../engine/supervisor.js';
import type { OrderIntent, RiskDecisionRecord } from '../ledger/events.js';
import { Ledger } from '../ledger/ledger.js';
import { MissionExecutionCoordinator } from './execution-coordinator.js';
import { MissionRuntime } from './runtime.js';
import type { DecisionSnapshot } from './types.js';

function makeLedger(): Ledger {
  return new Ledger({ path: ':memory:', synchronous: 'OFF', now: () => 10_000 });
}

const passRisk: RiskDecision = {
  verdict: 'pass',
  checks: [],
  policyVersion: 1,
  evaluatedAt: 1_300,
};

const riskRecord: RiskDecisionRecord = {
  verdict: 'pass',
  checks: [],
  policyVersion: 1,
  evaluatedAt: 1_300,
};

function snapshot(asOf = 1_100): DecisionSnapshot {
  return {
    snapshotVersion: 1,
    asOf,
    known: {
      canonical: 'XAUUSD',
      bid: '2400.10',
      ask: '2400.30',
      regime: 'trend',
    },
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

function command(intentId: string): SubmitCommand {
  return {
    intentId,
    canonical: 'XAUUSD',
    side: 'buy',
    kind: 'market',
    timeInForce: 'GTC',
    stopPrice: D.dec('2395.00'),
    explicitVolume: D.dec('0.10'),
    acknowledgeManualSize: true,
    preTradeNote: 'mission lifecycle integration',
    tags: ['mission-lifecycle'],
  };
}

function createdIntent(cmd: SubmitCommand): OrderIntent {
  return {
    intentId: cmd.intentId,
    canonical: cmd.canonical,
    symbol: 'XAUUSD',
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

describe('ADR-0018 mission lifecycle integration', () => {
  it('replays the traded path identically from scan through broker close and review', async () => {
    const ledger = makeLedger();
    const runtime = new MissionRuntime(ledger);

    const candidate = runtime.scans.ingest({
      scanId: 'scan-traded-1',
      canonical: 'XAUUSD',
      timeframe: 'M15',
      trigger: 'scanner:candidate',
      scanConfigVersion: 'scan-v1',
      observedAt: 1_000,
      marketState: { bid: '2400.10', ask: '2400.30' },
      disposition: 'candidate',
    });
    const missionId = candidate.missionId;

    runtime.missions.plan(missionId, snapshot(), 'operator:android', 1_200);

    const submitter = {
      submit: async (cmd: SubmitCommand): Promise<SubmitOutcome> => {
        ledger.append({ kind: 'intent.created', intent: createdIntent(cmd), risk: riskRecord });
        return accepted(cmd.intentId);
      },
    };
    const execution = new MissionExecutionCoordinator(ledger, runtime.missions, submitter);
    const intentId = '11111111-1111-4111-8111-111111111111';
    await execution.submit(missionId, command(intentId), 'operator:android', 1_300);

    runtime.observeBrokerEvent('mt5', {
      type: 'position',
      at: 1_400,
      position: {
        positionId: '9001',
        canonical: 'XAUUSD',
        symbol: 'XAUUSD',
        side: 'buy',
        volume: D.dec('0.10'),
        entryPrice: D.dec('2400.30'),
        stopPrice: D.dec('2395.00'),
        openedAt: 1_400,
        clientOrderId: `client-${intentId}`,
      },
    });

    const closed = runtime.observeBrokerEvent('mt5', {
      type: 'positionClosed',
      at: 2_000,
      positionId: '9001',
      exitPrice: D.dec('2410.90'),
      netPnl: D.dec('10.60'),
      costs: D.dec('0.40'),
    });
    expect(closed?.stage).toBe('CLOSED');

    runtime.missions.review(missionId, {
      reviewVersion: 1,
      reviewedAt: 2_100,
      decision: {
        quality: 'valid-process',
        snapshotCompleteEnough: true,
      },
      outcome: {
        result: 'win',
        netPnl: '10.60',
      },
      evidenceSeqs: ledger.readStream(missionId).map((row) => row.seq),
    });

    const beforeRestart = runtime.missions.load(missionId);
    expect(beforeRestart?.stage).toBe('REVIEWED');
    expect(beforeRestart?.intentIds).toEqual([intentId]);
    expect(beforeRestart?.positionIds).toEqual(['9001']);
    expect(beforeRestart?.decisionSnapshot?.missing).toEqual(['economic-calendar']);
    expect(beforeRestart?.review?.decision).toEqual({
      quality: 'valid-process',
      snapshotCompleteEnough: true,
    });

    const afterRestart = new MissionRuntime(ledger).missions.load(missionId);
    expect(afterRestart).toEqual(beforeRestart);
    expect(ledger.verifyChain().ok).toBe(true);
    ledger.close();
  });

  it('keeps a rejected scan as durable abandoned evidence and reviews it without broker facts', () => {
    const ledger = makeLedger();
    const runtime = new MissionRuntime(ledger);

    const abandoned = runtime.scans.ingest({
      scanId: 'scan-rejected-1',
      canonical: 'XAUUSD',
      timeframe: 'M15',
      trigger: 'scanner:rejected',
      scanConfigVersion: 'scan-v1',
      observedAt: 3_000,
      marketState: { bid: '2398.00', ask: '2398.30' },
      disposition: 'rejected',
      decisionSnapshot: {
        ...snapshot(2_990),
        known: { canonical: 'XAUUSD', spread: '0.30' },
        missing: ['economic-calendar', 'higher-timeframe-confirmation'],
      },
      rejectionReason: 'higher timeframe confirmation missing',
    });

    expect(abandoned.stage).toBe('ABANDONED');
    expect(abandoned.intentIds).toEqual([]);
    expect(abandoned.positionIds).toEqual([]);

    runtime.missions.review(abandoned.missionId, {
      reviewVersion: 1,
      reviewedAt: 4_000,
      decision: {
        quality: 'correct-rejection',
        reason: 'required confirmation was unavailable at decision time',
      },
      counterfactual: {
        source: 'pessimistic-simulation',
        status: 'not-executed',
      },
      evidenceSeqs: ledger.readStream(abandoned.missionId).map((row) => row.seq),
    });

    const beforeRestart = runtime.missions.load(abandoned.missionId);
    const afterRestart = new MissionRuntime(ledger).missions.load(abandoned.missionId);
    expect(beforeRestart?.stage).toBe('REVIEWED');
    expect(beforeRestart?.decisionSnapshot?.missing).toContain('higher-timeframe-confirmation');
    expect(afterRestart).toEqual(beforeRestart);
    expect(ledger.verifyChain().ok).toBe(true);
    ledger.close();
  });
});
