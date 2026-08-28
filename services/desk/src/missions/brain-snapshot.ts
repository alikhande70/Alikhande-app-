import type { BrainDecisionEvidence, DecisionSnapshot } from './types.js';

interface BrainResultLikeBase {
  readonly status: 'scored' | 'insufficient-data';
  readonly brainVersion: string;
  readonly featureSetVersion: string;
  readonly rubricVersion: string;
  readonly asOf: number;
  readonly rationaleCodes?: readonly string[];
}

export type BrainResultLike =
  | (BrainResultLikeBase & {
      readonly status: 'scored';
      readonly score: { readonly value: number; readonly rationaleCodes: readonly string[] };
    })
  | (BrainResultLikeBase & {
      readonly status: 'insufficient-data';
      readonly missing: readonly string[];
      readonly rationaleCodes: readonly string[];
    });

export interface FeatureExtractionLike {
  readonly vector: {
    readonly featureSetVersion: string;
    readonly asOf: number;
    readonly values: Readonly<Record<string, number | undefined>>;
  };
  readonly evidence: readonly {
    readonly featureKey: string;
    readonly sourceKey: string;
    readonly validAt: number;
    readonly recordedAt: number;
    readonly rawValue: number;
    readonly normalizedValue: number;
  }[];
  readonly missing: readonly string[];
}

export class BrainSnapshotInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrainSnapshotInvariantError';
  }
}

function nonEmpty(value: string, field: string): void {
  if (value.trim().length === 0)
    throw new BrainSnapshotInvariantError(`${field} must not be empty`);
}

function finiteTime(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new BrainSnapshotInvariantError(`${field} must be a finite non-negative timestamp`);
  }
}

function uniqueStrings(values: readonly string[], field: string): readonly string[] {
  const seen = new Set<string>();
  for (const value of values) {
    nonEmpty(value, field);
    if (seen.has(value))
      throw new BrainSnapshotInvariantError(`${field} contains duplicate '${value}'`);
    seen.add(value);
  }
  return [...seen].sort();
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, index) => value === right[index]);
}

/**
 * Build the immutable deterministic-Brain portion of a Mission decision snapshot.
 *
 * The bridge accepts only already-computed deterministic structures. It performs
 * no market reads, no clock reads and no LLM calls. Its only job is to prove that
 * the score, feature extraction and bitemporal evidence all describe the exact
 * point-in-time snapshot being sealed, then copy that evidence into the Mission
 * ledger payload.
 */
