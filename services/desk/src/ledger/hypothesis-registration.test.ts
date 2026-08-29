import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HypothesisFamilyRegistrationRecord } from './events.js';
import { streamOf } from './events.js';
import {
  HypothesisRegistrationInvariantError,
  listHypothesisFamilyRegistrations,
  readHypothesisFamilyRegistration,
  recordHypothesisFamilyRegistration,
  sealHypothesisFamilyRegistration,
  toHypothesisEvaluationRegistrationInputs,
} from './hypothesis-registration.js';
import { Ledger } from './ledger.js';
import { Projector } from './projections.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function memoryLedger(): Ledger {
  return new Ledger({ path: ':memory:', synchronous: 'OFF', now: () => 5_000 });
}

function registration(
  overrides: Partial<HypothesisFamilyRegistrationRecord> = {},
): HypothesisFamilyRegistrationRecord {
  const sealed = sealHypothesisFamilyRegistration({
    version: 'registered-hypothesis-family:v1',
    familyId: 'family-2026-08-29-a',
    registeredAt: 4_000,
    method: 'benjamini-hochberg',
    qLevel: 0.05,
    hypotheses: [
      {
        questionId: 'q-challenger-edge',
        testId: 'paired-forward-v1',
        analysisPlanHash: 'sha256:plan-a',
        alternative: 'greater',
      },
      {
        questionId: 'q-reject-rate',
        testId: 'paired-forward-v1',
        analysisPlanHash: 'sha256:plan-b',
        alternative: 'two-sided',
      },
    ],
  });
  return { ...sealed, ...overrides };
}

