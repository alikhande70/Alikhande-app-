import type { HoldoutAccessReceiptRecord, LedgerEvent } from './events.js';
import { streamOf } from './events.js';
import type { Ledger, LedgerRow } from './ledger.js';

const POPULATION_HASH = /^sha256:[0-9a-f]{64}$/;

export interface DurableHoldoutAccessReceipt extends HoldoutAccessReceiptRecord {
  /** Ledger transaction time: when the receipt became durable knowledge. */
  readonly knownAt: number;
  readonly ledgerSeq: number;
  readonly ledgerHash: string;
}

export interface RecordHoldoutAccessResult {
  readonly created: boolean;
  readonly receipt: DurableHoldoutAccessReceipt;
}

export class HoldoutAccessInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HoldoutAccessInvariantError';
  }
}

function requireNonEmpty(name: string, value: string): void {
  if (value.trim().length === 0) throw new HoldoutAccessInvariantError(`${name} is required`);
}

function requireTimestamp(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new HoldoutAccessInvariantError(`${name} must be a safe non-negative integer timestamp`);
  }
}

export function validateHoldoutAccessReceipt(receipt: HoldoutAccessReceiptRecord): void {
  requireNonEmpty('holdoutId', receipt.holdoutId);
  requireNonEmpty('questionId', receipt.questionId);
  requireNonEmpty('populationHash', receipt.populationHash);
  if (!POPULATION_HASH.test(receipt.populationHash)) {
    throw new HoldoutAccessInvariantError('populationHash must be a canonical sha256:<64 lowercase hex> digest');
  }
  requireTimestamp('openedAt', receipt.openedAt);
  requireTimestamp('evaluationCutoff', receipt.evaluationCutoff);
  if (receipt.openedAt < receipt.evaluationCutoff) {
    throw new HoldoutAccessInvariantError('openedAt cannot predate evaluationCutoff');
  }
}

function asEvent(receipt: HoldoutAccessReceiptRecord): LedgerEvent {
  return { kind: 'evaluation.holdoutOpened', receipt };
}

function sameReceipt(left: HoldoutAccessReceiptRecord, right: HoldoutAccessReceiptRecord): boolean {
  return (
    left.holdoutId === right.holdoutId &&
    left.questionId === right.questionId &&
    left.openedAt === right.openedAt &&
    left.evaluationCutoff === right.evaluationCutoff &&
    left.populationHash === right.populationHash
  );
}

function durableReceipt(row: LedgerRow): DurableHoldoutAccessReceipt {
  if (row.event.kind !== 'evaluation.holdoutOpened') {
    throw new HoldoutAccessInvariantError(`unexpected event '${row.event.kind}' in holdout access stream`);
  }
  validateHoldoutAccessReceipt(row.event.receipt);
  if (row.ts < row.event.receipt.openedAt) {
    throw new HoldoutAccessInvariantError(
      `holdout receipt at ledger seq ${row.seq} was durable before its declared openedAt`,
    );
  }
  return {
    ...row.event.receipt,
    knownAt: row.ts,
    ledgerSeq: row.seq,
    ledgerHash: row.hash,
  };
}

function rowsFor(
  ledger: Ledger,
  holdoutId: string,
  questionId: string,
): readonly LedgerRow[] {
  const probe = asEvent({
    holdoutId,
    questionId,
    openedAt: 0,
    evaluationCutoff: 0,
    populationHash: `sha256:${'0'.repeat(64)}`,
  });
  return ledger
    .readStream(streamOf(probe))
    .filter((row) => row.event.kind === 'evaluation.holdoutOpened');
}

/**
 * Authoritative read model for one locked-holdout question.
 *
 * This folds the hash-chained aggregate stream directly instead of trusting an
 * eventually-caught-up SQL projection. A second receipt is therefore visible
 * immediately after append and cannot be hidden by projector lag or restart.
 */
export function readHoldoutAccessReceipt(
  ledger: Ledger,
  holdoutId: string,
  questionId: string,
): DurableHoldoutAccessReceipt | undefined {
  requireNonEmpty('holdoutId', holdoutId);
  requireNonEmpty('questionId', questionId);
  const rows = rowsFor(ledger, holdoutId, questionId);
  if (rows.length > 1) {
    throw new HoldoutAccessInvariantError(
      `locked holdout '${holdoutId}' has ${rows.length} access receipts for question '${questionId}'`,
    );
  }
  const row = rows[0];
  return row === undefined ? undefined : durableReceipt(row);
}

/**
 * Persist exactly one access receipt before the Brain is allowed to inspect the
 * sealed holdout. Retrying the *same* write is idempotent; any different second
 * write for the same (holdoutId, questionId) is a hard conflict.
 */
export function recordHoldoutAccess(
  ledger: Ledger,
  receipt: HoldoutAccessReceiptRecord,
  knownAt: number,
): RecordHoldoutAccessResult {
  validateHoldoutAccessReceipt(receipt);
  requireTimestamp('knownAt', knownAt);
  if (knownAt < receipt.openedAt) {
    throw new HoldoutAccessInvariantError('knownAt cannot predate openedAt');
  }

  const rows = rowsFor(ledger, receipt.holdoutId, receipt.questionId);
  if (rows.length > 1) {
    throw new HoldoutAccessInvariantError(
      `locked holdout '${receipt.holdoutId}' was already opened more than once for question '${receipt.questionId}'`,
    );
  }

  const existingRow = rows[0];
  if (existingRow !== undefined) {
    const existing = durableReceipt(existingRow);
    if (!sameReceipt(existing, receipt)) {
      throw new HoldoutAccessInvariantError(
        `conflicting access receipt for locked holdout '${receipt.holdoutId}' and question '${receipt.questionId}'`,
      );
    }
    return { created: false, receipt: existing };
  }

  const row = ledger.append(asEvent(receipt), knownAt);
  return { created: true, receipt: durableReceipt(row) };
}

/**
 * Ledger-derived receipts suitable for passing to the Brain's holdout audit.
 * Extra forensic fields are retained; structural typing lets the Brain consume
 * the five immutable receipt fields without becoming the source of truth.
 */
export function listHoldoutAccessReceipts(ledger: Ledger): readonly DurableHoldoutAccessReceipt[] {
  const result: DurableHoldoutAccessReceipt[] = [];
  let fromSeq = 0;
  for (;;) {
    const rows = ledger.read(fromSeq, 5_000);
    if (rows.length === 0) break;
    for (const row of rows) {
      if (row.event.kind === 'evaluation.holdoutOpened') result.push(durableReceipt(row));
    }
    fromSeq = rows[rows.length - 1]?.seq ?? fromSeq;
    if (rows.length < 5_000) break;
  }
  return result;
}
