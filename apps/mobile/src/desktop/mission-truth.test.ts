import { describe, expect, it, vi } from 'vitest';
import { DesktopDeskClient } from '../../../desktop/src/client.js';
import { DesktopMissionOperator } from '../../../desktop/src/mission-operator.js';
import { DesktopMissionTruth } from '../../../desktop/src/mission-truth.js';

const mission = {
  missionId: 'mission-1',
  canonical: 'XAUUSD',
  stage: 'ARMED',
  lastEventAt: 1_800_000_000_000,
};

const order = {
  missionId: 'mission-1',
  intentId: 'intent-1',
  canonical: 'XAUUSD',
  side: 'buy' as const,
  stopPrice: '2440.00',
  note: 'Breakout confirmation',
};

function makeClient(fetchFn = vi.fn<typeof fetch>()) {
  return new DesktopDeskClient({
    baseUrl: 'http://127.0.0.1:8787',
    deviceId: 'windows-1',
    signer: { sign: vi.fn(async () => 'signature') },
    hashBody: async (body) => `hash:${body}`,
    randomId: () => 'request-nonce',
    now: () => 1_800_000_000_000,
    fetchFn,
  });
}

describe('Windows/Desktop Mission truth', () => {
  it('retains last-known rows but blocks orders after disconnect', async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const truth = new DesktopMissionTruth();
    expect(truth.replaceSnapshot(10, [mission])).toBe(true);
    truth.markDisconnected();

    const result = await new DesktopMissionOperator(makeClient(fetchFn), truth).submitMarketOrder(
      order,
    );

    expect(truth.list()).toEqual([mission]);
    expect(result).toMatchObject({ kind: 'blocked', title: 'Mission truth is not current' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('detects a sequence gap and refuses to apply the unproven delta', () => {
    const truth = new DesktopMissionTruth();
    truth.replaceSnapshot(4, [mission]);

    expect(
      truth.applyDelta(6, [
        { ...mission, stage: 'EXECUTING', lastEventAt: mission.lastEventAt + 1 },
      ]),
    ).toBe(false);
    expect(truth.status).toBe('incomplete');
    expect(truth.sequence).toBeUndefined();
    expect(truth.list()[0]?.stage).toBe('ARMED');
  });

  it('fails closed on malformed snapshots instead of treating them as empty truth', () => {
    const truth = new DesktopMissionTruth();
    truth.replaceSnapshot(1, [mission]);

    expect(truth.replaceSnapshot(2, [{ missionId: 'mission-2' }])).toBe(false);
    expect(truth.status).toBe('incomplete');
    expect(truth.list()).toEqual([mission]);
  });

  it('requires the exact current Mission and an orderable stage', () => {
    const truth = new DesktopMissionTruth();
    truth.replaceSnapshot(1, [mission]);

    expect(truth.canSubmit('mission-1', 'XAUUSD').ok).toBe(true);
    expect(truth.canSubmit('mission-1', 'EURUSD')).toMatchObject({ ok: false });
    expect(truth.canSubmit('missing', 'XAUUSD')).toMatchObject({ ok: false });

    truth.applyDelta(2, [{ ...mission, stage: 'MANAGING', lastEventAt: mission.lastEventAt + 1 }]);
    expect(truth.canSubmit('mission-1', 'XAUUSD')).toMatchObject({ ok: false });
  });

  it('allows network submission only after a fresh proven snapshot', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ nonce: 'command-nonce' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            missionId: 'mission-1',
            intentId: 'intent-1',
            accepted: true,
            deduplicated: false,
          }),
          { status: 200 },
        ),
      );
    const truth = new DesktopMissionTruth();
    truth.replaceSnapshot(20, [mission]);

    const result = await new DesktopMissionOperator(makeClient(fetchFn), truth).submitMarketOrder(
      order,
    );

    expect(result.kind).toBe('sent');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
