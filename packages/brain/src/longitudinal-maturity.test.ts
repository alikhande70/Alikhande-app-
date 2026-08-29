import { describe, expect, it } from 'vitest';
import { assessLongitudinalMaturity } from './longitudinal-maturity.js';

function episode(id: string, observedAt: number) {
  return {
    episodeId: id,
    canonical: 'XAUUSD',
    firstObservedAt: observedAt,
    lastObservedAt: observedAt + 10,
    missionIds: [id],
  };
}

describe('longitudinal maturity', () => {
  it('rejects several independent episodes that are all packed into one short window', () => {
    const result = assessLongitudinalMaturity(
      [episode('e1', 1_000), episode('e2', 1_100), episode('e3', 1_200)],
      {
        minimumForwardSpanMs: 1_000,
        maturityBucketMs: 500,
        minimumOccupiedMaturityBuckets: 2,
      },
    );

    expect(result.status).toBe('insufficient-data');
    expect(result.reasons).toContain('minimum-forward-span-not-met');
    expect(result.reasons).toContain('minimum-maturity-buckets-not-met');
  });

  it('accepts evidence only when it spans the registered duration and fixed buckets', () => {
    const result = assessLongitudinalMaturity(
      [episode('e1', 1_000), episode('e2', 1_700), episode('e3', 2_400)],
      {
        minimumForwardSpanMs: 1_000,
        maturityBucketMs: 500,
        minimumOccupiedMaturityBuckets: 3,
      },
    );

    expect(result.status).toBe('ready');
    expect(result.forwardSpanMs).toBe(1_410);
    expect(result.occupiedMaturityBuckets).toEqual([0, 1, 2]);
  });

  it('uses observed market time rather than ingestion time', () => {
    const episodes = [episode('e1', 1_000), episode('e2', 1_100)];
    const result = assessLongitudinalMaturity(episodes, {
      minimumForwardSpanMs: 500,
      maturityBucketMs: 250,
      minimumOccupiedMaturityBuckets: 2,
    });

    expect(result.forwardSpanMs).toBe(110);
    expect(result.status).toBe('insufficient-data');
  });

  it('fails closed on duplicate or impossible episode identity', () => {
    expect(() =>
      assessLongitudinalMaturity([episode('same', 1), episode('same', 100)], {
        minimumForwardSpanMs: 0,
        maturityBucketMs: 10,
        minimumOccupiedMaturityBuckets: 1,
      }),
    ).toThrow(/duplicate episode/);

    expect(() =>
      assessLongitudinalMaturity(
        [
          {
            episodeId: 'bad',
            canonical: 'XAUUSD',
            firstObservedAt: 10,
            lastObservedAt: 9,
            missionIds: ['m'],
          },
        ],
        {
          minimumForwardSpanMs: 0,
          maturityBucketMs: 10,
          minimumOccupiedMaturityBuckets: 1,
        },
      ),
    ).toThrow(/invalid observed interval/);
  });
});
