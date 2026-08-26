import { describe, expect, it, vi } from 'vitest';
import {
  decodeAgentMessage,
  Mt5AgentLineDecoder,
  Mt5AgentProtocolError,
} from './agent-protocol.js';
import { Mt5AgentDisconnectedError, Mt5AgentSession } from './agent-session.js';

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

  it('resolves a command only from the matching request id', async () => {
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

    const pending = session.command('snapshot', {});
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
          result: { outcome: 'ambiguous', reason: 'snapshot not implemented', serverTime: 2 },
        }),
      ),
    );
    await expect(pending).resolves.toMatchObject({ outcome: 'ambiguous', serverTime: 2 });
  });

  it('rejects outstanding commands on disconnect instead of pretending they failed at venue', async () => {
    const session = new Mt5AgentSession(
      { write: vi.fn(), close: vi.fn() },
      { token: '0123456789abcdef', commandTimeoutMs: 500 },
    );
    session.receive(hello());
    session.receive(heartbeat());
    const pending = session.command('place_order', { symbol: 'XAUUSD' });
    session.disconnect('socket dropped after send');
    await expect(pending).rejects.toThrow('socket dropped after send');
  });
});
