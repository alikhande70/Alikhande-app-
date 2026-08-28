import type { BitemporalFeatureObservation } from './features.js';

/** Minimal immutable ledger envelope consumed by ADR-0019. */
export interface MissionObservedLedgerRow {
  readonly seq: number;
  /** Recorded time assigned by the durable ledger append. */
  readonly ts: number;
  readonly kind: 'mission.observed';
  readonly payload: {
    readonly observation: {
      readonly missionId: string;
      /** Market valid-time captured by the scanner/observer. */
      readonly observedAt: number;
      readonly marketState: Readonly<Record<string, unknown>>;
    };
  };
}

/** Explicit allow-list from durable marketState fields to versioned Brain sources. */
export interface LedgerFeatureBinding {
  readonly sourceKey: string;
  readonly marketStateKey: string;
}

export interface LedgerObservationRequest {
  readonly missionId: string;
  readonly rows: readonly MissionObservedLedgerRow[];
  readonly bindings: readonly LedgerFeatureBinding[];
}

function required(value: string, field: string): void {
  if (value.trim().length === 0) throw new Error(`${field} is required`);
}

function finiteTimestamp(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a finite non-negative timestamp`);
  }
}

/**
 * Convert immutable Mission ledger rows into the only observation form accepted
 * by the deterministic feature extractor.
 *
 * Crucially, validAt comes from the captured market observation while recordedAt
 * comes from the append-only ledger envelope. Current projections, later mission
 * state and AI output are not consulted, so a later correction cannot silently
 * become knowledge the original decision had.
 */
export function observationsFromMissionLedger(
  request: LedgerObservationRequest,
): readonly BitemporalFeatureObservation[] {
  required(request.missionId, 'missionId');
  if (request.bindings.length === 0) throw new Error('at least one ledger feature binding is required');

  const sourceKeys = new Set<string>();
  const marketKeys = new Set<string>();
  for (const binding of request.bindings) {
    required(binding.sourceKey, 'binding sourceKey');
    required(binding.marketStateKey, 'binding marketStateKey');
    if (sourceKeys.has(binding.sourceKey)) {
      throw new Error(`duplicate ledger sourceKey '${binding.sourceKey}'`);
    }
    if (marketKeys.has(binding.marketStateKey)) {
      throw new Error(`duplicate marketStateKey '${binding.marketStateKey}'`);
    }
    sourceKeys.add(binding.sourceKey);
    marketKeys.add(binding.marketStateKey);
  }

  const rows = request.rows.filter((row) => row.payload.observation.missionId === request.missionId);
  let previousSeq = 0;
  const observations: BitemporalFeatureObservation[] = [];

  for (const row of rows) {
    if (!Number.isSafeInteger(row.seq) || row.seq <= 0) throw new Error('ledger seq must be a positive safe integer');
    if (row.seq <= previousSeq) throw new Error('ledger rows must be supplied in strictly increasing seq order');
    previousSeq = row.seq;

    finiteTimestamp(row.ts, 'ledger recorded time');
    finiteTimestamp(row.payload.observation.observedAt, 'mission observedAt');
    if (row.ts < row.payload.observation.observedAt) {
      throw new Error(`ledger row ${row.seq} was recorded before its market valid-time`);
    }

    for (const binding of request.bindings) {
      const raw = row.payload.observation.marketState[binding.marketStateKey];
      if (raw === undefined) continue;
      if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        throw new Error(
          `ledger row ${row.seq} field '${binding.marketStateKey}' must be a finite number`,
        );
      }
      observations.push({
        sourceKey: binding.sourceKey,
        value: raw,
        validAt: row.payload.observation.observedAt,
        recordedAt: row.ts,
      });
    }
  }

  return observations;
}
