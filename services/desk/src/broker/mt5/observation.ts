import type { Mt5EvidenceCandidate, Mt5Fingerprint, Mt5ReconcileObservation } from './evidence.js';

export type Mt5ObservationVerdict =
  | {
      readonly outcome: 'confirmed';
      readonly matches: readonly Mt5EvidenceCandidate[];
      readonly evidence: string;
    }
  | {
      readonly outcome: 'terminal';
      readonly order: Mt5EvidenceCandidate;
      readonly venueState: 'REJECTED' | 'CANCELLED' | 'EXPIRED';
      readonly evidence: string;
    }
  | {
      readonly outcome: 'probable';
      readonly matches: readonly Mt5EvidenceCandidate[];
      readonly reason: string;
    }
  | {
      /**
       * The magic was found on more than one distinct execution. Deliberately
       * neither `confirmed` nor `indeterminate`: the facts are known and they
       * are bad, which is different from not knowing them.
       */
      readonly outcome: 'duplicate';
      readonly matches: readonly Mt5EvidenceCandidate[];
      readonly reason: string;
    }
  | { readonly outcome: 'negative'; readonly evidence: string }
  | { readonly outcome: 'indeterminate'; readonly reason: string };

const DECIMAL_INTEGER = /^[0-9]+$/;
const ORDER_STATES = new Set([
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
const NON_EXECUTED_TERMINAL_STATES = new Set(['REJECTED', 'CANCELLED', 'EXPIRED'] as const);

function sameFingerprint(candidate: Mt5EvidenceCandidate, expected: Mt5Fingerprint): boolean {
  return (
    candidate.symbol === expected.symbol &&
    candidate.side === expected.side &&
    candidate.volume === expected.volume &&
    candidate.serverTime >= expected.sentNotBefore &&
    candidate.serverTime <= expected.sentNotAfter
  );
}

function groupKey(candidate: Mt5EvidenceCandidate): string {
  return candidate.positionId === undefined
    ? `${candidate.kind}:${candidate.ticket}`
    : `position:${candidate.positionId}`;
}

function validateCandidate(candidate: Mt5EvidenceCandidate): void {
  if (!DECIMAL_INTEGER.test(candidate.ticket) || !DECIMAL_INTEGER.test(candidate.magic)) {
    throw new Error('MT5 evidence identifiers must be decimal strings');
  }
  if (!Number.isFinite(candidate.serverTime)) {
    throw new Error('MT5 evidence time must be finite');
  }
  if (candidate.kind === 'order') {
    if (candidate.orderState === undefined || !ORDER_STATES.has(candidate.orderState)) {
      throw new Error('MT5 order evidence must include a recognised orderState');
    }
  } else if (candidate.orderState !== undefined) {
    throw new Error('MT5 deal/position evidence cannot carry orderState');
  }
}

/**
 * Classify one authoritative MT5 state/history scan.
 *
 * This intentionally does NOT conclude durable absence. The higher-level
 * UnknownResolver requires repeated, separated negative lookups. Keeping that
 * temporal policy in one place prevents the adapter and resolver from each
 * demanding their own independent pair of negatives (which would otherwise
 * require four scans to resolve one unknown send).
 */
export function inspectMt5Observation(
  expectedMagic: string,
  fingerprint: Mt5Fingerprint,
  observation: Mt5ReconcileObservation,
  historyGuardMs = 5_000,
): Mt5ObservationVerdict {
  if (!DECIMAL_INTEGER.test(expectedMagic)) throw new Error('expected MT5 magic must be decimal');
  if (fingerprint.sentNotAfter < fingerprint.sentNotBefore) {
    throw new Error('MT5 fingerprint send window is inverted');
  }
  if (historyGuardMs < 0) throw new Error('MT5 history guard must be non-negative');

  const candidates = observation.candidates.filter((candidate) => {
    validateCandidate(candidate);
    return true;
  });

  const exact = candidates.filter((candidate) => candidate.magic === expectedMagic);
  if (exact.length > 0) {
    const executionEvidence = exact.filter(
      (candidate) => candidate.kind === 'deal' || candidate.kind === 'position',
    );
    if (executionEvidence.length > 0) {
      // Count distinct executions, not objects. One intent legitimately produces
      // several deals and a position, all sharing the magic, so a raw count
      // proves nothing. More than one execution group means the same intent
      // reached the venue twice -- the worst outcome this system can produce --
      // and it must never be reported as a clean confirmation. The fingerprint
      // path below has always grouped before deciding; this path did not, so
      // the weaker evidence was the better guarded.
      const executions = new Set(executionEvidence.map(groupKey));
      if (executions.size > 1) {
        return {
          outcome: 'duplicate',
          matches: exact,
          reason:
            `MT5 state/history contains ${executions.size} distinct executions carrying the ` +
            'expected magic; the same intent reached the venue more than once and requires ' +
            'operator resolution before it can be attributed',
        };
      }
      return {
        outcome: 'confirmed',
        matches: exact,
        evidence:
          `MT5 state/history contains ${executionEvidence.length} execution object(s) ` +
          'carrying the expected magic',
      };
    }

    const orders = exact.filter((candidate) => candidate.kind === 'order');
    const terminalOrders = orders.filter(
      (candidate) =>
        candidate.orderState !== undefined &&
        NON_EXECUTED_TERMINAL_STATES.has(
          candidate.orderState as 'REJECTED' | 'CANCELLED' | 'EXPIRED',
        ),
    );
    if (terminalOrders.length === orders.length && terminalOrders.length > 0) {
      const states = new Set(terminalOrders.map((candidate) => candidate.orderState));
      const tickets = new Set(terminalOrders.map((candidate) => candidate.ticket));
      const terminal = terminalOrders[0];
      if (states.size === 1 && tickets.size === 1 && terminal?.orderState !== undefined) {
        const venueState = terminal.orderState as 'REJECTED' | 'CANCELLED' | 'EXPIRED';
        return {
          outcome: 'terminal',
          order: terminal,
          venueState,
          evidence:
            `MT5 history contains the expected magic on order ${terminal.ticket} ` +
            `with terminal non-executed state ${venueState}`,
        };
      }
      return {
        outcome: 'indeterminate',
        reason:
          'MT5 history contains conflicting terminal order evidence for the expected magic; ' +
          'manual/repeated reconciliation is required',
      };
    }

    const orderStates = orders.map((candidate) => candidate.orderState ?? 'UNKNOWN');
    return {
      outcome: 'indeterminate',
      reason:
        `MT5 history contains the expected magic only on order evidence ` +
        `[${orderStates.join(',')}]; an order proves venue receipt but does not by itself prove execution`,
    };
  }

  const fingerprintMatches = candidates.filter((candidate) =>
    sameFingerprint(candidate, fingerprint),
  );
  if (fingerprintMatches.length > 0) {
    const groups = new Set(fingerprintMatches.map(groupKey));
    if (groups.size === 1) {
      return {
        outcome: 'probable',
        matches: fingerprintMatches,
        reason:
          'magic was not preserved, but one execution group matches the send fingerprint; ' +
          'manual/repeated reconciliation is required before attribution',
      };
    }
    return {
      outcome: 'indeterminate',
      reason: `magic was not preserved and the fallback fingerprint matches ${groups.size} execution groups`,
    };
  }

  if (!observation.connected) {
    return {
      outcome: 'indeterminate',
      reason: 'MT5 terminal was disconnected during reconciliation',
    };
  }
  if (!observation.positionsScanned || !observation.ordersScanned || !observation.historySelected) {
    return {
      outcome: 'indeterminate',
      reason: 'MT5 reconciliation did not successfully scan positions, orders, and history',
    };
  }

  const requiredFrom = fingerprint.sentNotBefore - historyGuardMs;
  const requiredTo = fingerprint.sentNotAfter + historyGuardMs;
  if (observation.historyFrom > requiredFrom || observation.historyTo < requiredTo) {
    return {
      outcome: 'indeterminate',
      reason: `MT5 history window ${observation.historyFrom}..${observation.historyTo} does not cover ${requiredFrom}..${requiredTo}`,
    };
  }

  return {
    outcome: 'negative',
    evidence:
      `connected full-state scan found no expected magic or matching fingerprint; ` +
      `history covered ${requiredFrom}..${requiredTo}`,
  };
}
