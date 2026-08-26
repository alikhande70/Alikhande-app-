import { describe, expect, it } from 'vitest';
import * as D from '../money/decimal.js';
import type { OrderEvent, OrderRecord } from './orderState.js';
import { applyOrderEvent, CERTAINTY, newOrderRecord } from './orderState.js';

const T = 1_000_000;
const d = D.dec;

function drive(events: readonly OrderEvent[]): OrderRecord {
  let record = newOrderRecord('intent-terminal-recovery', d('1.00'), T);
  for (const event of events) {
    const result = applyOrderEvent(record, event);
    if (!result.ok) throw new Error(result.refusal);
    record = result.record;
  }
  return record;
}

describe('terminal recovery from an ambiguous send', () => {
  it.each(['REJECTED', 'CANCELLED', 'EXPIRED'] as const)(
    'adopts authoritative %s history without inventing a fill',
    (venueState) => {
      const record = drive([
        { type: 'submit.started', at: T + 1 },
        { type: 'submit.ambiguous', at: T + 2, reason: 'response lost after send' },
        {
          type: 'resolution.found',
          at: T + 30,
          venueOrderId: 'V-terminal',
          venueState,
          filledQty: d('0.00'),
        },
      ]);

      expect(record.state).toBe(venueState);
      expect(CERTAINTY[record.state]).toBe('confirmed');
      expect(record.venueOrderId).toBe('V-terminal');
      expect(D.isZero(record.filledQty)).toBe(true);
      expect(record.resolutionAttempts).toBe(1);
    },
  );
});
