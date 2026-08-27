import { describe, expect, it } from 'vitest';
import { Ledger } from '../ledger/ledger.js';
import { Projector } from '../ledger/projections.js';
import { MissionInvariantError, MissionService, reduceMission } from './service.js';
import type { DecisionSnapshot, MissionObservation, MissionReview } from './types.js';

function makeLedger(): Ledger {
  return new Ledger({ path: ':memory:', synchronous: 'OFF', now: () => 2_000 });
}

function observation(id = 'mission-1'): MissionObservation {
  return {
    missionId: id,
    origin: 'brain',
    canonical: 'XAUUSD',
    timeframe: 'M15',
    trigger: 'scanner:structure-break',
    observedAt: 1_000,
    scanConfigVersion: 'scan-v3',
    marketState: {
      bid: '2400.10',
      ask: '2400.30',
      barsAsOf: 990,
      source: 'mt5',
    },
  };
}

function snapshot(at = 1_100): DecisionSnapshot {
  return {
    snapshotVersion: 1,
    asOf: at,
    known: {
      trend: 'up',
      spread: '0.20',
      featureVectorVersion: 'features-v1',
    },
    missing: ['economic-calendar'],
    plan: {
      side: 'buy',
      entry: '2400.30',
      stop: '2395.00',
      target: '2410.90',
      volume: '0.09',
      invalidation: ['M15 close below 2395.00'],
    },
    riskVerdict: { verdict: 'pass', policyVersion: 4 },
    brainVersion: 'brain-v1',
    regimeVersion: 'regime-v1',
  };
}

function rejectedSnapshot(at = 1_090): DecisionSnapshot {
  return {
    snapshotVersion: 1,
    asOf: at,
    known: { filter: 'spread-too-wide' },
    missing: ['entry', 'stop', 'target'],
    brainVersion: 'brain-v1',
  };
}

function review(at = 2_000): MissionReview {
  return {
    reviewVersion: 1,
    reviewedAt: at,
    decision: { score: 82, rubricVersion: 'decision-v1' },
    outcome: { r: '1.4', status: 'win' },
    counterfactual: { pessimisticR: '1.2' },
    evidenceSeqs: [1, 2, 3],
  };
}

