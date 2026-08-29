import { createHash } from 'node:crypto';

export const REGISTERED_HYPOTHESIS_FAMILY_VERSION = 'registered-hypothesis-family:v1' as const;
export const MULTIPLE_TESTING_METHOD = 'benjamini-hochberg' as const;

export interface RegisteredHypothesis {
  readonly questionId: string;
  readonly testId: string;
  readonly analysisPlanHash: string;
  readonly alternative: 'greater' | 'less' | 'two-sided';
}

export interface RegisteredHypothesisFamily {
  readonly version: typeof REGISTERED_HYPOTHESIS_FAMILY_VERSION;
  readonly familyId: string;
  readonly registeredAt: number;
  readonly method: typeof MULTIPLE_TESTING_METHOD;
  readonly qLevel: number;
  readonly hypotheses: readonly RegisteredHypothesis[];
}

export interface RegisteredTestResult {
  readonly questionId: string;
  readonly testId: string;
  readonly analysisPlanHash: string;
  readonly firstEvidenceKnownAt: number;
  readonly evaluatedAt: number;
  readonly pValue: number | null;
  readonly status: 'complete' | 'insufficient-data';
}

export interface RegisteredHypothesisDecision {
  readonly questionId: string;
  readonly rawPValue: number | null;
  readonly adjustedPValue: number | null;
  readonly discovery: false | true;
  readonly status: 'not-discovered' | 'discovered' | 'insufficient-data';
}

export interface RegisteredHypothesisFamilyEvaluation {
  readonly version: typeof REGISTERED_HYPOTHESIS_FAMILY_VERSION;
  readonly familyId: string;
  readonly familyHash: string;
  readonly method: typeof MULTIPLE_TESTING_METHOD;
  readonly qLevel: number;
  readonly familySize: number;
  readonly status: 'complete' | 'insufficient-data';
  readonly discoveries: number;
  readonly decisions: readonly RegisteredHypothesisDecision[];
  /** Statistical evidence only. This layer has no authority to promote a challenger. */
  readonly promotionAction: 'none';
}

