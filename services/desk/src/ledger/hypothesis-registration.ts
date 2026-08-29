import { createHash } from 'node:crypto';
import type { HypothesisFamilyRegistrationRecord, LedgerEvent } from './events.js';
import { streamOf } from './events.js';
import type { Ledger, LedgerRow } from './ledger.js';

const FAMILY_HASH = /^sha256:[0-9a-f]{64}$/;
const VERSION = 'registered-hypothesis-family:v1' as const;
const METHOD = 'benjamini-hochberg' as const;

type HypothesisFamilyWithoutHash = Omit<HypothesisFamilyRegistrationRecord, 'familyHash'>;

export interface DurableHypothesisFamilyRegistration extends HypothesisFamilyRegistrationRecord {
  /** Ledger transaction time: when the pre-registration became durable knowledge. */
  readonly knownAt: number;
  readonly ledgerSeq: number;
  readonly ledgerHash: string;
}

export interface HypothesisEvaluationRegistrationInputs {
  readonly family: HypothesisFamilyWithoutHash;
  readonly receipt: {
    readonly familyHash: string;
    readonly knownAt: number;
  };
}

export interface RecordHypothesisFamilyRegistrationResult {
  readonly created: boolean;
  readonly registration: DurableHypothesisFamilyRegistration;
}

export class HypothesisRegistrationInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HypothesisRegistrationInvariantError';
  }
}

function requireNonEmpty(name: string, value: string): void {
  if (value.trim().length === 0) {
    throw new HypothesisRegistrationInvariantError(`${name} is required`);
  }
}

function requireTimestamp(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new HypothesisRegistrationInvariantError(
      `${name} must be a safe non-negative integer timestamp`,
    );
  }
}

function canonicalFamily(family: HypothesisFamilyWithoutHash): Readonly<Record<string, unknown>> {
  return {
    version: family.version,
    familyId: family.familyId,
    registeredAt: family.registeredAt,
    method: family.method,
    qLevel: family.qLevel,
    hypotheses: [...family.hypotheses]
      .map((item) => ({
        questionId: item.questionId,
        testId: item.testId,
        analysisPlanHash: item.analysisPlanHash,
        alternative: item.alternative,
      }))
      .sort((left, right) => left.questionId.localeCompare(right.questionId)),
  };
}

