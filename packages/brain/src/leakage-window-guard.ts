export const LEAKAGE_WINDOW_GUARD_VERSION = 'leakage-window-guard:v1' as const;

export interface LeakageWindowPlan {
  readonly version: typeof LEAKAGE_WINDOW_GUARD_VERSION;
  readonly holdoutId: string;
  readonly questionId: string;
  readonly sealedAt: number;
  readonly holdoutStartAt: number;
  readonly holdoutEndAt: number;
  readonly embargoMs: number;
  readonly labelHorizonMs: number;
}

export interface LeakageWindowObservation {
  readonly missionId: string;
  readonly observedAt: number;
  readonly knownAt: number;
}

export interface LockedHoldoutAccessReceipt {
  readonly holdoutId: string;
  readonly questionId: string;
  readonly openedAt: number;
  readonly evaluationCutoff: number;
  /** Immutable hash of the exact sealed holdout population consumed by the evaluation. */
  readonly populationHash: string;
}

export type LeakageDisposition = 'research' | 'purged' | 'holdout' | 'embargoed';

export interface LeakageWindowAssignment extends LeakageWindowObservation {
  readonly labelEndAt: number;
  readonly disposition: LeakageDisposition;
}

export interface LeakageWindowAudit {
  readonly version: typeof LEAKAGE_WINDOW_GUARD_VERSION;
  readonly holdoutId: string;
  readonly questionId: string;
  readonly researchCount: number;
  readonly purgedCount: number;
  readonly holdoutCount: number;
  readonly embargoedCount: number;
  readonly holdoutOpened: boolean;
}

function requireTimestamp(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite non-negative timestamp`);
  }
}

function requireNonEmpty(name: string, value: string): void {
  if (value.trim().length === 0) throw new Error(`${name} is required`);
}

function safeAdd(left: number, right: number, name: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new Error(`${name} exceeds safe timestamp range`);
  return result;
}

/**
 * Partition immutable scan observations without peeking at outcomes.
 *
 * Purge removes pre-holdout scans whose forward label horizon overlaps the sealed holdout.
 * Embargo blocks observations immediately after the holdout. The classification depends only on
 * pre-registered time boundaries and observation identity, never on Brain scores or outcomes.
 */
export function partitionLeakageWindows(
  observations: readonly LeakageWindowObservation[],
  plan: LeakageWindowPlan,
): readonly LeakageWindowAssignment[] {
  if (plan.version !== LEAKAGE_WINDOW_GUARD_VERSION) {
    throw new Error(`unsupported leakage-window version '${plan.version}'`);
  }
  requireNonEmpty('holdoutId', plan.holdoutId);
  requireNonEmpty('questionId', plan.questionId);
  requireTimestamp('sealedAt', plan.sealedAt);
  requireTimestamp('holdoutStartAt', plan.holdoutStartAt);
  requireTimestamp('holdoutEndAt', plan.holdoutEndAt);
  requireTimestamp('embargoMs', plan.embargoMs);
  requireTimestamp('labelHorizonMs', plan.labelHorizonMs);
  if (plan.holdoutStartAt >= plan.holdoutEndAt) {
    throw new Error('holdoutStartAt must precede holdoutEndAt');
  }
  if (plan.sealedAt > plan.holdoutStartAt) {
    throw new Error('locked holdout must be sealed before its first observation');
  }

  const embargoEndAt = safeAdd(plan.holdoutEndAt, plan.embargoMs, 'embargo end');
  const seen = new Set<string>();
  const result: LeakageWindowAssignment[] = [];

  for (const item of observations) {
    requireNonEmpty('missionId', item.missionId);
    if (seen.has(item.missionId)) throw new Error(`duplicate mission '${item.missionId}'`);
    seen.add(item.missionId);
    requireTimestamp(`mission '${item.missionId}' observedAt`, item.observedAt);
    requireTimestamp(`mission '${item.missionId}' knownAt`, item.knownAt);
    if (item.knownAt < item.observedAt) {
      throw new Error(`mission '${item.missionId}' was known before it was observed`);
    }
    const labelEndAt = safeAdd(item.observedAt, plan.labelHorizonMs, 'label horizon');

    let disposition: LeakageDisposition;
    if (item.observedAt >= plan.holdoutStartAt && item.observedAt < plan.holdoutEndAt) {
      disposition = 'holdout';
    } else if (item.observedAt < plan.holdoutStartAt && labelEndAt >= plan.holdoutStartAt) {
      disposition = 'purged';
    } else if (item.observedAt >= plan.holdoutEndAt && item.observedAt < embargoEndAt) {
      disposition = 'embargoed';
    } else {
      disposition = 'research';
    }
    result.push({ ...item, labelEndAt, disposition });
  }

  result.sort((left, right) => left.observedAt - right.observedAt || left.missionId.localeCompare(right.missionId));
  return result;
}

/**
 * Validate the durable receipts for one locked-holdout question.
 *
 * Zero matching receipts means the holdout is still sealed. Exactly one matching receipt means it
 * has been consumed once for the registered question. A second receipt invalidates the holdout for
 * that question instead of silently treating repeated peeks as independent confirmation.
 */
export function auditLockedHoldout(
  assignments: readonly LeakageWindowAssignment[],
  plan: LeakageWindowPlan,
  receipts: readonly LockedHoldoutAccessReceipt[],
): LeakageWindowAudit {
  const matching = receipts.filter(
    (receipt) => receipt.holdoutId === plan.holdoutId && receipt.questionId === plan.questionId,
  );
  if (matching.length > 1) {
    throw new Error(`locked holdout '${plan.holdoutId}' was opened more than once for question '${plan.questionId}'`);
  }

  for (const receipt of receipts) {
    requireNonEmpty('receipt holdoutId', receipt.holdoutId);
    requireNonEmpty('receipt questionId', receipt.questionId);
    requireNonEmpty('receipt populationHash', receipt.populationHash);
    requireTimestamp('receipt openedAt', receipt.openedAt);
    requireTimestamp('receipt evaluationCutoff', receipt.evaluationCutoff);
    if (receipt.holdoutId === plan.holdoutId && receipt.questionId === plan.questionId) {
      if (receipt.openedAt < plan.holdoutEndAt) {
        throw new Error('locked holdout cannot be opened before its sealed window is complete');
      }
      if (receipt.evaluationCutoff < plan.holdoutEndAt) {
        throw new Error('holdout evaluationCutoff cannot predate the end of the sealed window');
      }
      if (receipt.openedAt < receipt.evaluationCutoff) {
        throw new Error('holdout receipt openedAt cannot predate its evaluationCutoff');
      }
    }
  }

  const count = (disposition: LeakageDisposition) =>
    assignments.filter((item) => item.disposition === disposition).length;
  return {
    version: LEAKAGE_WINDOW_GUARD_VERSION,
    holdoutId: plan.holdoutId,
    questionId: plan.questionId,
    researchCount: count('research'),
    purgedCount: count('purged'),
    holdoutCount: count('holdout'),
    embargoedCount: count('embargoed'),
    holdoutOpened: matching.length === 1,
  };
}
