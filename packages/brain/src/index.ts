export type BrainVersionId = string;

export type RationaleCode =
  | 'TREND_ALIGNED_HTF'
  | 'ENTRY_AGAINST_MOMENTUM'
  | 'SPREAD_ELEVATED'
  | 'VOLATILITY_EXTREME'
  | 'RISK_GEOMETRY_FAVOURABLE'
  | 'EVENT_PROXIMITY_HIGH'
  | 'LIQUIDITY_THIN'
  | 'FEATURE_MISSING';

/**
 * Point-in-time feature input to the deterministic Brain.
 *
 * Values are normalized by the upstream, versioned feature extractor. The Brain
 * does not read market data, clocks, broker state, environment variables, files,
 * network services or LLM output. A missing feature remains explicitly missing.
 */
export interface FeatureVector {
  readonly featureSetVersion: string;
  readonly asOf: number;
  readonly values: Readonly<Record<string, number | undefined>>;
}

export interface BrainContext {
  readonly canonical: string;
  readonly timeframe: string;
  readonly session: string;
}

export interface RubricFeature {
  readonly key: string;
  /** Non-negative relative contribution weight. */
  readonly weight: number;
  /** Score polarity: positive means larger feature values increase the score. */
  readonly polarity: 'positive' | 'negative';
  readonly rationaleWhenStrong?: RationaleCode;
}

export interface BrainVersion {
  readonly id: BrainVersionId;
  readonly featureSetVersion: string;
  readonly rubricVersion: string;
  readonly missingFeaturePolicy: 'insufficient-data';
  readonly features: readonly RubricFeature[];
}

export interface BrainScore {
  /** Deterministic normalized score. This is not a probability. */
  readonly value: number;
  readonly rationaleCodes: readonly RationaleCode[];
}

export type BrainResult =
  | {
      readonly status: 'scored';
      readonly brainVersion: BrainVersionId;
      readonly featureSetVersion: string;
      readonly rubricVersion: string;
      readonly asOf: number;
      readonly score: BrainScore;
    }
  | {
      readonly status: 'insufficient-data';
      readonly brainVersion: BrainVersionId;
      readonly featureSetVersion: string;
      readonly rubricVersion: string;
      readonly asOf: number;
      readonly missing: readonly string[];
      readonly rationaleCodes: readonly ['FEATURE_MISSING'];
    };

function validateVersion(version: BrainVersion): void {
  if (version.id.trim().length === 0) throw new Error('brain version id is required');
  if (version.featureSetVersion.trim().length === 0)
    throw new Error('feature set version is required');
  if (version.rubricVersion.trim().length === 0) throw new Error('rubric version is required');
  if (version.features.length === 0) throw new Error('brain version must contain features');

  const seen = new Set<string>();
  let positiveWeight = 0;
  for (const feature of version.features) {
    if (feature.key.trim().length === 0) throw new Error('feature key is required');
    if (seen.has(feature.key)) throw new Error(`duplicate feature '${feature.key}'`);
    seen.add(feature.key);
    if (!Number.isFinite(feature.weight) || feature.weight < 0) {
      throw new Error(`feature '${feature.key}' has invalid weight`);
    }
    positiveWeight += feature.weight;
  }
  if (!(positiveWeight > 0))
    throw new Error('brain version must have positive total feature weight');
}

function validateContext(context: BrainContext): void {
  if (context.canonical.trim().length === 0) throw new Error('canonical is required');
  if (context.timeframe.trim().length === 0) throw new Error('timeframe is required');
  if (context.session.trim().length === 0) throw new Error('session is required');
}

function validateFeatureValue(key: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`feature '${key}' must be a finite normalized value in [0,1]`);
  }
}

/**
 * Pure deterministic ADR-0019 evaluator.
 *
 * This function performs no IO and has no hidden mutable state. Given the same
 * BrainVersion, FeatureVector and BrainContext it returns byte-for-byte stable
 * JSON output. It cannot place orders or mutate trading truth.
 */
export function evaluate(
  version: BrainVersion,
  features: FeatureVector,
  context: BrainContext,
): BrainResult {
  validateVersion(version);
  validateContext(context);
  if (!Number.isFinite(features.asOf) || features.asOf < 0) {
    throw new Error('feature vector asOf must be a finite non-negative timestamp');
  }
  if (features.featureSetVersion !== version.featureSetVersion) {
    throw new Error(
      `feature set mismatch: Brain expects '${version.featureSetVersion}', received '${features.featureSetVersion}'`,
    );
  }

  const allowed = new Set(version.features.map((feature) => feature.key));
  for (const [key, value] of Object.entries(features.values)) {
    if (!allowed.has(key)) throw new Error(`unexpected feature '${key}'`);
    if (value !== undefined) validateFeatureValue(key, value);
  }

  const missing: string[] = [];
  for (const feature of version.features) {
    if (features.values[feature.key] === undefined) missing.push(feature.key);
  }
  if (missing.length > 0) {
    return {
      status: 'insufficient-data',
      brainVersion: version.id,
      featureSetVersion: version.featureSetVersion,
      rubricVersion: version.rubricVersion,
      asOf: features.asOf,
      missing: missing.sort(),
      rationaleCodes: ['FEATURE_MISSING'],
    };
  }

  let weighted = 0;
  let totalWeight = 0;
  const rationaleCodes = new Set<RationaleCode>();

  for (const feature of version.features) {
    const raw = features.values[feature.key];
    if (raw === undefined) throw new Error('unreachable missing feature');
    validateFeatureValue(feature.key, raw);
    const contribution = feature.polarity === 'positive' ? raw : 1 - raw;
    weighted += contribution * feature.weight;
    totalWeight += feature.weight;
    if (feature.rationaleWhenStrong !== undefined && contribution >= 0.75) {
      rationaleCodes.add(feature.rationaleWhenStrong);
    }
  }

  // Integer basis points avoid presentation-dependent floating output while keeping
  // deterministic granularity. No calibration or learned fit occurs here.
  const basisPoints = Math.round((weighted / totalWeight) * 10_000);
  const value = basisPoints / 100;

  return {
    status: 'scored',
    brainVersion: version.id,
    featureSetVersion: version.featureSetVersion,
    rubricVersion: version.rubricVersion,
    asOf: features.asOf,
    score: {
      value,
      rationaleCodes: [...rationaleCodes].sort(),
    },
  };
}

export * from './evaluation.js';
export * from './features.js';
export * from './ledger-observations.js';
export * from './version-registry.js';
