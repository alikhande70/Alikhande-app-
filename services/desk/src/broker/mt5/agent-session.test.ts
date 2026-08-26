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
        instrumentFacts: [],
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

describe('MT5 agent liveness and clock domain', () => {
  const TOKEN = '0123456789abcdef';

  function authenticated() {
    const session = new Mt5AgentSession({ write: vi.fn(), close: vi.fn() }, { token: TOKEN });
    session.receive(
      decodeAgentMessage(
        JSON.stringify({
          type: 'hello',
          protocolVersion: 1,
          token: TOKEN,
          agentId: 'a',
          terminalBuild: 4000,
          accountLogin: '123',
          server: 'LiteFinance-Demo',
          tradeMode: 'demo',
          positionModel: 'netting',
          at: Date.now(),
        }),
      ),
    );
    return session;
  }

  it('is live on a fresh UTC heartbeat', () => {
    const session = authenticated();
    session.receive(heartbeat('1', Date.now()));
    expect(session.isLive()).toBe(true);
    expect(session.clockFaultReason()).toBeUndefined();
  });

  it('refuses to be live when the agent sends broker-local time', () => {
    const session = authenticated();
    session.receive(heartbeat('1', Date.now() + 3 * 3_600_000));
    expect(session.isLive()).toBe(false);
    expect(session.clockFaultReason()).toContain('broker-local time');
  });

  it('does not report a dead agent as live for the length of the timezone offset', () => {
    // The old check was `now - at <= staleMs`, so a heartbeat stamped 3h ahead
    // gave a negative age that passed trivially: a dead agent read as live for
    // three hours, silently defeating the agent-absence detection ADR-0016
    // requires.
    const session = authenticated();
    session.receive(heartbeat('1', Date.now() + 3 * 3_600_000));
    expect(session.isLive(Date.now() + 3_600_000)).toBe(false);
  });

  it('goes not-live once a good heartbeat becomes stale', () => {
    const now = Date.now();
    const session = authenticated();
    session.receive(heartbeat('1', now));
    expect(session.isLive(now)).toBe(true);
    expect(session.isLive(now + 60_000)).toBe(false);
  });

  it('recovers when the agent starts sending UTC again', () => {
    const session = authenticated();
    session.receive(heartbeat('1', Date.now() + 3 * 3_600_000));
    expect(session.isLive()).toBe(false);
    session.receive(heartbeat('2', Date.now()));
    expect(session.isLive()).toBe(true);
  });

  it('refuses commands while the clock cannot be trusted', async () => {
    const session = authenticated();
    session.receive(heartbeat('1', Date.now() + 3 * 3_600_000));
    await expect(session.command('snapshot', {})).rejects.toThrow();
  });
});

describe('agent epoch and spool replay', () => {
  const TOKEN = '0123456789abcdef';

  function hello(epoch?: string, at = Date.now()) {
    return decodeAgentMessage(
      JSON.stringify({
        type: 'hello',
        protocolVersion: 1,
        token: TOKEN,
        agentId: 'a',
        terminalBuild: 4000,
        accountLogin: '123',
        server: 'LiteFinance-Demo',
        tradeMode: 'demo',
        positionModel: 'netting',
        ...(epoch === undefined ? {} : { agentEpoch: epoch }),
        at,
      }),
    );
  }

  function freshSession() {
    return new Mt5AgentSession({ write: vi.fn(), close: vi.fn() }, { token: TOKEN });
  }

  it('accepts a restarted agent whose sequence begins again', () => {
    // Note on scope: the desk builds a new session per socket, so a reconnect
    // already starts from a clean watermark. The epoch is not what rescues that
    // case -- it makes the restart *explicit* rather than implicit, so a stale
    // agent reconnecting can be ordered against the current one instead of
    // being indistinguishable from a fresh start.
    const session = freshSession();
    session.receive(hello('1'));
    session.receive(heartbeat('500', Date.now()));
    expect(session.isLive()).toBe(true);

    const restarted = freshSession();
    restarted.receive(hello('2'));
    restarted.receive(heartbeat('1', Date.now()));
    expect(restarted.isLive()).toBe(true);
    expect(restarted.epoch()).toBe('2');
  });

  it('resets the watermark only on a new epoch, not within one', () => {
    const session = freshSession();
    session.receive(hello('7'));
    session.receive(heartbeat('10', Date.now()));
    // A replayed lower sequence inside the same epoch is still ignored.
    session.receive(heartbeat('4', Date.now() + 1));
    expect(session.watermark()).toBe('10');
  });

  it('drops replayed duplicates so a spool replay is harmless', () => {
    // The agent re-sends anything it is unsure the desk received. Everything
    // already seen must be ignored rather than double-counted.
    const seen: string[] = [];
    const session = new Mt5AgentSession(
      { write: vi.fn(), close: vi.fn() },
      { token: TOKEN, onTransaction: (m) => seen.push(m.eventSeq) },
    );
    session.receive(hello('1'));
    const tx = (seq: string) =>
      decodeAgentMessage(
        JSON.stringify({
          type: 'transaction',
          eventSeq: seq,
          validTime: Date.now(),
          transactionType: 'TRADE_TRANSACTION_DEAL_ADD',
          orderTicket: '1',
          dealTicket: '2',
          positionId: '3',
          symbol: 'XAUUSD',
          magic: '77',
          volume: '0.10',
          price: '2500.00',
        }),
      );
    session.receive(tx('1'));
    session.receive(tx('2'));
    session.receive(tx('1')); // replay
    session.receive(tx('2')); // replay
    session.receive(tx('3'));
    expect(seen).toEqual(['1', '2', '3']);
  });

  it('refuses an epoch that goes backwards', () => {
    // A stale agent reconnecting, or a lost epoch store. Its sequence numbers
    // cannot be ordered against ours, so ambiguity is refused rather than
    // accepted.
    const session = freshSession();
    session.receive(hello('5'));
    const stale = freshSession();
    stale.receive(hello('5'));
    expect(() => {
      stale.receive(hello('4'));
    }).toThrow();
  });

  it('treats an agent with no epoch as epoch zero rather than resetting', () => {
    // Backwards compatibility: an older agent still connects, and its watermark
    // behaves exactly as before rather than silently resetting on every hello.
    const session = freshSession();
    session.receive(hello(undefined));
    expect(session.epoch()).toBe('0');
  });
});
