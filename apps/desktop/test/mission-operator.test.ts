import { describe, expect, it, vi } from 'vitest';
import type { DesktopDeskClient } from '../src/client.js';
import { DesktopMissionOperator } from '../src/mission-operator.js';

function client(commandResult: unknown): DesktopDeskClient {
  return {
    get: vi.fn(),
    command: vi.fn(async () => commandResult),
    preview: vi.fn(),
  } as unknown as DesktopDeskClient;
}

const order = {
  missionId: 'mission-1',
  intentId: 'intent-1',
  canonical: 'XAUUSD',
  side: 'buy' as const,
  stopPrice: '2440.00',
  takeProfitPrice: '2480.00',
  note: 'Breakout confirmation',
};

describe('DesktopMissionOperator', () => {
  it('blocks an order without a durable Mission id', async () => {
    const desk = client({ ok: true });
    const operator = new DesktopMissionOperator(desk);

    const result = await operator.submitMarketOrder({ ...order, missionId: ' ' });

    expect(result.kind).toBe('blocked');
    expect(desk.command).not.toHaveBeenCalled();
  });

  it('always submits through the Mission route with Windows provenance', async () => {
    const desk = client({
      ok: true,
      status: 200,
      data: {
        missionId: 'mission-1',
        intentId: 'intent-1',
        accepted: true,
        deduplicated: false,
      },
    });
    const operator = new DesktopMissionOperator(desk);

    const result = await operator.submitMarketOrder(order);

    expect(result.kind).toBe('sent');
    expect(desk.command).toHaveBeenCalledWith(
      '/missions/mission-1/orders',
      expect.objectContaining({
        intentId: 'intent-1',
        canonical: 'XAUUSD',
        origin: 'operator:windows',
      }),
      'Long XAUUSD',
    );
  });

  it('does not call a broker-unknown outcome success', async () => {
    const desk = client({
      ok: false,
      status: 0,
      code: 'TIMEOUT',
      title: 'Outcome unknown',
      detail: 'Do not resend.',
      retryable: false,
      outcomeUnknown: true,
    });
    const operator = new DesktopMissionOperator(desk);

    const result = await operator.submitMarketOrder(order);

    expect(result).toEqual({
      kind: 'unknown',
      title: 'Outcome unknown',
      detail: 'Do not resend.',
    });
  });
});
