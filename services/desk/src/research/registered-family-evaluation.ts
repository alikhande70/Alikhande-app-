import {
  evaluateLedgerRegisteredHypothesisFamily,
  type RegisteredHypothesisFamilyEvaluation,
  type RegisteredTestResult,
} from '@keel/brain/evaluation-composition';
import type { Ledger } from '../ledger/ledger.js';
import { readDurableRegisteredFamily } from './registered-family-boundary.js';

/**
 * The sole production bridge from Desk registration truth into deterministic
 * multiple-testing statistics. Callers cannot supply familyHash or knownAt;
 * both are recovered from the immutable ledger by family identity.
 */
export function evaluateDurableRegisteredFamily(
  ledger: Ledger,
  familyId: string,
  results: readonly RegisteredTestResult[],
): RegisteredHypothesisFamilyEvaluation {
  const { family, receipt } = readDurableRegisteredFamily(ledger, familyId);
  return evaluateLedgerRegisteredHypothesisFamily(family, receipt, results);
}
