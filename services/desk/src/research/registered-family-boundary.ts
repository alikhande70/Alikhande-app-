import {
  readHypothesisFamilyRegistration,
  toHypothesisEvaluationRegistrationInputs,
} from '../ledger/hypothesis-registration.js';
import type { Ledger } from '../ledger/ledger.js';

export class RegisteredFamilyBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegisteredFamilyBoundaryError';
  }
}

/**
 * Read-only research boundary. The caller supplies only a family identity.
 * The immutable family definition and transaction-time receipt are recovered
 * from the verified Desk ledger rather than accepted from caller memory.
 */
export function readDurableRegisteredFamily(ledger: Ledger, familyId: string) {
  const registration = readHypothesisFamilyRegistration(ledger, familyId);
  if (registration === undefined) {
    throw new RegisteredFamilyBoundaryError(
      `registered family '${familyId}' does not exist in the durable ledger`,
    );
  }
  return toHypothesisEvaluationRegistrationInputs(registration);
}