function assertFiniteTimestamp(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a finite non-negative timestamp`);
}

function assertIdentifier(name: string, value: string): void {
  if (value.trim().length === 0) throw new Error(`${name} must be non-empty`);
}

function canonicalFamily(family: RegisteredHypothesisFamily): Readonly<Record<string, unknown>> {
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

export function sealRegisteredHypothesisFamily(family: RegisteredHypothesisFamily): string {
  validateFamily(family);
  return `sha256:${createHash('sha256').update(JSON.stringify(canonicalFamily(family))).digest('hex')}`;
}

function validateFamily(family: RegisteredHypothesisFamily): void {
  if (family.version !== REGISTERED_HYPOTHESIS_FAMILY_VERSION) {
    throw new Error('unsupported registered hypothesis family version');
  }
  if (family.method !== MULTIPLE_TESTING_METHOD) throw new Error('unsupported multiple-testing method');
  assertIdentifier('familyId', family.familyId);
  assertFiniteTimestamp('registeredAt', family.registeredAt);
  if (!Number.isFinite(family.qLevel) || family.qLevel <= 0 || family.qLevel >= 1) {
    throw new Error('qLevel must be strictly between 0 and 1');
  }
  if (family.hypotheses.length === 0) throw new Error('registered hypothesis family must not be empty');
  const questionIds = new Set<string>();
  for (const item of family.hypotheses) {
    assertIdentifier('questionId', item.questionId);
    assertIdentifier('testId', item.testId);
    assertIdentifier('analysisPlanHash', item.analysisPlanHash);
    if (questionIds.has(item.questionId)) throw new Error(`duplicate registered questionId: ${item.questionId}`);
    questionIds.add(item.questionId);
  }
}

function validateResults(
  family: RegisteredHypothesisFamily,
  expectedFamilyHash: string,
  results: readonly RegisteredTestResult[],
): void {
  const actualHash = sealRegisteredHypothesisFamily(family);
  if (actualHash !== expectedFamilyHash) throw new Error('registered hypothesis family hash mismatch');
  if (results.length !== family.hypotheses.length) {
    throw new Error('test result population must exactly match the pre-registered hypothesis family');
  }
  const byQuestion = new Map(family.hypotheses.map((item) => [item.questionId, item] as const));
  const seen = new Set<string>();
  for (const result of results) {
    if (seen.has(result.questionId)) throw new Error(`duplicate test result: ${result.questionId}`);
    seen.add(result.questionId);
    const registered = byQuestion.get(result.questionId);
    if (registered === undefined) throw new Error(`unregistered test result: ${result.questionId}`);
    if (registered.testId !== result.testId) throw new Error(`testId drift for ${result.questionId}`);
    if (registered.analysisPlanHash !== result.analysisPlanHash) {
      throw new Error(`analysisPlanHash drift for ${result.questionId}`);
    }
    assertFiniteTimestamp('firstEvidenceKnownAt', result.firstEvidenceKnownAt);
    assertFiniteTimestamp('evaluatedAt', result.evaluatedAt);
    if (result.firstEvidenceKnownAt < family.registeredAt) {
      throw new Error(`hypothesis ${result.questionId} was registered after evidence became known`);
    }
    if (result.evaluatedAt < result.firstEvidenceKnownAt) {
      throw new Error(`hypothesis ${result.questionId} was evaluated before its evidence was known`);
    }
    if (result.status === 'complete') {
      if (result.pValue === null || !Number.isFinite(result.pValue) || result.pValue < 0 || result.pValue > 1) {
        throw new Error(`complete result ${result.questionId} requires a finite pValue in [0,1]`);
      }
    } else if (result.pValue !== null) {
      throw new Error(`insufficient-data result ${result.questionId} must not carry a pValue`);
    }
  }
}

function adjustedPValues(
  ordered: readonly Readonly<{ questionId: string; pValue: number }>[],
): ReadonlyMap<string, number> {
  const adjusted = new Map<string, number>();
  let runningMinimum = 1;
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const item = ordered[index];
    if (item === undefined) continue;
    const rank = index + 1;
    runningMinimum = Math.min(runningMinimum, (item.pValue * ordered.length) / rank, 1);
    adjusted.set(item.questionId, runningMinimum);
  }
  return adjusted;
}

/**
 * Evaluate one immutable, pre-registered family with Benjamini-Hochberg FDR control.
 *
 * The family is fail-closed: every registered question must be present. If any question lacks enough
 * evidence, the whole family reports insufficient-data and no discovery is emitted. This prevents
 * researchers from shrinking the denominator after seeing which questions were inconvenient.
 */
export function evaluateRegisteredHypothesisFamily(
  family: RegisteredHypothesisFamily,
  expectedFamilyHash: string,
  results: readonly RegisteredTestResult[],
): RegisteredHypothesisFamilyEvaluation {
  validateResults(family, expectedFamilyHash, results);
  const resultByQuestion = new Map(results.map((item) => [item.questionId, item] as const));
  const hasInsufficientData = results.some((item) => item.status === 'insufficient-data');

  if (hasInsufficientData) {
    return {
      version: REGISTERED_HYPOTHESIS_FAMILY_VERSION,
      familyId: family.familyId,
      familyHash: expectedFamilyHash,
      method: MULTIPLE_TESTING_METHOD,
      qLevel: family.qLevel,
      familySize: family.hypotheses.length,
      status: 'insufficient-data',
      discoveries: 0,
      decisions: family.hypotheses.map((item) => ({
        questionId: item.questionId,
        rawPValue: resultByQuestion.get(item.questionId)?.pValue ?? null,
        adjustedPValue: null,
        discovery: false,
        status: 'insufficient-data',
      })),
      promotionAction: 'none',
    };
  }

  const ordered = results
    .map((item) => ({ questionId: item.questionId, pValue: item.pValue as number }))
    .sort((left, right) => left.pValue - right.pValue || left.questionId.localeCompare(right.questionId));

  let rejectionCount = 0;
  for (let index = 0; index < ordered.length; index += 1) {
    const item = ordered[index];
    if (item === undefined) continue;
    const rank = index + 1;
    if (item.pValue <= (rank / ordered.length) * family.qLevel) rejectionCount = rank;
  }
  const rejectedIds = new Set(ordered.slice(0, rejectionCount).map((item) => item.questionId));
  const adjusted = adjustedPValues(ordered);
  const decisions = family.hypotheses.map((item) => {
    const result = resultByQuestion.get(item.questionId);
    if (result === undefined || result.pValue === null) throw new Error('validated result disappeared');
    const discovery = rejectedIds.has(item.questionId);
    return {
      questionId: item.questionId,
      rawPValue: result.pValue,
      adjustedPValue: adjusted.get(item.questionId) ?? null,
      discovery,
      status: discovery ? ('discovered' as const) : ('not-discovered' as const),
    };
  });

  return {
    version: REGISTERED_HYPOTHESIS_FAMILY_VERSION,
    familyId: family.familyId,
    familyHash: expectedFamilyHash,
    method: MULTIPLE_TESTING_METHOD,
    qLevel: family.qLevel,
    familySize: family.hypotheses.length,
    status: 'complete',
    discoveries: rejectionCount,
    decisions,
    promotionAction: 'none',
  };
}
