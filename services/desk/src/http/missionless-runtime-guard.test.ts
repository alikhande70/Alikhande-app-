import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerMissionRoutes } from './mission-routes.js';

describe('ADR-0018 mission-less guard without MissionRuntime', () => {
  it('keeps POST /orders retired even when MissionRuntime is absent', async () => {
    const app = Fastify({ logger: false });
    let legacyReached = false;

    registerMissionRoutes(
      app,
      {
        clock: { now: () => 1_800_000_000_000 },
        log: { info: vi.fn() },
        ledger: {} as never,
        supervisor: {} as never,
      },
      () => {
        throw new Error('legacy parser must remain unreachable');
      },
      () => ({}),
    );

    app.post('/orders', async () => {
      legacyReached = true;
      return { accepted: true };
    });

    const response = await app.inject({
      method: 'POST',
      url: '/orders',
      payload: {
        intentId: '00000000-0000-4000-8000-000000000001',
        canonical: 'XAUUSD',
      },
    });

    expect(response.statusCode).toBe(410);
    expect(response.json()).toMatchObject({
      code: 'MISSION_REQUIRED',
      retryable: false,
      outcomeUnknown: false,
    });
    expect(legacyReached).toBe(false);

    await app.close();
  });
});
