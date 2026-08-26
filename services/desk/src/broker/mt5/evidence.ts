export type Mt5EvidenceKind = 'order' | 'deal' | 'position';
export type Mt5EvidenceOrderState =
  | 'PENDING_SUBMIT'
  | 'WORKING'
  | 'PARTIAL'
  | 'FILLED'
  | 'CANCEL_PENDING'
  | 'CANCELLED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'UNKNOWN';

/**
 * One broker object returned by a reconciliation scan.
 *
 * `magic` and tickets are decimal strings on purpose: MT5 exposes 64-bit
 * identifiers and JavaScript Number cannot represent all of them exactly.
 *
 * Historical orders also carry their terminal order state. This is critical:
 * finding a matching historical order proves the venue saw the request, but a
 * REJECTED/CANCELLED/EXPIRED order is not execution evidence and must never be
 * reconstructed as a fill.
 */
export interface Mt5EvidenceCandidate {
  readonly kind: Mt5EvidenceKind;
  readonly ticket: string;
  readonly magic: string;
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly volume: string;
  readonly price?: string;
  readonly serverTime: number;
  readonly positionId?: string;
  readonly orderState?: Mt5EvidenceOrderState;
}

export interface Mt5Fingerprint {
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly volume: string;
  readonly sentNotBefore: number;
  readonly sentNotAfter: number;
}

/**
 * A single full reconciliation observation performed by the Windows execution
 * host. The desk only accepts a negative result when *all* required MT5 state
 * surfaces were scanned successfully and the history window covers the send.
 */
export interface Mt5ReconcileObservation {
  readonly observedAt: number;
  readonly connected: boolean;
  readonly positionsScanned: boolean;
  readonly ordersScanned: boolean;
  readonly historySelected: boolean;
  readonly historyFrom: number;
  readonly historyTo: number;
  readonly candidates: readonly Mt5EvidenceCandidate[];
}

export type Mt5EvidenceResolution =
  | {
      readonly outcome: 'found';
      readonly certainty: 'confirmed';
      readonly matches: readonly Mt5EvidenceCandidate[];
      readonly evidence: string;
    }
  | {
      readonly outcome: 'probable';
      readonly certainty: 'reduced';
      readonly matches: readonly Mt5EvidenceCandidate[];
      readonly reason: string;
    }
  | { readonly outcome: 'absent'; readonly evidence: string }
  | { readonly outcome: 'indeterminate'; readonly reason: string };

export interface Mt5ResolveOptions {
  /** At least two independent full negatives are required by default. */
  readonly minimumNegativeObservations?: number;
  /** Prevent two reads from the same instant being counted as independent. */
  readonly minimumNegativeSeparationMs?: number;
  /** Expand the history window around the local send timestamps. */
  readonly historyGuardMs?: number;
}

const DECIMAL_INTEGER = /^[0-9]+$/;
const ORDER_STATES = new Set<Mt5EvidenceOrderState>([
  'PENDING_SUBMIT',
  'WORKING',
  'PARTIAL',
  'FILLED',
  'CANCEL_PENDING',
  'CANCELLED',
  'REJECTED',
  'EXPIRED',
  'UNKNOWN',
]);

function validateCandidate(candidate: Mt5EvidenceCandidate): void {
  if (!DECIMAL_INTEGER.test(candidate.ticket))
    throw new Error('MT5 evidence ticket must be decimal');
  if (!DECIMAL_INTEGER.test(candidate.magic)) throw new Error('MT5 evidence magic must be decimal');
  if (!Number.isFinite(candidate.serverTime)) throw new Error('MT5 evidence time must be finite');
  if (candidate.kind === 'order') {
    if (candidate.orderState === undefined || !ORDER_STATES.has(candidate.orderState)) {
      throw new Error('MT5 order evidence must include a recognised orderState');
    }
  } else if (candidate.orderState !== undefined) {
    throw new Error('MT5 deal/position evidence cannot carry orderState');
  }
}

function sameFingerprint(candidate: Mt5EvidenceCandidate, expected: Mt5Fingerprint): boolean {
  return (
    candidate.symbol === expected.symbol &&
    candidate.side === expected.side &&
    candidate.volume === expected.volume &&
    candidate.serverTime >= expected.sentNotBefore &&
    candidate.serverTime <= expected.sentNotAfter
  );
}

