import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HoldoutAccessReceiptRecord } from './events.js';
import { streamOf } from './events.js';
import {
  HoldoutAccessInvariantError,
  listHoldoutAccessReceipts,
  readHoldoutAccessReceipt,
  recordHoldoutAccess,
} from './holdout-access.js';
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

function receipt(overrides: Partial<HoldoutAccessReceiptRecord> = {}): HoldoutAccessReceiptRecord {
  return {
    holdoutId: 'holdout-2026-q3',
    questionId: 'challenger-v7-vs-champion-v6',
    openedAt: 4_000,
    evaluationCutoff: 3_900,
    populationHash: `sha256:${'a'.repeat(64)}`,
    ...overrides,
  };
}

describe('durable locked-holdout access receipts', () => {
  it('records one durable receipt and makes an identical retry idempotent', () => {
    const ledger = memoryLedger();
    const first = recordHoldoutAccess(ledger, receipt(), 4_001);
    const second = recordHoldoutAccess(ledger, receipt(), 4_500);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.receipt).toEqual(first.receipt);
    expect(ledger.head.seq).toBe(1);
    expect(Ledger.isDurable('evaluation.holdoutOpened')).toBe(true);

    const stored = readHoldoutAccessReceipt(
      ledger,
      'holdout-2026-q3',
      'challenger-v7-vs-champion-v6',
    );
    expect(stored).toEqual(first.receipt);
    expect(stored?.knownAt).toBe(4_001);
    expect(listHoldoutAccessReceipts(ledger)).toEqual([first.receipt]);
    ledger.close();
  });

  it('uses a collision-safe aggregate stream for the holdout/question identity', () => {
    const a = receipt({ holdoutId: 'a:b', questionId: 'c' });
    const b = receipt({ holdoutId: 'a', questionId: 'b:c' });
    expect(streamOf({ kind: 'evaluation.holdoutOpened', receipt: a })).not.toBe(
      streamOf({ kind: 'evaluation.holdoutOpened', receipt: b }),
    );
  });

  it('rejects a different second receipt instead of treating it as another observation', () => {
    const ledger = memoryLedger();
    recordHoldoutAccess(ledger, receipt(), 4_001);

    expect(() =>
      recordHoldoutAccess(
        ledger,
        receipt({ populationHash: `sha256:${'b'.repeat(64)}` }),
        4_002,
      ),
    ).toThrow(HoldoutAccessInvariantError);
    expect(ledger.head.seq).toBe(1);
    ledger.close();
  });

  it('fails closed on malformed hashes and impossible bitemporal ordering', () => {
    const ledger = memoryLedger();
    expect(() => recordHoldoutAccess(ledger, receipt({ populationHash: 'abc' }), 4_001)).toThrow(
      /canonical sha256/,
    );
    expect(() => recordHoldoutAccess(ledger, receipt({ openedAt: 3_800 }), 4_001)).toThrow(
      /openedAt cannot predate evaluationCutoff/,
    );
    expect(() => recordHoldoutAccess(ledger, receipt(), 3_999)).toThrow(
      /knownAt cannot predate openedAt/,
    );
    expect(ledger.head.seq).toBe(0);
    ledger.close();
  });

  it('survives process restart without allowing the holdout question to be consumed again', () => {
    const directory = mkdtempSync(join(tmpdir(), 'keel-holdout-'));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, 'keel.db');

    const firstProcess = new Ledger({ path: databasePath, synchronous: 'NORMAL' });
    const created = recordHoldoutAccess(firstProcess, receipt(), 4_001);
    expect(created.created).toBe(true);
    const head = firstProcess.head;
    firstProcess.close();

    const restarted = new Ledger({ path: databasePath, synchronous: 'NORMAL' });
    expect(restarted.verifyChain().ok).toBe(true);
    expect(restarted.head).toEqual(head);
    const retry = recordHoldoutAccess(restarted, receipt(), 5_000);
    expect(retry.created).toBe(false);
    expect(restarted.head).toEqual(head);
    expect(readHoldoutAccessReceipt(restarted, receipt().holdoutId, receipt().questionId)).toEqual(
      created.receipt,
    );
    restarted.close();
  });

  it('remains replay-safe for the desk projector while the receipt read model stays ledger-derived', () => {
    const ledger = memoryLedger();
    const projector = new Projector(ledger);
    recordHoldoutAccess(ledger, receipt(), 4_001);

    expect(projector.catchUp()).toBe(1);
    expect(projector.verifyAgainstRebuild()).toEqual({ ok: true });
    expect(readHoldoutAccessReceipt(ledger, receipt().holdoutId, receipt().questionId)).toBeDefined();
    ledger.close();
  });

  it('detects raw-ledger duplicate peeks even if a caller bypasses the canonical writer', () => {
    const ledger = memoryLedger();
    const event = { kind: 'evaluation.holdoutOpened', receipt: receipt() } as const;
    ledger.append(event, 4_001);
    ledger.append(event, 4_002);

    expect(() =>
      readHoldoutAccessReceipt(ledger, receipt().holdoutId, receipt().questionId),
    ).toThrow(/2 access receipts/);
    expect(() => recordHoldoutAccess(ledger, receipt(), 4_003)).toThrow(/already opened more than once/);
    expect(listHoldoutAccessReceipts(ledger)).toHaveLength(2);
    expect(ledger.verifyChain().ok).toBe(true);
    ledger.close();
  });
});
