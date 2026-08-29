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

export interface LedgerRegisteredResearchProvenance {
  readonly source: typeof LEDGER_REGISTERED_RESEARCH_SOURCE;
  readonly ledgerSeq: number;
  readonly ledgerHash: string;
  readonly familyHash: string;
  readonly registeredAt: number;
  readonly registrationKnownAt: number;
}

export type LedgerRegisteredResearchTestResult = RegisteredTestResult;
export type LedgerRegisteredResearchEvaluation = RegisteredHypothesisFamilyEvaluation & {
  /**
   * Immutable audit link back to the exact durable registration row used for
   * this statistical evaluation. Statistical results must never shed their
   * transaction-time provenance before later review/memory layers consume them.
   */
  readonly registrationProvenance: LedgerRegisteredResearchProvenance;
};

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
 * The returned result retains the exact ledger identity and bitemporal
 * registration timestamps so later audit/memory code cannot detach a result
 * from the durable fact that authorized its evaluation.
 */
export function evaluateLedgerRegisteredResearchFamily(
  input: LedgerRegisteredResearchFamily,
  results: readonly LedgerRegisteredResearchTestResult[],
): LedgerRegisteredResearchEvaluation {
  validateLedgerProvenance(input);
  const evaluation = evaluateRegisteredHypothesisFamily(input.family, input.receipt, results);
  return {
    ...evaluation,
    registrationProvenance: {
      source: input.source,
      ledgerSeq: input.ledgerSeq,
      ledgerHash: input.ledgerHash,
      familyHash: input.receipt.familyHash,
      registeredAt: input.family.registeredAt,
      registrationKnownAt: input.receipt.knownAt,
    },
  };
}
