import { describe, expect, it } from 'vitest';
import { Ledger } from '../ledger/ledger.js';
import { ScanMissionIngestor, missionIdForScan } from './scan-ingestor.js';
import { MissionInvariantError, MissionService } from './service.js';
import type { DecisionSnapshot } from './types.js';

function makeLedger(): Ledger {
  return new Ledger({ path: ':memory:', synchronous: 'OFF', now: () => 2_000 });
}

function rejectedSnapshot(): DecisionSnapshot {
  return {
    snapshotVersion: 1,
    asOf: 1_000,
    known: {
      spread: '2.30',
      spreadLimit: '1.20',
      source: 'mt5',
    },
    missing: ['economic-calendar'],
  };
}

function baseInput() {
  return {
    scanId: 'scan-00042',
    canonical: 'XAUUSD',
    timeframe: 'M15',
    trigger: 'scheduled-scan',
    scanConfigVersion: 'scan-v4',
    observedAt: 1_000,
    marketState: {
      bid: '2400.10',
      ask: '2400.30',
      barsAsOf: 990,
      source: 'mt5',
    },
  } as const;
}

describe('ScanMissionIngestor', () => {
  it('stores an ordinary scan before any Brain exists', () => {
    const ledger = makeLedger();
    const ingestor = new ScanMissionIngestor(new MissionService(ledger));

    const mission = ingestor.ingest({ ...baseInput(), disposition: 'observed' });

    expect(mission.origin).toBe('scanner');
    expect(mission.stage).toBe('OBSERVED');
    expect(mission.actions).toHaveLength(1);
    expect(mission.actions[0]).toMatchObject({
      origin: 'scanner',
      type: 'scan',
      detail: { scanId: 'scan-00042', disposition: 'observed' },
    });
    expect(mission.decisionSnapshot).toBeUndefined();
    expect(ledger.verifyChain().ok).toBe(true);
    ledger.close();
  });

  it('retains a rejected setup and the information missing at rejection time', () => {
    const ledger = makeLedger();
    const ingestor = new ScanMissionIngestor(new MissionService(ledger));

    const mission = ingestor.ingest({
      ...baseInput(),
      disposition: 'rejected',
      rejectionReason: 'spread filter veto',
      decisionSnapshot: rejectedSnapshot(),
    });

    expect(mission.stage).toBe('ABANDONED');
    expect(mission.abandonedReason).toBe('spread filter veto');
    expect(mission.decisionSnapshot?.missing).toEqual(['economic-calendar']);
    expect(mission.decisionSnapshot?.known).toMatchObject({ spread: '2.30' });
    expect(
      ledger.readStream(mission.missionId).map((row) => row.event.kind),
    ).toEqual([
      'mission.observed',
      'mission.actionRecorded',
      'mission.snapshotSealed',
      'mission.stageChanged',
    ]);
    ledger.close();
  });

  it('promotes a candidate without sealing a future decision snapshot', () => {
    const ledger = makeLedger();
    const ingestor = new ScanMissionIngestor(new MissionService(ledger));

    const mission = ingestor.ingest({ ...baseInput(), disposition: 'candidate' });

    expect(mission.stage).toBe('CANDIDATE');
    expect(mission.decisionSnapshot).toBeUndefined();
    ledger.close();
  });

  it('is idempotent for the same scanner replay', () => {
    const ledger = makeLedger();
    const ingestor = new ScanMissionIngestor(new MissionService(ledger));
    const input = { ...baseInput(), disposition: 'candidate' as const };

    const first = ingestor.ingest(input);
    const before = ledger.head.seq;
    const replay = ingestor.ingest(input);

    expect(replay).toEqual(first);
    expect(ledger.head.seq).toBe(before);
    ledger.close();
  });

  it('fails closed when a replay reuses identity with changed market meaning', () => {
    const ledger = makeLedger();
    const ingestor = new ScanMissionIngestor(new MissionService(ledger));
    ingestor.ingest({ ...baseInput(), disposition: 'observed' });

    expect(() =>
      ingestor.ingest({
        ...baseInput(),
        canonical: 'EURUSD',
        disposition: 'observed',
      }),
    ).toThrow(MissionInvariantError);
    ledger.close();
  });

  it('requires rejected scans to carry a sealed point-in-time snapshot', () => {
    const ledger = makeLedger();
    const ingestor = new ScanMissionIngestor(new MissionService(ledger));

    expect(() =>
      ingestor.ingest({
        ...baseInput(),
        disposition: 'rejected',
        rejectionReason: 'filter veto',
      }),
    ).toThrow(/requires a decision snapshot/);
    expect(ledger.head.seq).toBe(0);
    ledger.close();
  });

  it('scopes deterministic mission identity by scanner configuration', () => {
    expect(missionIdForScan('scan-v4', '42')).toBe(missionIdForScan('scan-v4', '42'));
    expect(missionIdForScan('scan-v4', '42')).not.toBe(missionIdForScan('scan-v5', '42'));
  });
});
