import { describe, expect, it } from 'vitest';
import {
  classifyMt5CommandRecovery,
  mayRetryBeforeSend,
  type Mt5CommandLifecycleRecord,
  validateMt5CommandLifecycle,
} from './command-lifecycle.js';

function record(
  stage: Mt5CommandLifecycleRecord['stage'],
  at: number,
  extras: Partial<Mt5CommandLifecycleRecord> = {},
): Mt5CommandLifecycleRecord {
  return {
    requestId: 'req-12345678',
    command: 'place_order',
    stage,
    at,
    ...extras,
  };
}

describe('MT5 command lifecycle', () => {
  it('allows the full monotonic lifecycle', () => {
    const records = [
      record('RECEIVED', 10),
      record('CHECKED', 20),
      record('SENT', 30),
      record('RESULT', 40, { outcome: 'accepted' }),
    ];

    expect(() => validateMt5CommandLifecycle(records)).not.toThrow();
    expect(classifyMt5CommandRecovery(records)).toEqual({
      kind: 'resolved',
      outcome: 'accepted',
    });
  });

  it('treats crash after SENT as ambiguous and requires reconciliation', () => {
    const records = [record('RECEIVED', 10), record('CHECKED', 20), record('SENT', 30)];

    expect(classifyMt5CommandRecovery(records)).toEqual({
      kind: 'must_reconcile',
      lastStage: 'SENT',
    });
    expect(mayRetryBeforeSend(records)).toBe(false);
  });

  it('permits retry only when durable history proves the send boundary was not crossed', () => {
    expect(mayRetryBeforeSend([])).toBe(true);
    expect(mayRetryBeforeSend([record('RECEIVED', 10)])).toBe(true);
    expect(mayRetryBeforeSend([record('RECEIVED', 10), record('CHECKED', 20)])).toBe(true);
  });

  it('supports deterministic rejection before any send side effect', () => {
    const records = [
      record('RECEIVED', 10),
      record('CHECKED', 20),
      record('RESULT', 30, { outcome: 'rejected', reason: 'order_check_failed' }),
    ];

    expect(() => validateMt5CommandLifecycle(records)).not.toThrow();
    expect(classifyMt5CommandRecovery(records)).toEqual({
      kind: 'resolved',
      outcome: 'rejected',
      reason: 'order_check_failed',
    });
  });

  it('rejects duplicate and backwards lifecycle records', () => {
    expect(() =>
      validateMt5CommandLifecycle([
        record('RECEIVED', 10),
        record('CHECKED', 20),
        record('CHECKED', 30),
      ]),
    ).toThrow(/monotonically/);

    expect(() =>
      validateMt5CommandLifecycle([record('RECEIVED', 10), record('SENT', 20)]),
    ).toThrow(/SENT must follow CHECKED/);
  });

  it('rejects mixed request ids and commands', () => {
    expect(() =>
      validateMt5CommandLifecycle([
        record('RECEIVED', 10),
        record('CHECKED', 20, { requestId: 'other-12345678' }),
      ]),
    ).toThrow(/mixed request ids/);

    expect(() =>
      validateMt5CommandLifecycle([
        record('RECEIVED', 10),
        record('CHECKED', 20, { command: 'close_position' }),
      ]),
    ).toThrow(/changed command/);
  });

  it('requires RESULT outcome and forbids outcome on intermediate stages', () => {
    expect(() =>
      validateMt5CommandLifecycle([record('RECEIVED', 10), record('RESULT', 20)]),
    ).toThrow(/requires outcome/);

    expect(() =>
      validateMt5CommandLifecycle([
        record('RECEIVED', 10, { outcome: 'accepted' }),
      ]),
    ).toThrow(/cannot carry outcome/);
  });

  it('keeps read-only snapshot and reconcile commands outside the SENT boundary', () => {
    for (const command of ['snapshot', 'reconcile'] as const) {
      expect(() =>
        validateMt5CommandLifecycle([
          record('RECEIVED', 10, { command }),
          record('CHECKED', 20, { command }),
          record('SENT', 30, { command }),
        ]),
      ).toThrow(/cannot cross the SENT/);
    }
  });
});
