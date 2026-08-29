import { describe, expect, it } from 'vitest';
import type { HypothesisFamilyRegistrationRecord } from '../ledger/events.js';
import {
  recordHypothesisFamilyRegistration,
  sealHypothesisFamilyRegistration,
} from '../ledger/hypothesis-registration.js';
import { Ledger } from '../ledger/ledger.js';
import {
  RegisteredFamilyBoundaryError,
  readDurableRegisteredFamily,
} from './registered-family-boundary.js';

function memoryLedger(): Ledger {
  return new Ledger({ path: ':memory:', synchronous: 'OFF', now: () => 5_000 });
}

function registration(
  overrides: Partial<HypothesisFamilyRegistrationRecord> = {},
): HypothesisFamilyRegistrationRecord {
  const sealed = sealHypothesisFamilyRegistration({
    version: 'registered-hypothesis-family:v1',
    familyId: 'family-boundary-a',
    registeredAt: 4_000,
    method: 'benjamini-hochberg',
    qLevel: 0.05,
    hypotheses: [
      {
        questionId: 'q-forward-edge',
        testId: 'paired-forward-v1',
        analysisPlanHash: 'sha256:plan-forward-edge',
        alternative: 'greater',
      },
    ],
  });
  return { ...sealed, ...overrides };
}

describe('registered hypothesis family research boundary', () => {
  it('derives both the family and receipt from the durable hash-chain ledger', () => {
    const ledger = memoryLedger();
    const sealed = registration();
    recordHypothesisFamilyRegistration(ledger, sealed, 4_250);

    const inputs = readDurableRegisteredFamily(ledger, sealed.familyId);
    expect(inputs.receipt).toEqual({
      familyHash: sealed.familyHash,
      knownAt: 4_250,
    });
    expect(inputs.family).toEqual({
      version: sealed.version,
      familyId: sealed.familyId,
      registeredAt: sealed.registeredAt,
      method: sealed.method,
      qLevel: sealed.qLevel,
      hypotheses: sealed.hypotheses,
    });
    expect(ledger.verifyChain().ok).toBe(true);
    ledger.close();
  });

  it('fails closed instead of manufacturing a receipt for an unknown family', () => {
    const ledger = memoryLedger();
    expect(() => readDurableRegisteredFamily(ledger, 'missing-family')).toThrow(
      RegisteredFamilyBoundaryError,
    );
    expect(ledger.head.seq).toBe(0);
    ledger.close();
  });

  it('inherits duplicate-fact detection from the authoritative ledger read', () => {
    const ledger = memoryLedger();
    const sealed = registration();
    const event = { kind: 'evaluation.hypothesisFamilyRegistered', registration: sealed } as const;
    ledger.append(event, 4_250);
    ledger.append(event, 4_251);

    expect(() => readDurableRegisteredFamily(ledger, sealed.familyId)).toThrow(
      /2 durable registrations/,
    );
    expect(ledger.verifyChain().ok).toBe(true);
    ledger.close();
  });

  it('rejects a ledger fact whose transaction time predates declared registration time', () => {
    const ledger = memoryLedger();
    const sealed = registration();
    ledger.append(
      { kind: 'evaluation.hypothesisFamilyRegistered', registration: sealed },
      sealed.registeredAt - 1,
    );

    expect(() => readDurableRegisteredFamily(ledger, sealed.familyId)).toThrow(
      /durable before its declared registeredAt/,
    );
    ledger.close();
  });
});
