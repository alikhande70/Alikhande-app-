import { describe, expect, it, vi } from 'vitest';
import {
  buildMt5ExecutionHost,
  type Mt5ExecutionAgent,
  Mt5ExecutionHostError,
} from './execution-host.js';
import type { Mt5HostSnapshot, Mt5HostSubmitResult } from './host-types.js';

const TOKEN = 'host-token-0123456789';

function snapshot(): Mt5HostSnapshot {
  return {
    protocolVersion: 1,
    hostId: 'agent-test',
    terminalConnected: true,
    tradeAllowed: true,
    account: {
      login: '123',
      server: 'LiteFinance-Demo',
      company: 'LiteFinance',
      currency: 'USD',
      tradeMode: 'demo',
      positionModel: 'hedging',
      balance: '10000.00',
      equity: '10000.00',
      marginUsed: '0.00',
      marginFree: '10000.00',
      asOf: 1_700_000_000_000,
    },
    instrumentFacts: [],
    positions: [],
    orders: [],
    quotes: [],
    observedAt: 1_700_000_000_000,
  };
}

function agent(overrides: Partial<Mt5ExecutionAgent> = {}): Mt5ExecutionAgent {
  return {
    isLive: () => true,
    epoch: () => '7',
    snapshot: async () => snapshot(),
    command: async () => ({
      outcome: 'rejected',
      reason: 'not enabled in test',
      serverTime: 1_700_000_000_000,
    }),
    ...overrides,
  };
}

describe('MT5 execution host', () => {
  it('requires bearer auth on every v1 route', async () => {
    const app = await buildMt5ExecutionHost({ token: TOKEN, session: () => agent() });
    const response = await app.inject({ method: 'GET', url: '/v1/snapshot' });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
    await app.close();
  });

  it('reports a missing execution path as unavailable rather than a venue rejection', async () => {
    const app = await buildMt5ExecutionHost({ token: TOKEN, session: () => undefined });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/margin',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {
        symbol: 'XAUUSD',
        side: 'buy',
        kind: 'market',
        volume: '0.10',
        price: '2500.00',
      },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'NO_EXECUTION_PATH' });
    await app.close();
  });

  it('forwards the exact margin proposal to the authenticated live agent', async () => {
    const command = vi.fn<Mt5ExecutionAgent['command']>().mockResolvedValue({
      status: 'available',
      requiredAccountCurrency: '125.00',
      source: 'OrderCalcMargin',
      asOfUtcMs: 1_700_000_000_000,
      requestFingerprint: {
        symbol: 'XAUUSD',
        side: 'buy',
        volume: '0.10',
        price: '2500.00',
      },
    } as unknown as Mt5HostSubmitResult);
    const app = await buildMt5ExecutionHost({
      token: TOKEN,
      session: () => agent({ command }),
    });

    const proposal = {
      symbol: 'XAUUSD',
      side: 'buy',
      kind: 'market',
      volume: '0.10',
      price: '2500.00',
    } as const;
    const response = await app.inject({
      method: 'POST',
      url: '/v1/margin',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: proposal,
    });

    expect(response.statusCode).toBe(200);
    expect(command).toHaveBeenCalledWith('calc_margin', proposal);
    expect(response.json()).toMatchObject({
      status: 'available',
      requiredAccountCurrency: '125.00',
    });
    await app.close();
  });

  it('rejects weak host tokens at construction time', async () => {
    await expect(buildMt5ExecutionHost({ token: 'short', session: () => agent() })).rejects.toThrow(
      Mt5ExecutionHostError,
    );
  });
});
