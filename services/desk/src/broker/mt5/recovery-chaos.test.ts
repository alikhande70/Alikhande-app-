import { describe, expect, it, vi } from 'vitest';
import { decodeAgentMessage } from './agent-protocol.js';
import { Mt5AgentSession } from './agent-session.js';
import {
  classifyMt5CommandRecovery,
  type Mt5CommandLifecycleRecord,
  mayRetryBeforeSend,
} from './command-lifecycle.js';

const TOKEN = '0123456789abcdef';

function hello() {
  return decodeAgentMessage(
    JSON.stringify({
      type: 'hello',
      protocolVersion: 1,
      token: TOKEN,
      agentId: 'agent-recovery',
      terminalBuild: 5000,
      accountLogin: '123456',
      server: 'LiteFinance-Demo',
      tradeMode: 'demo',
      positionModel: 'hedging',
      at: Date.now(),
    }),
  );
}

function heartbeat(eventSeq = '1') {
  const at = Date.now();
  return decodeAgentMessage(
    JSON.stringify({
      type: 'heartbeat',
      eventSeq,
      terminalConnected: true,
      tradeAllowed: true,
      serverTime: at,
      at,
    }),
  );
}

function reconcilePayload() {
  return {
    magic: '700000000001',
    symbol: 'XAUUSD',
    side: 'buy' as const,
    volume: '0.10',
    sentNotBefore: 1_000,
    sentNotAfter: 2_000,
  };
}

function resultMessage(requestId: string, reason: string) {
  return decodeAgentMessage(
    JSON.stringify({
      type: 'result',
      requestId,
      result: { outcome: 'ambiguous', reason, serverTime: Date.now() },
    }),
  );
}

function snapshotMessage(requestId: string, eventSeq: string, observedAt: number) {
  return decodeAgentMessage(
    JSON.stringify({
      type: 'snapshot',
      requestId,
      eventSeq,
      snapshot: {
        protocolVersion: 1,
        hostId: 'agent-recovery',
        terminalConnected: true,
        tradeAllowed: true,
        account: {
          login: '123456',
          server: 'LiteFinance-Demo',
          company: 'LiteFinance',
          currency: 'USD',
          tradeMode: 'demo',
          positionModel: 'hedging',
          balance: '10000.00',
          equity: '10000.00',
          marginUsed: '0.00',
          marginFree: '10000.00',
          asOf: observedAt,
        },
        instruments: [],
        positions: [],
        orders: [],
        quotes: [],
        observedAt,
      },
    }),
  );
}

function lifecycle(
  stage: Mt5CommandLifecycleRecord['stage'],
  at: number,
  extras: Partial<Mt5CommandLifecycleRecord> = {},
): Mt5CommandLifecycleRecord {
  return {
    requestId: 'req-crash-recovery',
    command: 'place_order',
    stage,
    at,
    ...extras,
  };
}

describe('MT5 targeted recovery chaos', () => {
  it('requires reconciliation after SENT even when a durable RESULT says ambiguous', () => {
    const records = [
      lifecycle('RECEIVED', 10),
      lifecycle('CHECKED', 20),
      lifecycle('SENT', 30),
      lifecycle('RESULT', 40, {
        outcome: 'ambiguous',
        reason: 'socket closed after broker call',
      }),
    ];

    expect(classifyMt5CommandRecovery(records)).toEqual({
      kind: 'must_reconcile',
      lastStage: 'SENT',
    });
    expect(mayRetryBeforeSend(records)).toBe(false);
  });

  it('does not let a late pre-crash reconcile response satisfy the new host request', async () => {
    let oldWrite = '';
    const oldSession = new Mt5AgentSession(
      {
        write: (data) => {
          oldWrite = data;
        },
        close: vi.fn(),
      },
      { token: TOKEN, commandTimeoutMs: 500 },
    );
    oldSession.receive(hello());
    oldSession.receive(heartbeat());

    const oldPending = oldSession.command('reconcile', reconcilePayload());
    const oldRequestId = (JSON.parse(oldWrite) as { requestId: string }).requestId;
    oldSession.disconnect('host crashed during reconcile');
    await expect(oldPending).rejects.toThrow('host crashed during reconcile');

    let newWrite = '';
    const newSession = new Mt5AgentSession(
      {
        write: (data) => {
          newWrite = data;
        },
        close: vi.fn(),
      },
      { token: TOKEN, commandTimeoutMs: 500 },
    );
    newSession.receive(hello());
    newSession.receive(heartbeat());

    const newPending = newSession.command('reconcile', reconcilePayload());
    const newRequestId = (JSON.parse(newWrite) as { requestId: string }).requestId;
    expect(newRequestId).not.toBe(oldRequestId);

    newSession.receive(resultMessage(oldRequestId, 'late response from dead host request'));
    newSession.receive(resultMessage(newRequestId, 'current reconcile result'));

    await expect(newPending).resolves.toMatchObject({
      outcome: 'ambiguous',
      reason: 'current reconcile result',
    });
  });

  it('keeps duplicate concurrent reconcile requests isolated by request id', async () => {
    const writes: string[] = [];
    const session = new Mt5AgentSession(
      {
        write: (data) => writes.push(data),
        close: vi.fn(),
      },
      { token: TOKEN, commandTimeoutMs: 500 },
    );
    session.receive(hello());
    session.receive(heartbeat());

    const first = session.command('reconcile', reconcilePayload());
    const second = session.command('reconcile', reconcilePayload());
    const firstId = (JSON.parse(writes[0] ?? '{}') as { requestId: string }).requestId;
    const secondId = (JSON.parse(writes[1] ?? '{}') as { requestId: string }).requestId;
    expect(firstId).not.toBe(secondId);

    session.receive(resultMessage(secondId, 'second'));
    session.receive(resultMessage(firstId, 'first'));

    await expect(first).resolves.toMatchObject({ reason: 'first' });
    await expect(second).resolves.toMatchObject({ reason: 'second' });
  });

  it('ignores an out-of-order matching snapshot and waits for newer broker truth', async () => {
    let written = '';
    const session = new Mt5AgentSession(
      {
        write: (data) => {
          written = data;
        },
        close: vi.fn(),
      },
      { token: TOKEN, commandTimeoutMs: 500 },
    );
    session.receive(hello());
    session.receive(heartbeat('10'));

    const pending = session.snapshot();
    const requestId = (JSON.parse(written) as { requestId: string }).requestId;

    session.receive(snapshotMessage(requestId, '9', 9_000));
    session.receive(snapshotMessage(requestId, '11', 11_000));

    await expect(pending).resolves.toMatchObject({ observedAt: 11_000 });
    expect(session.watermark()).toBe('11');
  });
});
