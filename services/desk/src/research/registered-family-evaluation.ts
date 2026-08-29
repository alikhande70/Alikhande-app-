import {
  evaluateLedgerRegisteredResearchFamily,
  type LedgerRegisteredResearchEvaluation,
  type LedgerRegisteredResearchTestResult,
} from '@keel/brain/evaluation-composition';
import type { Ledger } from '../ledger/ledger.js';
import { readDurableRegisteredFamily } from './registered-family-boundary.js';

/**
 * Production entrypoint for registered multiple-testing evaluation.
 *
 * The caller supplies only family identity plus test results. Registration
 * provenance is always re-read from the authoritative Desk ledger immediately
 * before deterministic Brain evaluation, so caller memory cannot manufacture
 * familyHash/knownAt/ledger identity.
 */
export function evaluateDurableRegisteredFamily(
  ledger: Ledger,
  familyId: string,
  results: readonly LedgerRegisteredResearchTestResult[],
): LedgerRegisteredResearchEvaluation {
  const registration = readDurableRegisteredFamily(ledger, familyId);
  return evaluateLedgerRegisteredResearchFamily(registration, results);
}
