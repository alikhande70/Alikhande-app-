import { describe, expect, it } from 'vitest';
import { observationsFromMissionLedger } from './ledger-observations.js';

const bindings = [
  { sourceKey: 'trendStrength', marketStateKey: 'trendStrength' },
  { sourceKey: 'spreadBps', marketStateKey: 'spreadBps' },
] as const;

function row(
  seq: number,
  ts: number,
  missionId: string,
  observedAt: number,
  marketState: Readonly<Record<string, unknown>>,
) {
  return {
    seq,
    ts,
    kind: 'mission.observed' as const,
    payload: { observation: { missionId, observedAt, marketState } },
  };
}

describe('ADR-0019 durable ledger observation bridge', () => {
  it('preserves market valid-time separately from ledger recorded-time', () => {
    const observations = observationsFromMissionLedger({
      missionId: 'mission-1',
      bindings,
      rows: [row(41, 1_020, 'mission-1', 1_000, { trendStrength: 0.8, spreadBps: 4 })],
    });

    expect(observations).toEqual([
      { sourceKey: 'trendStrength', value: 0.8, validAt: 1_000, recordedAt: 1_020 },
      { sourceKey: 'spreadBps', value: 4, validAt: 1_000, recordedAt: 1_020 },
    ]);
  });

  it('never leaks another mission into the requested decision population', () => {
    const observations = observationsFromMissionLedger({
      missionId: 'mission-1',
      bindings,
      rows: [
        row(10, 1_010, 'mission-1', 1_000, { trendStrength: 0.6 }),
        row(11, 1_011, 'mission-2', 1_000, { trendStrength: 0.99, spreadBps: 1 }),
      ],
    });

    expect(observations).toEqual([
      { sourceKey: 'trendStrength', value: 0.6, validAt: 1_000, recordedAt: 1_010 },
    ]);
  });

  it('leaves absent durable fields absent instead of fabricating values', () => {
    const observations = observationsFromMissionLedger({
      missionId: 'mission-1',
      bindings,
      rows: [row(1, 1_010, 'mission-1', 1_000, { trendStrength: 0.7 })],
    });

    expect(observations).toHaveLength(1);
    expect(observations.some((item) => item.sourceKey === 'spreadBps')).toBe(false);
  });

  it('rejects impossible bitemporal rows and non-monotonic ledger order', () => {
    expect(() =>
      observationsFromMissionLedger({
        missionId: 'mission-1',
        bindings,
        rows: [row(1, 999, 'mission-1', 1_000, { trendStrength: 0.7 })],
      }),
    ).toThrow(/recorded before its market valid-time/);

    expect(() =>
      observationsFromMissionLedger({
        missionId: 'mission-1',
        bindings,
        rows: [
          row(2, 1_010, 'mission-1', 1_000, { trendStrength: 0.7 }),
          row(1, 1_020, 'mission-1', 1_010, { trendStrength: 0.8 }),
        ],
      }),
    ).toThrow(/strictly increasing seq order/);
  });

  it('rejects non-numeric bound fields rather than coercing scanner data', () => {
    expect(() =>
      observationsFromMissionLedger({
        missionId: 'mission-1',
        bindings,
        rows: [row(1, 1_010, 'mission-1', 1_000, { trendStrength: '0.7' })],
      }),
    ).toThrow(/must be a finite number/);
  });

  it('requires an explicit one-to-one allow-list for feature sources', () => {
    expect(() =>
      observationsFromMissionLedger({
        missionId: 'mission-1',
        bindings: [
          { sourceKey: 'trend', marketStateKey: 'trendStrength' },
          { sourceKey: 'trend', marketStateKey: 'otherTrend' },
        ],
        rows: [],
      }),
    ).toThrow(/duplicate ledger sourceKey/);
  });
});
