import type { FeatureVector } from './index.js';

export type FeatureNormalization =
  | { readonly kind: 'identity' }
  | {
      readonly kind: 'linear';
      readonly min: number;
      readonly max: number;
    };

export interface FeatureDefinition {
  /** Stable feature key consumed by a BrainVersion rubric. */
  readonly key: string;
  /** Stable deterministic source field emitted by the scanner/feature producer. */
  readonly sourceKey: string;
  readonly normalization: FeatureNormalization;
  /** Optional valid-time freshness bound. Older evidence becomes explicitly missing. */
  readonly maxAgeMs?: number;
}

export interface FeatureSetVersion {
  readonly id: string;
  readonly definitions: readonly FeatureDefinition[];
}

/**
 * One immutable bitemporal observation.
 *
 * validAt: when the fact was true in market time.
 * recordedAt: when the system first possessed this exact observation.
 *
 * Corrections are represented as additional observations, never mutation.
 */
export interface BitemporalFeatureObservation {
  readonly sourceKey: string;
  readonly value: number;
  readonly validAt: number;
  readonly recordedAt: number;
}

export interface FeatureEvidence {
  readonly featureKey: string;
  readonly sourceKey: string;
  readonly validAt: number;
  readonly recordedAt: number;
  readonly rawValue: number;
  readonly normalizedValue: number;
}

export interface FeatureExtractionResult {
  readonly vector: FeatureVector;
  readonly evidence: readonly FeatureEvidence[];
  readonly missing: readonly string[];
}

export interface FeatureExtractionRequest {
  readonly featureSet: FeatureSetVersion;
  readonly observations: readonly BitemporalFeatureObservation[];
  /** Market valid-time of the decision being reconstructed. */
  readonly decisionAsOf: number;
  /** Recorded-time cutoff: facts learned later are invisible to this decision. */
  readonly knowledgeCutoff: number;
}

function nonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) throw new Error(`${field} is required`);
}

function finiteTime(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a finite non-negative timestamp`);
  }
}

function validateFeatureSet(featureSet: FeatureSetVersion): void {
  nonEmpty(featureSet.id, 'feature set id');
  if (featureSet.definitions.length === 0) throw new Error('feature set must define features');

  const keys = new Set<string>();
  const sources = new Set<string>();
  for (const definition of featureSet.definitions) {
    nonEmpty(definition.key, 'feature key');
    nonEmpty(definition.sourceKey, 'feature source key');
    if (keys.has(definition.key)) throw new Error(`duplicate feature key '${definition.key}'`);
    if (sources.has(definition.sourceKey)) {
      throw new Error(`duplicate feature source '${definition.sourceKey}'`);
    }
    keys.add(definition.key);
    sources.add(definition.sourceKey);

    if (definition.maxAgeMs !== undefined) {
      if (!Number.isFinite(definition.maxAgeMs) || definition.maxAgeMs < 0) {
        throw new Error(`feature '${definition.key}' has invalid maxAgeMs`);
      }
    }

    if (definition.normalization.kind === 'linear') {
      const { min, max } = definition.normalization;
      if (!Number.isFinite(min) || !Number.isFinite(max) || !(max > min)) {
        throw new Error(`feature '${definition.key}' has invalid linear normalization bounds`);
      }
    }
  }
}

function validateObservation(observation: BitemporalFeatureObservation): void {
  nonEmpty(observation.sourceKey, 'observation source key');
  finiteTime(observation.validAt, 'observation validAt');
  finiteTime(observation.recordedAt, 'observation recordedAt');
  if (observation.recordedAt < observation.validAt) {
    throw new Error(
      `observation '${observation.sourceKey}' was recorded before its valid time; clock domain is invalid`,
    );
  }
  if (!Number.isFinite(observation.value)) {
    throw new Error(`observation '${observation.sourceKey}' value must be finite`);
  }
}

function normalize(definition: FeatureDefinition, raw: number): number {
  if (definition.normalization.kind === 'identity') {
    if (raw < 0 || raw > 1) {
      throw new Error(`feature '${definition.key}' identity value must be in [0,1]`);
    }
    return raw;
  }

  const { min, max } = definition.normalization;
  if (raw < min || raw > max) {
    throw new Error(
      `feature '${definition.key}' raw value ${raw} is outside declared range [${min},${max}]`,
    );
  }
  return (raw - min) / (max - min);
}

function selectPointInTime(
  definition: FeatureDefinition,
  observations: readonly BitemporalFeatureObservation[],
  decisionAsOf: number,
  knowledgeCutoff: number,
): BitemporalFeatureObservation | undefined {
  const candidates = observations.filter((observation) => {
    if (observation.sourceKey !== definition.sourceKey) return false;
    if (observation.validAt > decisionAsOf) return false;
    if (observation.recordedAt > knowledgeCutoff) return false;
    if (
      definition.maxAgeMs !== undefined &&
      decisionAsOf - observation.validAt > definition.maxAgeMs
    ) {
      return false;
    }
    return true;
  });

  candidates.sort((a, b) => {
    if (a.validAt !== b.validAt) return b.validAt - a.validAt;
    if (a.recordedAt !== b.recordedAt) return b.recordedAt - a.recordedAt;
    return 0;
  });

  const selected = candidates[0];
  if (selected === undefined) return undefined;

  const contradictions = candidates.filter(
    (candidate) =>
      candidate.validAt === selected.validAt &&
      candidate.recordedAt === selected.recordedAt &&
      candidate.value !== selected.value,
  );
  if (contradictions.length > 0) {
    throw new Error(
      `feature source '${definition.sourceKey}' has contradictory observations at the same bitemporal coordinates`,
    );
  }
  return selected;
}

/**
 * Pure ADR-0019 point-in-time extraction.
 *
 * The extractor never reads current state. It can only see observations whose
 * market valid-time and system recorded-time were both available at the requested
 * historical cutoffs. Later corrections therefore cannot leak into old decisions.
 */
export function extractFeatureVector(request: FeatureExtractionRequest): FeatureExtractionResult {
  validateFeatureSet(request.featureSet);
  finiteTime(request.decisionAsOf, 'decisionAsOf');
  finiteTime(request.knowledgeCutoff, 'knowledgeCutoff');
  if (request.knowledgeCutoff < request.decisionAsOf) {
    throw new Error('knowledgeCutoff cannot precede decisionAsOf');
  }

  for (const observation of request.observations) validateObservation(observation);

  const values: Record<string, number | undefined> = {};
  const evidence: FeatureEvidence[] = [];
  const missing: string[] = [];

  for (const definition of request.featureSet.definitions) {
    const observation = selectPointInTime(
      definition,
      request.observations,
      request.decisionAsOf,
      request.knowledgeCutoff,
    );
    if (observation === undefined) {
      values[definition.key] = undefined;
      missing.push(definition.key);
      continue;
    }

    const normalizedValue = normalize(definition, observation.value);
    values[definition.key] = normalizedValue;
    evidence.push({
      featureKey: definition.key,
      sourceKey: definition.sourceKey,
      validAt: observation.validAt,
      recordedAt: observation.recordedAt,
      rawValue: observation.value,
      normalizedValue,
    });
  }

  evidence.sort((a, b) => a.featureKey.localeCompare(b.featureKey));
  missing.sort();

  return {
    vector: {
      featureSetVersion: request.featureSet.id,
      asOf: request.decisionAsOf,
      values,
    },
    evidence,
    missing,
  };
}