function computeFamilyHash(family: HypothesisFamilyWithoutHash): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(canonicalFamily(family)))
    .digest('hex')}`;
}

export function sealHypothesisFamilyRegistration(
  family: HypothesisFamilyWithoutHash,
): HypothesisFamilyRegistrationRecord {
  validateFamilyWithoutHash(family);
  return { ...family, familyHash: computeFamilyHash(family) };
}

function validateFamilyWithoutHash(family: HypothesisFamilyWithoutHash): void {
  if (family.version !== VERSION) {
    throw new HypothesisRegistrationInvariantError('unsupported registered hypothesis family version');
  }
  if (family.method !== METHOD) {
    throw new HypothesisRegistrationInvariantError('unsupported multiple-testing method');
  }
  requireNonEmpty('familyId', family.familyId);
  requireTimestamp('registeredAt', family.registeredAt);
  if (!Number.isFinite(family.qLevel) || family.qLevel <= 0 || family.qLevel >= 1) {
    throw new HypothesisRegistrationInvariantError('qLevel must be strictly between 0 and 1');
  }
  if (family.hypotheses.length === 0) {
    throw new HypothesisRegistrationInvariantError('registered hypothesis family must not be empty');
  }
  const questionIds = new Set<string>();
  for (const hypothesis of family.hypotheses) {
    requireNonEmpty('questionId', hypothesis.questionId);
    requireNonEmpty('testId', hypothesis.testId);
    requireNonEmpty('analysisPlanHash', hypothesis.analysisPlanHash);
    if (
      hypothesis.alternative !== 'greater' &&
      hypothesis.alternative !== 'less' &&
      hypothesis.alternative !== 'two-sided'
    ) {
      throw new HypothesisRegistrationInvariantError(
        `unsupported alternative for ${hypothesis.questionId}`,
      );
    }
    if (questionIds.has(hypothesis.questionId)) {
      throw new HypothesisRegistrationInvariantError(
        `duplicate registered questionId: ${hypothesis.questionId}`,
      );
    }
    questionIds.add(hypothesis.questionId);
  }
}

export function validateHypothesisFamilyRegistration(
  registration: HypothesisFamilyRegistrationRecord,
): void {
  validateFamilyWithoutHash(registration);
  if (!FAMILY_HASH.test(registration.familyHash)) {
    throw new HypothesisRegistrationInvariantError(
      'familyHash must be a canonical sha256:<64 lowercase hex> digest',
    );
  }
  const actualHash = computeFamilyHash(registration);
  if (actualHash !== registration.familyHash) {
    throw new HypothesisRegistrationInvariantError('registered hypothesis family hash mismatch');
  }
}

function asEvent(registration: HypothesisFamilyRegistrationRecord): LedgerEvent {
  return { kind: 'evaluation.hypothesisFamilyRegistered', registration };
}

function sameRegistration(
  left: HypothesisFamilyRegistrationRecord,
  right: HypothesisFamilyRegistrationRecord,
): boolean {
  return JSON.stringify(canonicalFamily(left)) === JSON.stringify(canonicalFamily(right));
}

function durableRegistration(row: LedgerRow): DurableHypothesisFamilyRegistration {
  if (row.event.kind !== 'evaluation.hypothesisFamilyRegistered') {
    throw new HypothesisRegistrationInvariantError(
      `unexpected event '${row.event.kind}' in hypothesis registration stream`,
    );
  }
  validateHypothesisFamilyRegistration(row.event.registration);
  if (row.ts < row.event.registration.registeredAt) {
    throw new HypothesisRegistrationInvariantError(
      `hypothesis family at ledger seq ${row.seq} was durable before its declared registeredAt`,
    );
  }
  return {
    ...row.event.registration,
    knownAt: row.ts,
    ledgerSeq: row.seq,
    ledgerHash: row.hash,
  };
}

function rowsFor(ledger: Ledger, familyId: string): readonly LedgerRow[] {
  const probe: HypothesisFamilyRegistrationRecord = {
    version: VERSION,
    familyId,
    familyHash: `sha256:${'0'.repeat(64)}`,
    registeredAt: 0,
    method: METHOD,
    qLevel: 0.05,
    hypotheses: [
      {
        questionId: 'probe',
        testId: 'probe',
        analysisPlanHash: 'probe',
        alternative: 'two-sided',
      },
    ],
  };
  return ledger
    .readStream(streamOf(asEvent(probe)))
    .filter((row) => row.event.kind === 'evaluation.hypothesisFamilyRegistered');
}

/** Authoritative hash-chain read for exactly one immutable family registration. */
export function readHypothesisFamilyRegistration(
  ledger: Ledger,
  familyId: string,
): DurableHypothesisFamilyRegistration | undefined {
  requireNonEmpty('familyId', familyId);
  const rows = rowsFor(ledger, familyId);
  if (rows.length > 1) {
    throw new HypothesisRegistrationInvariantError(
      `hypothesis family '${familyId}' has ${rows.length} durable registrations`,
    );
  }
  const row = rows[0];
  return row === undefined ? undefined : durableRegistration(row);
}

/**
 * Persist a family before evidence is inspected. An identical retry is
 * idempotent; a changed second registration for the same familyId is a hard
 * conflict so restart/retry cannot silently rewrite the research question.
 */
export function recordHypothesisFamilyRegistration(
  ledger: Ledger,
  registration: HypothesisFamilyRegistrationRecord,
  knownAt: number,
): RecordHypothesisFamilyRegistrationResult {
  validateHypothesisFamilyRegistration(registration);
  requireTimestamp('knownAt', knownAt);
  if (knownAt < registration.registeredAt) {
    throw new HypothesisRegistrationInvariantError('knownAt cannot predate registeredAt');
  }

  const rows = rowsFor(ledger, registration.familyId);
  if (rows.length > 1) {
    throw new HypothesisRegistrationInvariantError(
      `hypothesis family '${registration.familyId}' was already registered more than once`,
    );
  }
  const existingRow = rows[0];
  if (existingRow !== undefined) {
    const existing = durableRegistration(existingRow);
    if (!sameRegistration(existing, registration)) {
      throw new HypothesisRegistrationInvariantError(
        `conflicting registration for hypothesis family '${registration.familyId}'`,
      );
    }
    return { created: false, registration: existing };
  }

  const row = ledger.append(asEvent(registration), knownAt);
  return { created: true, registration: durableRegistration(row) };
}

/**
 * Produce the exact structural inputs consumed by the deterministic Brain.
 * Provenance stays in Desk; the Brain receives only the immutable family and
 * the ledger transaction-time receipt needed for anti-backdating checks.
 */
export function toHypothesisEvaluationRegistrationInputs(
  registration: DurableHypothesisFamilyRegistration,
): HypothesisEvaluationRegistrationInputs {
  validateHypothesisFamilyRegistration(registration);
  requireTimestamp('knownAt', registration.knownAt);
  if (registration.knownAt < registration.registeredAt) {
    throw new HypothesisRegistrationInvariantError('knownAt cannot predate registeredAt');
  }
  const { familyHash, knownAt, ledgerSeq: _ledgerSeq, ledgerHash: _ledgerHash, ...family } =
    registration;
  return { family, receipt: { familyHash, knownAt } };
}

export function listHypothesisFamilyRegistrations(
  ledger: Ledger,
): readonly DurableHypothesisFamilyRegistration[] {
  const result: DurableHypothesisFamilyRegistration[] = [];
  let fromSeq = 0;
  for (;;) {
    const rows = ledger.read(fromSeq, 5_000);
    if (rows.length === 0) break;
    for (const row of rows) {
      if (row.event.kind === 'evaluation.hypothesisFamilyRegistered') {
        result.push(durableRegistration(row));
      }
    }
    fromSeq = rows[rows.length - 1]?.seq ?? fromSeq;
    if (rows.length < 5_000) break;
  }
  return result;
}
