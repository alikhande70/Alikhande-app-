import { describe, expect, it, vi } from 'vitest';
import type { DeskClient } from '../api/client.js';
import { previewTicket, submitMissionTicket } from './ticket-transport.js';

function client(over: Partial<Pick<DeskClient, 'command' | 'preview'>> = {}): DeskClient {
  return {
    command: vi.fn(),
    preview: vi.fn(),
    ...over,
  } as unknown as DeskClient;
}

const input = {
  intentId: '018f1f4e-7b2a-7000-8000-000000000001',
  canonical: 'XAUUSD',
  side: 'buy' as const,
  stopPrice: '2395.00',
  targetPrice: '2410.00',
  note: 'Breakout held above the prior range.',
};

describe('Mission-bound ticket transport', () => {
  it('never calls the legacy /orders route', async () => {
    const command = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      data: {
        missionId: 'mission-1',
        intentId: input.intentId,
        accepted: true,
        deduplicated: false,
      },
    });
    const desk = client({ command: command as DeskClient['command'] });

    const out = await submitMissionTicket(desk, 'mission-1', input);

    expect(out.kind).toBe('sent');
    expect(command).toHaveBeenCalledTimes(1);
    expect(command.mock.calls[0]?.[0]).toBe('/missions/mission-1/orders');
    expect(command.mock.calls[0]?.[1]).toMatchObject({
      intentId: input.intentId,
      origin: 'operator:android',
      canonical: 'XAUUSD',
      stopPrice: '2395.00',
    });
  });

  it('fails closed without a Mission id', async () => {
    const command = vi.fn();
    const desk = client({ command: command as DeskClient['command'] });

    const out = await submitMissionTicket(desk, '  ', input);

    expect(out.kind).toBe('blocked');
    expect(out.title).toMatch(/Mission/);
    expect(command).not.toHaveBeenCalled();
  });

  it('renders command timeouts as unknown, never failed', async () => {
    const command = vi.fn().mockResolvedValue({
      ok: false,
      status: 0,
      code: 'TIMEOUT',
      title: 'Outcome unknown',
      detail: 'The desk may have accepted it. Do not resend.',
      retryable: false,
      outcomeUnknown: true,
    });
    const desk = client({ command: command as DeskClient['command'] });

    const out = await submitMissionTicket(desk, 'mission-1', input);

    expect(out).toEqual({
      kind: 'unknown',
      title: 'Outcome unknown',
      detail: 'The desk may have accepted it. Do not resend.',
    });
  });

  it('does not call a 2xx response sent when the Desk says broker outcome is unknown', async () => {
    const command = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      data: {
        missionId: 'mission-1',
        intentId: input.intentId,
        accepted: true,
        deduplicated: false,
        problem: {
          code: 'OUTCOME_UNKNOWN',
          title: 'Outcome unknown',
          detail: 'Reconciliation is in progress.',
          retryable: false,
          outcomeUnknown: true,
        },
      },
    });
    const desk = client({ command: command as DeskClient['command'] });

    const out = await submitMissionTicket(desk, 'mission-1', input);

    expect(out.kind).toBe('unknown');
    expect(out.detail).toMatch(/Reconciliation/);
  });

  it('uses the same order shape for side-effect-free preview', async () => {
    const preview = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      data: { risk: { verdict: 'pass', checks: [] } },
    });
    const desk = client({ preview: preview as DeskClient['preview'] });

    await previewTicket(desk, {
      canonical: input.canonical,
      side: input.side,
      stopPrice: input.stopPrice,
      targetPrice: input.targetPrice,
      note: input.note,
    });

    expect(preview).toHaveBeenCalledWith({
      canonical: 'XAUUSD',
      side: 'buy',
      kind: 'market',
      timeInForce: 'GTC',
      stopPrice: '2395.00',
      takeProfitPrice: '2410.00',
      acknowledgeManualSize: false,
      preTradeNote: input.note,
      tags: [],
    });
  });
});
