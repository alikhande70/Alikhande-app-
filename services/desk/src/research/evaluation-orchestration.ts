import type { Ledger } from '../ledger/ledger.js';
import { readDurableRegisteredFamily } from './registered-family-boundary.js';

export type DurableRegisteredFamily = ReturnType<typeof readDurableRegisteredFamily>;

export type DurableResearchEvaluator<Result, Evaluation> = (
  input: DurableRegisteredFamily,
  results: readonly Result[],
) => Evaluation;

/**
 * Production research composition boundary.
 *
 * Desk owns durable provenance and resolves it from the verified hash-chained
 * ledger. The deterministic statistical evaluator is injected by the caller,
 * keeping Desk independent of Brain while preventing callers from supplying
 * family hashes, transaction timestamps, or ledger identities from memory.
 */
export function evaluateDurableRegisteredResearch<Result, Evaluation>(
  ledger: Ledger,
  familyId: string,
  results: readonly Result[],
  evaluator: DurableResearchEvaluator<Result, Evaluation>,
): Evaluation {
  const durableFamily = readDurableRegisteredFamily(ledger, familyId);
  return evaluator(durableFamily, results);
}