describe('Trade Mission aggregate', () => {
  it('stores every scan as a durable bitemporal ledger fact', () => {
    const ledger = makeLedger();
    const missions = new MissionService(ledger);

    const mission = missions.observe(observation());
    expect(mission.stage).toBe('OBSERVED');
    expect(mission.observedAt).toBe(1_000); // valid time

    const row = ledger.readStream('mission-1')[0];
    expect(row?.ts).toBe(2_000); // transaction/recorded time
    expect(row?.event.kind).toBe('mission.observed');
    expect(Ledger.isDurable('mission.observed')).toBe(true);
    expect(ledger.verifyChain().ok).toBe(true);
    ledger.close();
  });

  it('seals known and missing decision-time information exactly once at PLANNED', () => {
    const ledger = makeLedger();
    const missions = new MissionService(ledger);
    missions.observe(observation());
    missions.markCandidate('mission-1', 'brain', 1_050);

    const planned = missions.plan('mission-1', snapshot(), 'operator:android', 1_200);
    expect(planned.stage).toBe('PLANNED');
    expect(planned.decisionSnapshot?.missing).toEqual(['economic-calendar']);
    expect(planned.snapshotSealedAt).toBe(1_200);

    expect(() => missions.plan('mission-1', snapshot(1_150), 'operator:android', 1_250)).toThrow(
      MissionInvariantError,
    );
    expect(
      ledger.readStream('mission-1').filter((row) => row.kind === 'mission.snapshotSealed'),
    ).toHaveLength(1);
    ledger.close();
  });

  it('requires an untraded rejected setup to retain a decision snapshot', () => {
    const ledger = makeLedger();
    const missions = new MissionService(ledger);
    missions.observe(observation());

    expect(() => missions.abandon('mission-1', 'brain', 1_100, 'filter veto')).toThrow(
      /must seal a decision snapshot/,
    );

    const abandoned = missions.abandon(
      'mission-1',
      'brain',
      1_100,
      'filter veto',
      rejectedSnapshot(),
    );
    expect(abandoned.stage).toBe('ABANDONED');
    expect(abandoned.abandonedReason).toBe('filter veto');
    expect(abandoned.decisionSnapshot?.known).toEqual({ filter: 'spread-too-wide' });

    const reviewed = missions.review('mission-1', {
      reviewVersion: 1,
      reviewedAt: 1_500,
      decision: { score: 20, rubricVersion: 'decision-v1' },
      counterfactual: { wouldHaveReachedTarget: false },
      evidenceSeqs: ledger.readStream('mission-1').map((row) => row.seq),
    });
    expect(reviewed.stage).toBe('REVIEWED');
    expect(reviewed.review?.counterfactual).toEqual({ wouldHaveReachedTarget: false });
    ledger.close();
  });

  it('keeps missions above orders: execution requires a linked intent but does not own order truth', () => {
    const ledger = makeLedger();
    const missions = new MissionService(ledger);
    missions.observe(observation());
    missions.markCandidate('mission-1', 'brain', 1_050);
    missions.plan('mission-1', snapshot(), 'operator:desktop', 1_200);
    missions.arm('mission-1', 'operator:desktop', 1_250);

    expect(() => missions.beginExecution('mission-1', 'operator:desktop', 1_300)).toThrow(
      /requires at least one linked order intent/,
    );

    missions.linkIntent('mission-1', 'intent-abc', 1_300);
    expect(missions.beginExecution('mission-1', 'operator:desktop', 1_310).stage).toBe(
      'EXECUTING',
    );
    expect(missions.beginManaging('mission-1', 'pending-activation', 1_400).stage).toBe(
      'MANAGING',
    );
    missions.linkPosition('mission-1', 'position-9', 1_410);
    expect(missions.close('mission-1', 'operator:desktop', 1_900).stage).toBe('CLOSED');
    expect(missions.review('mission-1', review()).stage).toBe('REVIEWED');

    const final = missions.load('mission-1');
    expect(final?.intentIds).toEqual(['intent-abc']);
    expect(final?.positionIds).toEqual(['position-9']);
    // No order events were created by the Mission layer.
    expect(ledger.readStream('intent-abc')).toHaveLength(0);
    ledger.close();
  });

  it('adopts a foreign MT5 position into MANAGING without inventing a decision snapshot', () => {
    const ledger = makeLedger();
    const missions = new MissionService(ledger);

    const adopted = missions.adoptExternalPosition({
      missionId: 'foreign:position-77',
      canonical: 'EURUSD',
      positionId: '77',
      origin: 'manual:mt5',
      observedAt: 5_000,
      marketState: { source: 'broker-reconcile' },
    });

    expect(adopted.stage).toBe('MANAGING');
    expect(adopted.origin).toBe('manual:mt5');
    expect(adopted.positionIds).toEqual(['77']);
    expect(adopted.decisionSnapshot).toBeUndefined();

    missions.close('foreign:position-77', 'manual:mt5', 6_000, 'broker position closed');
    const reviewed = missions.review('foreign:position-77', {
      reviewVersion: 1,
      reviewedAt: 6_100,
      decision: { eligibleForBrainStatistics: false, reason: 'no decision snapshot' },
      outcome: { netPnl: '-12.40' },
      evidenceSeqs: ledger.readStream('foreign:position-77').map((row) => row.seq),
    });
    expect(reviewed.stage).toBe('REVIEWED');
    expect(reviewed.decisionSnapshot).toBeUndefined();
    ledger.close();
  });

  it('makes lifecycle action replay idempotent while rejecting conflicting history', () => {
    const ledger = makeLedger();
    const missions = new MissionService(ledger);
    missions.observe(observation());

    const action = {
      actionId: 'action-1',
      origin: 'operator:android' as const,
      type: 'note' as const,
      at: 1_050,
      reason: 'watching London open',
    };
    missions.recordAction('mission-1', action);
    missions.recordAction('mission-1', action);
    expect(missions.load('mission-1')?.actions).toHaveLength(1);

    expect(() =>
      reduceMission([
        ...ledger.readStream('mission-1'),
        {
          ts: 1_100,
          event: {
            kind: 'mission.stageChanged',
            missionId: 'mission-1',
            from: 'PLANNED',
            to: 'ARMED',
            origin: 'operator:android',
            at: 1_100,
          },
        },
      ]),
    ).toThrow(/stage history diverged/);
    ledger.close();
  });

  it('rejects a forged direct transition during replay', () => {
    const ledger = makeLedger();
    const missions = new MissionService(ledger);
    missions.observe(observation());

    expect(() =>
      reduceMission([
        ...ledger.readStream('mission-1'),
        {
          ts: 1_100,
          event: {
            kind: 'mission.stageChanged',
            missionId: 'mission-1',
            from: 'OBSERVED',
            to: 'ARMED',
            origin: 'operator:android',
            at: 1_100,
          },
        },
      ]),
    ).toThrow(/invalid mission transition OBSERVED -> ARMED/);
    ledger.close();
  });

  it('does not break the existing projection rebuild invariant', () => {
    const ledger = makeLedger();
    const projector = new Projector(ledger);
    const missions = new MissionService(ledger);
    missions.observe(observation());
    missions.markCandidate('mission-1', 'brain', 1_050);
    missions.plan('mission-1', snapshot(), 'operator:desktop', 1_200);

    expect(projector.catchUp()).toBeGreaterThan(0);
    expect(projector.verifyAgainstRebuild()).toEqual({ ok: true });
    expect(missions.load('mission-1')?.stage).toBe('PLANNED');
    ledger.close();
  });
});
