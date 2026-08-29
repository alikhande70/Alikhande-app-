import { describe, expect, it } from 'vitest';
import {
  auditLockedHoldout,
  LEAKAGE_WINDOW_GUARD_VERSION,
  type LeakageWindowPlan,
  partitionLeakageWindows,
} from './leakage-window-guard.js';

function plan(): LeakageWindowPlan {
  return {
    version: LEAKAGE_WINDOW_GUARD_VERSION,
    holdoutId: 'holdout-2026-q3',
    questionId: 'challenger-a-vs-champion',
    sealedAt: 1_000,
    holdoutStartAt: 2_000,
    holdoutEndAt: 3_000,
    embargoMs: 200,
    labelHorizonMs: 300,
  };
}

describe('partitionLeakageWindows', () => {
  it('purges overlapping labels, seals holdout scans, and embargoes immediate neighbours', () => {
    const assignments = partitionLeakageWindows(
      [
        { missionId: 'research', observedAt: 1_600, knownAt: 1_610 },
        { missionId: 'purged', observedAt: 1_800, knownAt: 1_810 },
        { missionId: 'holdout', observedAt: 2_400, knownAt: 2_410 },
        { missionId: 'embargo', observedAt: 3_100, knownAt: 3_110 },
        { missionId: 'later', observedAt: 3_300, knownAt: 3_310 },
      ],
      plan(),
    );

    expect(assignments.map(({ missionId, disposition }) => [missionId, disposition])).toEqual([
      ['research', 'research'],
      ['purged', 'purged'],
      ['holdout', 'holdout'],
      ['embargo', 'embargoed'],
      ['later', 'research'],
    ]);
  });

  it('treats a label ending exactly at the holdout boundary as overlapping and purges it', () => {
    const [assignment] = partitionLeakageWindows(
      [{ missionId: 'boundary', observedAt: 1_700, knownAt: 1_700 }],
      plan(),
    );
    expect(assignment?.disposition).toBe('purged');
  });

  it('rejects duplicate identities and impossible bitemporal order', () => {
    expect(() =>
      partitionLeakageWindows(
        [
          { missionId: 'same', observedAt: 100, knownAt: 100 },
          { missionId: 'same', observedAt: 200, knownAt: 200 },
        ],
        plan(),
      ),
    ).toThrow(/duplicate mission/);

    expect(() =>
      partitionLeakageWindows([{ missionId: 'future', observedAt: 200, knownAt: 199 }], plan()),
    ).toThrow(/known before it was observed/);
  });

  it('rejects a holdout that was only sealed after its first observation', () => {
    expect(() =>
      partitionLeakageWindows([], { ...plan(), sealedAt: 2_001 }),
    ).toThrow(/sealed before its first observation/);
  });
});

describe('auditLockedHoldout', () => {
  it('reports a sealed holdout before any access receipt exists', () => {
    const assignments = partitionLeakageWindows(
      [{ missionId: 'holdout', observedAt: 2_400, knownAt: 2_410 }],
      plan(),
    );
    expect(auditLockedHoldout(assignments, plan(), [])).toMatchObject({
      holdoutCount: 1,
      holdoutOpened: false,
    });
  });

  it('accepts exactly one durable promotion receipt after the holdout is complete', () => {
    const assignments = partitionLeakageWindows(
      [{ missionId: 'holdout', observedAt: 2_400, knownAt: 2_410 }],
      plan(),
    );
    expect(
      auditLockedHoldout(assignments, plan(), [
        {
          holdoutId: plan().holdoutId,
          questionId: plan().questionId,
          openedAt: 3_100,
          evaluationCutoff: 3_050,
          populationHash: `sha256:${'a'.repeat(64)}`,
        },
      ]).holdoutOpened,
    ).toBe(true);
  });

  it('invalidates repeated peeks for the same registered question', () => {
    const assignments = partitionLeakageWindows([], plan());
    const receipt = {
      holdoutId: plan().holdoutId,
      questionId: plan().questionId,
      openedAt: 3_100,
      evaluationCutoff: 3_050,
      populationHash: `sha256:${'b'.repeat(64)}`,
    };
    expect(() => auditLockedHoldout(assignments, plan(), [receipt, { ...receipt, openedAt: 3_200 }])).toThrow(
      /opened more than once/,
    );
  });

  it('rejects opening the holdout before its sealed window or evaluation cutoff is complete', () => {
    const assignments = partitionLeakageWindows([], plan());
    expect(() =>
      auditLockedHoldout(assignments, plan(), [
        {
          holdoutId: plan().holdoutId,
          questionId: plan().questionId,
          openedAt: 2_900,
          evaluationCutoff: 2_800,
          populationHash: 'sealed-population',
        },
      ]),
    ).toThrow(/cannot be opened before/);
  });
});
