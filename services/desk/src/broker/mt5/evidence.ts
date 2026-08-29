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

/**
 * This module is the shared *vocabulary* for MT5 reconciliation evidence and
 * nothing more.
 *
 * It previously also carried a second, independent classifier
 * (`resolveMt5Evidence`) alongside the one in `observation.ts`. The two encoded
 * the same rules with subtle differences and drifted: a duplicate-execution
 * guard was added to one and not the other, so the same input could be judged
 * differently depending on which entry point a caller happened to use. Only the
 * `observation.ts` classifier was ever reachable from the adapter; the other was
 * exercised solely by its own tests, which is exactly how two implementations of
 * one safety rule stay green while disagreeing.
 *
 * There is now one classifier: `classifyMt5Evidence` in `observation.ts`.
 * Types live here so both the transport validators and the classifier can share
 * them without a cycle.
 */