describe('durable registered hypothesis families', () => {
  it('matches the Brain canonical seal and emits ledger-derived evaluation inputs', () => {
    const ledger = memoryLedger();
    const sealed = registration();
    expect(sealed.familyHash).toBe(
      'sha256:df2cf5042f92ef4c56042141f114557dfc6f264ac6d4daefc1e680c3df63e457',
    );

    const first = recordHypothesisFamilyRegistration(ledger, sealed, 4_100);
    const retry = recordHypothesisFamilyRegistration(ledger, sealed, 4_500);
    expect(first.created).toBe(true);
    expect(retry.created).toBe(false);
    expect(retry.registration).toEqual(first.registration);
    expect(ledger.head.seq).toBe(1);
    expect(Ledger.isDurable('evaluation.hypothesisFamilyRegistered')).toBe(true);

    const inputs = toHypothesisEvaluationRegistrationInputs(first.registration);
    expect(inputs.receipt).toEqual({ familyHash: sealed.familyHash, knownAt: 4_100 });
    expect(inputs.family).toEqual({
      version: sealed.version,
      familyId: sealed.familyId,
      registeredAt: sealed.registeredAt,
      method: sealed.method,
      qLevel: sealed.qLevel,
      hypotheses: sealed.hypotheses,
    });
    ledger.close();
  });

  it('canonicalises hypothesis order but keeps a collision-safe family stream', () => {
    const original = registration();
    const reversed = sealHypothesisFamilyRegistration({
      version: original.version,
      familyId: original.familyId,
      registeredAt: original.registeredAt,
      method: original.method,
      qLevel: original.qLevel,
      hypotheses: [...original.hypotheses].reverse(),
    });
    expect(reversed.familyHash).toBe(original.familyHash);

    const a = registration({ familyId: 'a:b' });
    const b = registration({ familyId: 'a' });
    expect(streamOf({ kind: 'evaluation.hypothesisFamilyRegistered', registration: a })).not.toBe(
      streamOf({ kind: 'evaluation.hypothesisFamilyRegistered', registration: b }),
    );
  });

  it('rejects tampering even when a caller reuses a previously valid familyHash', () => {
    const ledger = memoryLedger();
    const valid = registration();
    const tampered: HypothesisFamilyRegistrationRecord = {
      ...valid,
      qLevel: 0.2,
    };
    expect(() => recordHypothesisFamilyRegistration(ledger, tampered, 4_100)).toThrow(
      /family hash mismatch/,
    );
    expect(ledger.head.seq).toBe(0);
    ledger.close();
  });

  it('rejects a conflicting retry for the same family identity', () => {
    const ledger = memoryLedger();
    const first = registration();
    recordHypothesisFamilyRegistration(ledger, first, 4_100);
    const changed = sealHypothesisFamilyRegistration({
      version: first.version,
      familyId: first.familyId,
      registeredAt: first.registeredAt,
      method: first.method,
      qLevel: 0.1,
      hypotheses: first.hypotheses,
    });
    expect(() => recordHypothesisFamilyRegistration(ledger, changed, 4_200)).toThrow(
      HypothesisRegistrationInvariantError,
    );
    expect(ledger.head.seq).toBe(1);
    ledger.close();
  });

  it('fails closed on malformed hashes, duplicate questions and impossible bitemporal ordering', () => {
    const ledger = memoryLedger();
    expect(() =>
      recordHypothesisFamilyRegistration(
        ledger,
        registration({ familyHash: 'SHA256:not-canonical' }),
        4_100,
      ),
    ).toThrow(/canonical sha256/);

    const duplicate = registration();
    expect(() =>
      sealHypothesisFamilyRegistration({
        version: duplicate.version,
        familyId: 'duplicate-family',
        registeredAt: duplicate.registeredAt,
        method: duplicate.method,
        qLevel: duplicate.qLevel,
        hypotheses: [duplicate.hypotheses[0]!, duplicate.hypotheses[0]!],
      }),
    ).toThrow(/duplicate registered questionId/);

    expect(() => recordHypothesisFamilyRegistration(ledger, registration(), 3_999)).toThrow(
      /knownAt cannot predate registeredAt/,
    );
    expect(ledger.head.seq).toBe(0);
    ledger.close();
  });

  it('survives SQLite restart and does not permit registration drift after restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'keel-hypothesis-registration-'));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, 'keel.db');
    const sealed = registration();

    const firstProcess = new Ledger({ path: databasePath, synchronous: 'NORMAL' });
    const created = recordHypothesisFamilyRegistration(firstProcess, sealed, 4_100);
    const head = firstProcess.head;
    firstProcess.close();

    const restarted = new Ledger({ path: databasePath, synchronous: 'NORMAL' });
    expect(restarted.verifyChain().ok).toBe(true);
    expect(restarted.head).toEqual(head);
    const retry = recordHypothesisFamilyRegistration(restarted, sealed, 5_000);
    expect(retry.created).toBe(false);
    expect(restarted.head).toEqual(head);
    expect(readHypothesisFamilyRegistration(restarted, sealed.familyId)).toEqual(
      created.registration,
    );

    const drifted = sealHypothesisFamilyRegistration({
      version: sealed.version,
      familyId: sealed.familyId,
      registeredAt: sealed.registeredAt,
      method: sealed.method,
      qLevel: 0.1,
      hypotheses: sealed.hypotheses,
    });
    expect(() => recordHypothesisFamilyRegistration(restarted, drifted, 5_001)).toThrow(
      /conflicting registration/,
    );
    restarted.close();
  });

  it('remains projector-replay-safe while the authoritative read stays ledger-derived', () => {
    const ledger = memoryLedger();
    const projector = new Projector(ledger);
    const sealed = registration();
    recordHypothesisFamilyRegistration(ledger, sealed, 4_100);

    expect(projector.catchUp()).toBe(1);
    expect(projector.verifyAgainstRebuild()).toEqual({ ok: true });
    expect(readHypothesisFamilyRegistration(ledger, sealed.familyId)).toBeDefined();
    expect(listHypothesisFamilyRegistrations(ledger)).toHaveLength(1);
    ledger.close();
  });

  it('detects raw-ledger duplicate registration facts even if the canonical writer is bypassed', () => {
    const ledger = memoryLedger();
    const sealed = registration();
    const event = { kind: 'evaluation.hypothesisFamilyRegistered', registration: sealed } as const;
    ledger.append(event, 4_100);
    ledger.append(event, 4_101);

    expect(() => readHypothesisFamilyRegistration(ledger, sealed.familyId)).toThrow(
      /2 durable registrations/,
    );
    expect(() => recordHypothesisFamilyRegistration(ledger, sealed, 4_102)).toThrow(
      /already registered more than once/,
    );
    expect(listHypothesisFamilyRegistrations(ledger)).toHaveLength(2);
    expect(ledger.verifyChain().ok).toBe(true);
    ledger.close();
  });
});
