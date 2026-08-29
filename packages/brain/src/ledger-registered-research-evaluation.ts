import {
  evaluateRegisteredHypothesisFamily,
  type RegisteredHypothesisFamily,
  type RegisteredHypothesisFamilyEvaluation,
  type RegisteredHypothesisFamilyReceipt,
  type RegisteredTestResult,
} from './registered-hypotheses.js';

export const LEDGER_REGISTERED_RESEARCH_SOURCE = 'desk-hash-chained-ledger:v1' as const;

export interface LedgerRegisteredResearchFamily {
  readonly source: typeof LEDGER_REGISTERED_RESEARCH_SOURCE;
  readonly ledgerSeq: number;
  readonly ledgerHash: string;
  readonly family: RegisteredHypothesisFamily;
  readonly receipt: RegisteredHypothesisFamilyReceipt;
}

export type LedgerRegisteredResearchTestResult = RegisteredTestResult;
export type LedgerRegisteredResearchEvaluation = RegisteredHypothesisFamilyEvaluation;

function validateLedgerProvenance(input: LedgerRegisteredResearchFamily): void {
  if (input.source !== LEDGER_REGISTERED_RESEARCH_SOURCE) {
    throw new Error('registered research family must originate from the Desk hash-chained ledger');
  }
  if (!Number.isSafeInteger(input.ledgerSeq) || input.ledgerSeq <= 0) {
    throw new Error('ledgerSeq must identify a committed durable ledger row');
  }
  if (!/^[0-9a-f]{64}$/.test(input.ledgerHash)) {
    throw new Error('ledgerHash must be a canonical 64-character lowercase SHA-256 digest');
  }
}

/**
 * Public statistical boundary for pre-registered research.
 *
 * Production callers must obtain `input` from Desk's verified ledger boundary.
 * This function deliberately exposes no registration factory and no promotion
 * authority; it only validates forwarded provenance and runs deterministic FDR.
 */
export function evaluateLedgerRegisteredResearchFamily(
  input: LedgerRegisteredResearchFamily,
  results: readonly LedgerRegisteredResearchTestResult[],
): LedgerRegisteredResearchEvaluation {
  validateLedgerProvenance(input);
  return evaluateRegisteredHypothesisFamily(input.family, input.receipt, results);
}
