export type Mt5CommandStage = 'RECEIVED' | 'CHECKED' | 'SENT' | 'RESULT';

export interface Mt5CommandLifecycleRecord {
  readonly requestId: string;
  readonly command:
    | 'snapshot'
    | 'place_order'
    | 'cancel_order'
    | 'modify_position'
    | 'close_position'
    | 'reconcile';
  readonly stage: Mt5CommandStage;
  readonly at: number;
  readonly outcome?: 'accepted' | 'rejected' | 'ambiguous';
  readonly reason?: string;
}

export type Mt5RecoveryDisposition =
  | { readonly kind: 'unseen' }
  | { readonly kind: 'safe_before_send'; readonly lastStage: 'RECEIVED' | 'CHECKED' }
  | { readonly kind: 'must_reconcile'; readonly lastStage: 'SENT' }
  | {
      readonly kind: 'resolved';
      readonly outcome: 'accepted' | 'rejected' | 'ambiguous';
      readonly reason?: string;
    };

const stageRank: Record<Mt5CommandStage, number> = {
  RECEIVED: 0,
  CHECKED: 1,
  SENT: 2,
  RESULT: 3,
};

function assertFiniteTime(at: number): void {
  if (!Number.isFinite(at) || at < 0) {
    throw new Error('MT5 command lifecycle timestamp must be finite and non-negative');
  }
}

function assertResultShape(record: Mt5CommandLifecycleRecord): void {
  if (record.stage === 'RESULT' && record.outcome === undefined) {
    throw new Error('MT5 RESULT lifecycle record requires outcome');
  }
  if (record.stage !== 'RESULT' && record.outcome !== undefined) {
    throw new Error('MT5 non-RESULT lifecycle record cannot carry outcome');
  }
}

/**
 * Validates an append-only lifecycle for one request id.
 *
 * The sequence intentionally permits RECEIVED -> RESULT and CHECKED -> RESULT because a
 * command may be rejected before any broker side effect. SENT is the irreversible boundary:
 * after it exists, loss of the final result is ambiguous and requires broker reconciliation.
 */
export function validateMt5CommandLifecycle(records: readonly Mt5CommandLifecycleRecord[]): void {
  const first = records[0];
  if (first === undefined) return;

  const requestId = first.requestId;
  const command = first.command;
  let previousRank = -1;
  let sawSent = false;
  let sawResult = false;

  for (const record of records) {
    if (record.requestId !== requestId) {
      throw new Error('MT5 command lifecycle mixed request ids');
    }
    if (record.command !== command) {
      throw new Error('MT5 command lifecycle changed command name');
    }
    assertFiniteTime(record.at);
    assertResultShape(record);

    const rank = stageRank[record.stage];
    if (rank <= previousRank) {
      throw new Error('MT5 command lifecycle must advance monotonically without duplicates');
    }
    if (record.stage === 'CHECKED' && previousRank !== stageRank.RECEIVED) {
      throw new Error('MT5 CHECKED must follow RECEIVED');
    }
    if (record.stage === 'SENT' && previousRank !== stageRank.CHECKED) {
      throw new Error('MT5 SENT must follow CHECKED');
    }
    if (record.stage === 'RESULT' && previousRank < stageRank.RECEIVED) {
      throw new Error('MT5 RESULT cannot exist before RECEIVED');
    }
    if (sawResult) {
      throw new Error('MT5 command lifecycle cannot advance after RESULT');
    }

    if (record.stage === 'SENT') sawSent = true;
    if (record.stage === 'RESULT') sawResult = true;
    previousRank = rank;
  }

  if (sawSent && command === 'snapshot') {
    throw new Error('MT5 snapshot command cannot cross the SENT trade side-effect boundary');
  }
  if (sawSent && command === 'reconcile') {
    throw new Error('MT5 reconcile command cannot cross the SENT trade side-effect boundary');
  }
}

/**
 * Determines what a restart is allowed to infer from durable command records.
 * It never treats a missing RESULT after SENT as rejection or success.
 */
export function classifyMt5CommandRecovery(
  records: readonly Mt5CommandLifecycleRecord[],
): Mt5RecoveryDisposition {
  if (records.length === 0) return { kind: 'unseen' };
  validateMt5CommandLifecycle(records);

  const last = records.at(-1);
  if (last === undefined) return { kind: 'unseen' };

  switch (last.stage) {
    case 'RECEIVED':
    case 'CHECKED':
      return { kind: 'safe_before_send', lastStage: last.stage };
    case 'SENT':
      return { kind: 'must_reconcile', lastStage: 'SENT' };
    case 'RESULT': {
      const outcome = last.outcome;
      if (outcome === undefined) {
        throw new Error('MT5 RESULT lifecycle record requires outcome');
      }
      return {
        kind: 'resolved',
        outcome,
        ...(last.reason === undefined ? {} : { reason: last.reason }),
      };
    }
  }
}

/** Returns true only when the durable history proves no broker side effect was attempted. */
export function mayRetryBeforeSend(records: readonly Mt5CommandLifecycleRecord[]): boolean {
  const disposition = classifyMt5CommandRecovery(records);
  return disposition.kind === 'unseen' || disposition.kind === 'safe_before_send';
}