function uniqueCandidates(candidates: readonly Mt5EvidenceCandidate[]): Mt5EvidenceCandidate[] {
  const seen = new Set<string>();
  const result: Mt5EvidenceCandidate[] = [];
  for (const candidate of candidates) {
    validateCandidate(candidate);
    const key = `${candidate.kind}:${candidate.ticket}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

function candidateGroups(candidates: readonly Mt5EvidenceCandidate[]): number {
  const groups = new Set<string>();
  for (const candidate of candidates) {
    // DEAL_POSITION_ID/POSITION_IDENTIFIER lets order/deal/position evidence from
    // one trade collapse into one group. Without it we must conservatively treat
    // separate tickets as separate possible executions.
    groups.add(
      candidate.positionId === undefined
        ? `${candidate.kind}:${candidate.ticket}`
        : `p:${candidate.positionId}`,
    );
  }
  return groups.size;
}

/**
 * Resolve an ambiguous MT5 send from authoritative state scans.
 *
 * Events are intentionally absent from the input. OnTradeTransaction is an
 * unordered, bounded hint queue; ADR-0015 makes reconciliation state the source
 * of truth instead.
 */
export function resolveMt5Evidence(
  expectedMagic: string,
  fingerprint: Mt5Fingerprint,
  observations: readonly Mt5ReconcileObservation[],
  options: Mt5ResolveOptions = {},
): Mt5EvidenceResolution {
  if (!DECIMAL_INTEGER.test(expectedMagic)) throw new Error('expected MT5 magic must be decimal');
  if (fingerprint.sentNotAfter < fingerprint.sentNotBefore) {
    throw new Error('MT5 fingerprint send window is inverted');
  }

  const minimumNegativeObservations = options.minimumNegativeObservations ?? 2;
  const minimumNegativeSeparationMs = options.minimumNegativeSeparationMs ?? 750;
  const historyGuardMs = options.historyGuardMs ?? 5_000;
  if (!Number.isInteger(minimumNegativeObservations) || minimumNegativeObservations < 2) {
    throw new Error('MT5 absence requires at least two negative observations');
  }
  if (minimumNegativeSeparationMs < 0 || historyGuardMs < 0) {
    throw new Error('MT5 evidence timing options must be non-negative');
  }
  if (observations.length === 0) {
    return { outcome: 'indeterminate', reason: 'no reconciliation observation is available' };
  }

  const allCandidates = uniqueCandidates(
    observations.flatMap((observation) => observation.candidates),
  );
  const exact = allCandidates.filter((candidate) => candidate.magic === expectedMagic);
  if (exact.length > 0) {
    return {
      outcome: 'found',
      certainty: 'confirmed',
      matches: exact,
      evidence: `MT5 state/history contains ${exact.length} object(s) carrying the expected magic`,
    };
  }

  // A fingerprint is fallback evidence only. One trade can legitimately produce
  // an order, deal and position, so use position identity to collapse those into
  // a single probable execution before deciding whether the fallback is unique.
  const fingerprintMatches = allCandidates.filter((candidate) =>
    sameFingerprint(candidate, fingerprint),
  );
  if (fingerprintMatches.length > 0) {
    const groups = candidateGroups(fingerprintMatches);
    if (groups === 1) {
      return {
        outcome: 'probable',
        certainty: 'reduced',
        matches: fingerprintMatches,
        reason: 'magic was not found, but exactly one execution group matches the send fingerprint',
      };
    }
    return {
      outcome: 'indeterminate',
      reason: `magic was not found and the fallback fingerprint matches ${groups} execution groups`,
    };
  }

  const coveringFrom = fingerprint.sentNotBefore - historyGuardMs;
  const coveringTo = fingerprint.sentNotAfter + historyGuardMs;
  const validNegatives = observations
    .filter(
      (observation) =>
        observation.connected &&
        observation.positionsScanned &&
        observation.ordersScanned &&
        observation.historySelected &&
        observation.historyFrom <= coveringFrom &&
        observation.historyTo >= coveringTo,
    )
    .sort((a, b) => a.observedAt - b.observedAt);

  if (validNegatives.length < minimumNegativeObservations) {
    return {
      outcome: 'indeterminate',
      reason:
        `only ${validNegatives.length} trustworthy negative reconciliation observation(s); ` +
        `${minimumNegativeObservations} required`,
    };
  }

  const first = validNegatives[0];
  const last = validNegatives[validNegatives.length - 1];
  if (first === undefined || last === undefined) {
    return { outcome: 'indeterminate', reason: 'negative reconciliation evidence disappeared' };
  }
  if (last.observedAt - first.observedAt < minimumNegativeSeparationMs) {
    return {
      outcome: 'indeterminate',
      reason:
        `negative observations are only ${last.observedAt - first.observedAt}ms apart; ` +
        `${minimumNegativeSeparationMs}ms required`,
    };
  }

  return {
    outcome: 'absent',
    evidence:
      `${validNegatives.length} connected full-state scans found no magic or unique fingerprint match; ` +
      `history covered ${coveringFrom}..${coveringTo}`,
  };
}