export function withBrainDecisionEvidence(input: {
  readonly snapshot: DecisionSnapshot;
  readonly evaluation: BrainResultLike;
  readonly extraction: FeatureExtractionLike;
  readonly knowledgeCutoff: number;
}): DecisionSnapshot {
  const { snapshot, evaluation, extraction, knowledgeCutoff } = input;

  nonEmpty(evaluation.brainVersion, 'brainVersion');
  nonEmpty(evaluation.featureSetVersion, 'featureSetVersion');
  nonEmpty(evaluation.rubricVersion, 'rubricVersion');
  finiteTime(snapshot.asOf, 'snapshot asOf');
  finiteTime(evaluation.asOf, 'brain asOf');
  finiteTime(extraction.vector.asOf, 'feature vector asOf');
  finiteTime(knowledgeCutoff, 'knowledgeCutoff');

  if (evaluation.asOf !== snapshot.asOf || extraction.vector.asOf !== snapshot.asOf) {
    throw new BrainSnapshotInvariantError(
      'Brain, feature vector and decision snapshot asOf must match',
    );
  }
  if (knowledgeCutoff < snapshot.asOf) {
    throw new BrainSnapshotInvariantError('knowledgeCutoff cannot precede decision snapshot asOf');
  }
  if (evaluation.featureSetVersion !== extraction.vector.featureSetVersion) {
    throw new BrainSnapshotInvariantError('Brain and feature extraction versions do not match');
  }
  if (snapshot.brainVersion !== undefined && snapshot.brainVersion !== evaluation.brainVersion) {
    throw new BrainSnapshotInvariantError(
      'legacy brainVersion conflicts with deterministic evaluation',
    );
  }

  const evidenceKeys = new Set<string>();
  const evidence = extraction.evidence.map((item) => {
    nonEmpty(item.featureKey, 'feature evidence key');
    nonEmpty(item.sourceKey, 'feature evidence source');
    if (evidenceKeys.has(item.featureKey)) {
      throw new BrainSnapshotInvariantError(`duplicate feature evidence '${item.featureKey}'`);
    }
    evidenceKeys.add(item.featureKey);
    finiteTime(item.validAt, `feature '${item.featureKey}' validAt`);
    finiteTime(item.recordedAt, `feature '${item.featureKey}' recordedAt`);
    if (item.recordedAt < item.validAt) {
      throw new BrainSnapshotInvariantError(
        `feature '${item.featureKey}' was recorded before validAt`,
      );
    }
    if (item.validAt > snapshot.asOf) {
      throw new BrainSnapshotInvariantError(
        `feature '${item.featureKey}' is future market evidence`,
      );
    }
    if (item.recordedAt > knowledgeCutoff) {
      throw new BrainSnapshotInvariantError(
        `feature '${item.featureKey}' was learned after knowledgeCutoff`,
      );
    }
    if (!Number.isFinite(item.rawValue)) {
      throw new BrainSnapshotInvariantError(`feature '${item.featureKey}' rawValue must be finite`);
    }
    if (
      !Number.isFinite(item.normalizedValue) ||
      item.normalizedValue < 0 ||
      item.normalizedValue > 1
    ) {
      throw new BrainSnapshotInvariantError(
        `feature '${item.featureKey}' normalizedValue must be in [0,1]`,
      );
    }
    return { ...item };
  });
  evidence.sort((a, b) => a.featureKey.localeCompare(b.featureKey));

  const extractionMissing = uniqueStrings(extraction.missing, 'feature extraction missing');
  const missingSet = new Set(extractionMissing);
  const evidenceByKey = new Map(evidence.map((item) => [item.featureKey, item]));

  for (const missing of extractionMissing) {
    if (evidenceKeys.has(missing)) {
      throw new BrainSnapshotInvariantError(
        `feature '${missing}' cannot be both evidence and missing`,
      );
    }
    if (!(missing in extraction.vector.values)) {
      throw new BrainSnapshotInvariantError(
        `missing feature '${missing}' is absent from the scored feature vector`,
      );
    }
    if (extraction.vector.values[missing] !== undefined) {
      throw new BrainSnapshotInvariantError(
        `missing feature '${missing}' unexpectedly has a vector value`,
      );
    }
  }

  for (const [featureKey, vectorValue] of Object.entries(extraction.vector.values)) {
    nonEmpty(featureKey, 'feature vector key');
    if (vectorValue === undefined) {
      if (!missingSet.has(featureKey)) {
        throw new BrainSnapshotInvariantError(
          `undefined vector feature '${featureKey}' is not recorded as missing`,
        );
      }
      continue;
    }
    if (!Number.isFinite(vectorValue) || vectorValue < 0 || vectorValue > 1) {
      throw new BrainSnapshotInvariantError(
        `vector feature '${featureKey}' must be a finite normalized value in [0,1]`,
      );
    }
    const item = evidenceByKey.get(featureKey);
    if (item === undefined) {
      throw new BrainSnapshotInvariantError(
        `vector feature '${featureKey}' has no persisted evidence coordinate`,
      );
    }
    if (item.normalizedValue !== vectorValue) {
      throw new BrainSnapshotInvariantError(
        `vector feature '${featureKey}' does not match persisted normalized evidence`,
      );
    }
  }

  for (const evidenceItem of evidence) {
    if (!(evidenceItem.featureKey in extraction.vector.values)) {
      throw new BrainSnapshotInvariantError(
        `persisted evidence '${evidenceItem.featureKey}' is absent from the scored feature vector`,
      );
    }
  }

  let brainEvaluation: BrainDecisionEvidence;
  if (evaluation.status === 'scored') {
    if (extractionMissing.length > 0) {
      throw new BrainSnapshotInvariantError(
        'a scored Brain result cannot hide missing extracted features',
      );
    }
    if (
      !Number.isFinite(evaluation.score.value) ||
      evaluation.score.value < 0 ||
      evaluation.score.value > 100
    ) {
      throw new BrainSnapshotInvariantError('Brain score must be finite and inside 0..100');
    }
    brainEvaluation = {
      status: 'scored',
      brainVersion: evaluation.brainVersion,
      featureSetVersion: evaluation.featureSetVersion,
      rubricVersion: evaluation.rubricVersion,
      decisionAsOf: snapshot.asOf,
      knowledgeCutoff,
      score: evaluation.score.value,
      rationaleCodes: uniqueStrings(evaluation.score.rationaleCodes, 'Brain rationale code'),
      evidence,
      missing: [],
    };
  } else {
    const evaluationMissing = uniqueStrings(evaluation.missing, 'Brain missing feature');
    if (evaluationMissing.length === 0) {
      throw new BrainSnapshotInvariantError(
        'insufficient-data requires at least one missing feature',
      );
    }
    if (!sameStrings(evaluationMissing, extractionMissing)) {
      throw new BrainSnapshotInvariantError(
        'Brain missing features differ from feature extraction evidence',
      );
    }
    brainEvaluation = {
      status: 'insufficient-data',
      brainVersion: evaluation.brainVersion,
      featureSetVersion: evaluation.featureSetVersion,
      rubricVersion: evaluation.rubricVersion,
      decisionAsOf: snapshot.asOf,
      knowledgeCutoff,
      rationaleCodes: uniqueStrings(evaluation.rationaleCodes, 'Brain rationale code'),
      evidence,
      missing: evaluationMissing,
    };
  }

  const snapshotMissing = uniqueStrings(snapshot.missing, 'decision snapshot missing item');
  const mergedMissing = [...new Set([...snapshotMissing, ...brainEvaluation.missing])].sort();

  return {
    ...snapshot,
    missing: mergedMissing,
    brainVersion: evaluation.brainVersion,
    brainEvaluation,
  };
}
