import { describe, expect, it, vi } from 'vitest';
import {
  decodeAgentMessage,
  Mt5AgentLineDecoder,
  Mt5AgentProtocolError,
} from './agent-protocol.js';
import { Mt5AgentDisconnectedError, Mt5AgentSession } from './agent-session.js';
import { Mt5CommandValidationError } from './command-validation.js';

function hello(token = '0123456789abcdef') {
  return decodeAgentMessage(
    JSON.stringify({
      type: 'hello',
      protocolVersion: 1,
      token,
      agentId: 'agent-1',
      terminalBuild: 5000,
      accountLogin: '123456',
      server: 'LiteFinance-Demo',
      tradeMode: 'demo',
      positionModel: 'hedging',
      at: 1_000,
    }),
  );
}

function heartbeat(eventSeq = '1', at = Date.now()) {
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

function snapshotMessage(requestId: string, eventSeq: string, observedAt: number) {
  return decodeAgentMessage(
    JSON.stringify({
      type: 'snapshot',
      requestId,
      eventSeq,
      snapshot: {
        protocolVersion: 1,
        hostId: 'agent-1',
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

function validMarketOrder() {
  return {
    clientOrderId: 'intent-123',
    magic: '700000000001',
    symbol: 'XAUUSD',
    side: 'buy' as const,
    kind: 'market' as const,
    volume: '0.10',
    stopLoss: '2310.50',
    takeProfit: '2350.50',
    timeInForce: 'GTC',
    maxSlippage: '0.50',
  };
}

describe('MT5 agent protocol', () => {
  it('decodes fragmented UTF-8 newline messages without losing boundaries', () => {
    const decoder = new Mt5AgentLineDecoder();
    const first = Buffer.from('{"type":"heartbeat","eventSeq":"1",');
    const second = Buffer.from(
      '"terminalConnected":true,"tradeAllowed":true,"serverTime":1,"at":1}\n',
    );
    expect(decoder.feed(first)).toEqual([]);
    const lines = decoder.feed(second);
    expect(lines).toHaveLength(1);
    expect(decodeAgentMessage(lines[0] ?? '').type).toBe('heartbeat');
  });

  it('rejects protocol drift and non-decimal event sequences', () => {
    expect(() =>
      decodeAgentMessage(
        JSON.stringify({
          type: 'hello',
          protocolVersion: 2,
          token: '0123456789abcdef',
          agentId: 'a',
          terminalBuild: 1,
          accountLogin: '1',
          server: 's',
          tradeMode: 'demo',
          positionModel: 'netting',
          at: 1,
        }),
      ),
    ).toThrow(Mt5AgentProtocolError);
    expect(() =>
      decodeAgentMessage(
        JSON.stringify({
          type: 'heartbeat',
          eventSeq: 'NaN',
          terminalConnected: true,
          tradeAllowed: true,
          serverTime: 1,
          at: 1,
        }),
      ),
    ).toThrow(Mt5AgentProtocolError);
  });

  it('requires a request id on authoritative snapshot responses', () => {
    expect(() =>
      decodeAgentMessage(
        JSON.stringify({
          type: 'snapshot',
          eventSeq: '2',
          snapshot: {},
        }),
      ),
    ).toThrow(Mt5AgentProtocolError);
  });
});

describe('MT5 agent session', () => {
  it('requires authenticated hello before accepting any state', () => {
    const close = vi.fn();
    const session = new Mt5AgentSession({ write: vi.fn(), close }, { token: '0123456789abcdef' });
    expect(() => session.receive(heartbeat())).toThrow(Mt5AgentProtocolError);
    expect(close).toHaveBeenCalledOnce();
  });

  it('rejects a wrong token and never becomes authenticated', () => {
    const close = vi.fn();
    const session = new Mt5AgentSession({ write: vi.fn(), close }, { token: '0123456789abcdef' });
    expect(() => session.receive(hello('fedcba9876543210'))).toThrow(Mt5AgentProtocolError);
    expect(session.isAuthenticated()).toBe(false);
    expect(close).toHaveBeenCalledOnce();
  });

  it('ignores replayed transaction sequence numbers', () => {
    const onTransaction = vi.fn();
    const session = new Mt5AgentSession(
      { write: vi.fn(), close: vi.fn() },
      { token: '0123456789abcdef', onTransaction },
    );
    session.receive(hello());
    session.receive(heartbeat('10'));
    const transaction = decodeAgentMessage(
      JSON.stringify({
        type: 'transaction',
        eventSeq: '11',
        validTime: 100,
        transactionType: 'TRADE_TRANSACTION_DEAL_ADD',
        dealTicket: '9223372036854775000',
      }),
    );
    session.receive(transaction);
    session.receive(transaction);
    expect(onTransaction).toHaveBeenCalledOnce();
    expect(session.watermark()).toBe('11');
  });

  it('fails closed when the heartbeat is stale', async () => {
    const session = new Mt5AgentSession(
      { write: vi.fn(), close: vi.fn() },
      { token: '0123456789abcdef', heartbeatStaleMs: 10 },
    );
    session.receive(hello());
    session.receive(heartbeat('1', Date.now() - 100));
    await expect(session.command('place_order', {})).rejects.toBeInstanceOf(
      Mt5AgentDisconnectedError,
    );
  });

  it('resolves a snapshot only from the matching request id', async () => {
    let written = '';
    const onSnapshot = vi.fn();
    const session = new Mt5AgentSession(
      {
        write: (data) => {
          written = data;
        },
        close: vi.fn(),
      },
      { token: '0123456789abcdef', commandTimeoutMs: 100, onSnapshot },
    );
    session.receive(hello());
    session.receive(heartbeat());

    const pending = session.snapshot();
    const requestId = (JSON.parse(written) as { requestId: string }).requestId;
    session.receive(snapshotMessage('different', '2', 2_000));
    session.receive(snapshotMessage(requestId, '3', 3_000));

    await expect(pending).resolves.toMatchObject({ observedAt: 3_000 });
    expect(onSnapshot).toHaveBeenCalledTimes(2);
  });

  it('rejects a snapshot request when the EA reports that truth is unavailable', async () => {
    let written = '';
    const session = new Mt5AgentSession(
      {
        write: (data) => {
          written = data;
        },
        close: vi.fn(),
      },
      { token: '0123456789abcdef', commandTimeoutMs: 100 },
    );
    session.receive(hello());
    session.receive(heartbeat());

    const pending = session.snapshot();
    const requestId = (JSON.parse(written) as { requestId: string }).requestId;
    session.receive(
      decodeAgentMessage(
        JSON.stringify({
          type: 'result',
          requestId,
          result: { outcome: 'ambiguous', reason: 'state scan failed', serverTime: 2 },
        }),
      ),
    );
    await expect(pending).rejects.toThrow('did not return authoritative snapshot');
  });

  it('resolves a normal command only from the matching request id', async () => {
    let written = '';
    const session = new Mt5AgentSession(
      {
        write: (data) => {
          written = data;
        },
        close: vi.fn(),
      },
      { token: '0123456789abcdef', commandTimeoutMs: 100 },
    );
    session.receive(hello());
    session.receive(heartbeat());

    const pending = session.command('place_order', validMarketOrder());
    const requestId = (JSON.parse(written) as { requestId: string }).requestId;
    session.receive(
      decodeAgentMessage(
        JSON.stringify({
          type: 'result',
          requestId: 'different',
          result: { outcome: 'ambiguous', reason: 'ignore', serverTime: 1 },
        }),
      ),
    );
    session.receive(
      decodeAgentMessage(
        JSON.stringify({
          type: 'result',
          requestId,
          result: { outcome: 'ambiguous', reason: 'execution disabled', serverTime: 2 },
        }),
      ),
    );
    await expect(pending).resolves.toMatchObject({ outcome: 'ambiguous', serverTime: 2 });
  });

  it('rejects malformed commands before transport write', async () => {
    const write = vi.fn();
    const session = new Mt5AgentSession(
      { write, close: vi.fn() },
      { token: '0123456789abcdef', commandTimeoutMs: 100 },
    );
    session.receive(hello());
    session.receive(heartbeat());

    await expect(session.command('place_order', { symbol: 'XAUUSD' })).rejects.toBeInstanceOf(
      Mt5CommandValidationError,
    );
    expect(write).not.toHaveBeenCalled();
  });

  it('rejects outstanding commands and snapshots on disconnect', async () => {
    const writes: string[] = [];
    const session = new Mt5AgentSession(
      { write: (data) => writes.push(data), close: vi.fn() },
      { token: '0123456789abcdef', commandTimeoutMs: 500 },
    );
    session.receive(hello());
    session.receive(heartbeat());
    const commandPending = session.command('place_order', validMarketOrder());
    const snapshotPending = session.snapshot();
    expect(writes).toHaveLength(2);
    session.disconnect('socket dropped after send');
    await expect(commandPending).rejects.toThrow('socket dropped after send');
    await expect(snapshotPending).rejects.toThrow('socket dropped after send');
  });
});
