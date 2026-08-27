import { describe, expect, it } from 'vitest';
import { Ledger } from '../ledger/ledger.js';
import { MissionRuntime, externalMissionId } from './runtime.js';
import { MissionService } from './service.js';
import type { DecisionSnapshot, MissionObservation } from './types.js';

function makeLedger(): Ledger {
  return new Ledger({ path: ':memory:', synchronous: 'OFF', now: () => 10_000 });
}

function observed(missionId = 'mission-internal'): MissionObservation {
  return {
    missionId,
    origin: 'operator:android',
    canonical: 'XAUUSD',
    timeframe: 'M15',
    trigger: 'scanner:test',
    observedAt: 1_000,
    scanConfigVersion: 'scan-v1',
    marketState: { bid: '2400.10', ask: '2400.30' },
  };
}

function snapshot(): DecisionSnapshot {
  return {
    snapshotVersion: 1,
    asOf: 1_100,
    known: { spread: '0.20' },
    missing: ['economic-calendar'],
    plan: {
      side: 'buy',
      entry: '2400.30',
      stop: '2395.00',
      target: '2410.90',
      invalidation: ['M15 close below stop'],
    },
  };
}

function armInternal(missions: MissionService, intentId = 'intent-1'): void {
  missions.observe(observed());
  missions.markCandidate('mission-internal', 'operator:android', 1_050);
  missions.plan('mission-internal', snapshot(), 'operator:android', 1_150);
  missions.arm('mission-internal', 'operator:android', 1_200);
  missions.linkIntent('mission-internal', intentId, 1_210);
}

describe('MissionRuntime broker truth bridge', () => {
  it('adopts an unattributed broker position without fabricating a manual decision', () => {
    const ledger = makeLedger();
    const runtime = new MissionRuntime(ledger);

    const mission = runtime.observePosition({
      broker: 'mt5',
      positionId: '90071992547409931234',
      canonical: 'XAUUSD',
      at: 2_000,
    });

    expect(mission.missionId).toBe(externalMissionId('mt5', '90071992547409931234'));
    expect(mission.origin).toBe('external:unknown');
    expect(mission.stage).toBe('MANAGING');
    expect(mission.decisionSnapshot).toBeUndefined();
    expect(mission.positionIds).toEqual(['90071992547409931234']);
    expect(mission.marketState).toMatchObject({ ownership: 'unattributed', broker: 'mt5' });
    expect(ledger.verifyChain().ok).toBe(true);
    ledger.close();
  });

  it('is idempotent when the same foreign position is observed again after reconnect', () => {
    const ledger = makeLedger();
    const runtime = new MissionRuntime(ledger);
    const input = { broker: 'mt5', positionId: '42', canonical: 'EURUSD', at: 2_000 } as const;

    runtime.observePosition(input);
    runtime.observePosition({ ...input, at: 2_500 });

    const stream = ledger.readStream(externalMissionId('mt5', '42'));
    expect(stream.filter((row) => row.kind === 'mission.observed')).toHaveLength(1);
    expect(stream.filter((row) => row.kind === 'mission.positionLinked')).toHaveLength(1);
    expect(stream.filter((row) => row.kind === 'mission.actionRecorded')).toHaveLength(1);
    ledger.close();
  });

  it('links an owned position through durable intent identity and advances ARMED to MANAGING', () => {
    const ledger = makeLedger();
    const missions = new MissionService(ledger);
    armInternal(missions, 'intent-owned');
    const runtime = new MissionRuntime(ledger, missions);

    const mission = runtime.observePosition({
      broker: 'paper',
      positionId: 'position-owned',
      canonical: 'XAUUSD',
      intentId: 'intent-owned',
      at: 1_500,
    });

    expect(mission.missionId).toBe('mission-internal');
    expect(mission.stage).toBe('MANAGING');
    expect(mission.positionIds).toContain('position-owned');
    expect(ledger.readStream(externalMissionId('paper', 'position-owned'))).toHaveLength(0);
    ledger.close();
  });

  it('never attributes a similar foreign position to an internal mission without identity', () => {
    const ledger = makeLedger();
    const missions = new MissionService(ledger);
    armInternal(missions, 'intent-owned');
    const runtime = new MissionRuntime(ledger, missions);

    const external = runtime.observePosition({
      broker: 'mt5',
      positionId: 'foreign-1',
      canonical: 'XAUUSD',
      at: 1_500,
    });

    expect(external.origin).toBe('external:unknown');
    expect(external.missionId).not.toBe('mission-internal');
    expect(missions.load('mission-internal')?.positionIds).toEqual([]);
    ledger.close();
  });

  it('closes the linked mission from broker truth and tolerates duplicate close delivery', () => {
    const ledger = makeLedger();
    const missions = new MissionService(ledger);
    armInternal(missions, 'intent-owned');
    const runtime = new MissionRuntime(ledger, missions);
    runtime.observePosition({
      broker: 'paper',
      positionId: 'position-owned',
      canonical: 'XAUUSD',
      intentId: 'intent-owned',
      at: 1_500,
    });

    const first = runtime.closePosition({ positionId: 'position-owned', at: 2_000 });
    const second = runtime.closePosition({ positionId: 'position-owned', at: 2_100 });

    expect(first?.stage).toBe('CLOSED');
    expect(second?.stage).toBe('CLOSED');
    expect(
      ledger
        .readStream('mission-internal')
        .filter((row) => row.kind === 'mission.stageChanged' && row.event.kind === 'mission.stageChanged' && row.event.to === 'CLOSED'),
    ).toHaveLength(1);
    ledger.close();
  });

  it('does nothing for a close that has no durable mission-position link', () => {
    const ledger = makeLedger();
    const runtime = new MissionRuntime(ledger);
    expect(runtime.closePosition({ positionId: 'unknown', at: 2_000 })).toBeUndefined();
    expect(ledger.verifyChain().ok).toBe(true);
    ledger.close();
  });
});
