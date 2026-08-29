import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
// The desk's own implementation, imported directly so drift is impossible to
// miss: if the two canonical strings ever diverge, this file fails in CI rather
// than the operator discovering it as "signature does not verify" mid-session.
import {
  Authenticator,
  canonicalString as deskCanonical,
  hashBody as deskHashBody,
} from '../../../../services/desk/src/http/auth.js';
import { TestClock } from '../../../../services/desk/src/sim/clock.js';
import type { ClientResult } from './client.js';
import { DeskClient } from './client.js';
import type { SecureSigner } from './signer.js';
import { biometricReason, canonicalString, isCommandPath } from './signing.js';

const T0 = Date.UTC(2026, 5, 15, 14, 0);

describe('the client and the desk sign the same bytes', () => {
  const cases = [
    { method: 'GET', path: '/state', timestamp: T0, nonce: 'n1', bodyHash: 'h1' },
    {
      method: 'POST',
      path: '/orders',
      timestamp: T0,
      nonce: 'n2',
      bodyHash: 'h2',
      commandNonce: 'c1',
    },
    { method: 'post', path: '/preview', timestamp: 0, nonce: '', bodyHash: '' },
    {
      method: 'POST',
      path: '/positions/PP-1/close',
      timestamp: 1,
      nonce: 'n\nwith-newline',
      bodyHash: 'h',
    },
  ];

  for (const c of cases) {
    it(`agrees on ${c.method} ${c.path}`, () => {
      expect(canonicalString(c)).toBe(deskCanonical(c));
    });
  }

  it('classifies the Mission command surface as command-nonce protected', () => {
    const commandPaths = [
      '/orders',
      '/orders/abc/cancel',
      '/scans',
      '/missions/mission-1/plan',
      '/missions/mission-1/abandon',
      '/missions/mission-1/review',
      '/missions/mission-1/orders',
      '/positions/PP-1/close',
      '/positions/PP-1/modify',
      '/panic',
      '/policy',
      '/guard/release',
    ];
    const readPaths = [
      '/state',
      '/missions',
      '/preview',
      '/journal',
      '/alerts',
      '/command-nonce',
      '/health',
    ];
    for (const p of commandPaths) expect(isCommandPath(p), p).toBe(true);
    for (const p of readPaths) expect(isCommandPath(p), p).toBe(false);
  });

  it('gives Mission mutations consequence-specific biometric prompts', () => {
    expect(biometricReason('/missions/mission-1/plan')).toMatch(/mission plan/i);
    expect(biometricReason('/missions/mission-1/abandon')).toMatch(/abandon/i);
    expect(biometricReason('/missions/mission-1/review')).toMatch(/mission review/i);
    expect(biometricReason('/missions/mission-1/orders')).toMatch(/mission order/i);
    expect(biometricReason('/scans')).toMatch(/scan/i);
  });

  it('produces a signature the desk actually accepts', async () => {
    // The real proof: sign on the client side, verify on the desk side.
    const clock = new TestClock(T0);
    const auth = new Authenticator(clock);
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    const enrolled = auth.enrol(auth.createEnrolmentCode('test'), spki);

    const parts = {
      method: 'GET',
      path: '/state',
      timestamp: T0,
      nonce: 'nonce-1',
      bodyHash: deskHashBody(''),
    };
    const signature = sign(null, Buffer.from(canonicalString(parts), 'utf8'), privateKey).toString(
      'base64',
    );

    expect(
      auth.verifyRequest({ deviceId: enrolled.deviceId, ...parts, signature }, false).deviceId,
    ).toBe(enrolled.deviceId);
  });
});

// ---------------------------------------------------------------------------

function stubSigner(): SecureSigner {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    identity: {
      publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
      keyKind: 'ed25519',
      hardwareBacked: false,
    },
    sign: async (canonical) =>
      sign(null, Buffer.from(canonical, 'utf8'), privateKey).toString('base64'),
    isProvisioned: async () => true,
    provision: async () => ({ publicKey: '', keyKind: 'ed25519', hardwareBacked: false }),
    destroy: async () => undefined,
  };
}

function makeClient(fetchFn: typeof fetch): DeskClient {
  return new DeskClient({
    baseUrl: 'https://desk.local',
    signer: stubSigner(),
    deviceId: 'device-1',
    hashBody: async (b) => createHash('sha256').update(b).digest('base64'),
    randomId: () => 'req-1',
    fetchFn,
    now: () => T0,
    timeoutMs: 50,
  });
}

/** A fetch that never answers, and rejects when aborted — as a real one does. */
function hangUntilAborted(init: { signal?: AbortSignal } | undefined): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      const err = new Error('The operation was aborted.');
      err.name = 'AbortError';
      reject(err);
    });
  });
}

describe('a timed-out command is unknown, never failed', () => {
  it('reports outcomeUnknown and tells the operator not to resend', async () => {
    const fetchFn = (async (url: string, init?: { signal?: AbortSignal }) => {
      if (String(url).endsWith('/command-nonce')) {
        return new Response(JSON.stringify({ nonce: 'cn-1' }), { status: 200 });
      }
      // Hangs until the client's AbortController fires, as a real fetch does.
      return hangUntilAborted(init);
    }) as unknown as typeof fetch;

    const res = (await makeClient(fetchFn).command('/orders', { a: 1 })) as ClientResult<unknown>;
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.outcomeUnknown).toBe(true);
    expect(res.retryable).toBe(false);
    expect(res.detail).toMatch(/do not resend/i);
    expect(res.title).toBe('Outcome unknown');
  });

  it('a timed-out read is retryable and NOT unknown', async () => {
    const fetchFn = (async (_url: string, init?: { signal?: AbortSignal }) =>
      hangUntilAborted(init)) as unknown as typeof fetch;
    const res = await makeClient(fetchFn).get('/state', 1);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.outcomeUnknown).toBe(false);
    expect(res.retryable).toBe(true);
  });

  it('a command that never left the phone is "did not happen", not "unknown"', async () => {
    // The nonce request failed, so nothing was ever sent to the desk. Saying
    // "unknown" here would leave the operator afraid to act when they are
    // provably flat.
    const fetchFn = (async () =>
      new Response(JSON.stringify({ code: 'DOWN' }), { status: 503 })) as unknown as typeof fetch;
    const res = await makeClient(fetchFn).command('/orders', {});
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('NO_COMMAND_NONCE');
    expect(res.outcomeUnknown).toBe(false);
  });
});

describe('commands are sent exactly once', () => {
  it('does not retry a command, however retryable the error looks', async () => {
    let orderPosts = 0;
    const fetchFn = (async (url: string) => {
      if (String(url).endsWith('/command-nonce')) {
        return new Response(JSON.stringify({ nonce: 'cn-1' }), { status: 200 });
      }
      orderPosts += 1;
      return new Response(JSON.stringify({ code: 'INTERNAL', retryable: true }), { status: 500 });
    }) as unknown as typeof fetch;

    await makeClient(fetchFn).command('/orders', {});
    expect(orderPosts).toBe(1);
  });

  it('does retry a read', async () => {
    let gets = 0;
    const fetchFn = (async () => {
      gets += 1;
      return new Response(JSON.stringify({ code: 'INTERNAL', retryable: true }), { status: 500 });
    }) as unknown as typeof fetch;

    await makeClient(fetchFn).get('/state', 3);
    expect(gets).toBe(3);
  });
});

describe('authorisation', () => {
  it('surfaces a refused biometric as not-authorised, and sends nothing', async () => {
    let posts = 0;
    const fetchFn = (async (url: string) => {
      if (String(url).endsWith('/command-nonce')) {
        return new Response(JSON.stringify({ nonce: 'cn-1' }), { status: 200 });
      }
      posts += 1;
      return new Response('{}', { status: 202 });
    }) as unknown as typeof fetch;

    const signer = stubSigner();
    const refusing: SecureSigner = {
      ...signer,
      // Only the command's own signature needs biometrics; the preceding
      // nonce fetch is an ordinary signed read and must still succeed, or the
      // failure would be reported as "could not reach the desk".
      sign: async (canonical, reason, requireBiometric) => {
        if (requireBiometric) throw new Error('biometric authentication was not passed');
        return signer.sign(canonical, reason, requireBiometric);
      },
    };
    const client = new DeskClient({
      baseUrl: 'https://desk.local',
      signer: refusing,
      deviceId: 'device-1',
      hashBody: async (b) => createHash('sha256').update(b).digest('base64'),
      randomId: () => 'req-1',
      fetchFn,
      now: () => T0,
    });

    const res = await client.command('/orders', {});
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('NOT_AUTHORISED');
    expect(res.outcomeUnknown).toBe(false);
    expect(posts).toBe(0);
  });

  it('requests a command nonce for commands and not for reads', async () => {
    const seen: string[] = [];
    const fetchFn = (async (url: string) => {
      seen.push(String(url));
      if (String(url).endsWith('/command-nonce')) {
        return new Response(JSON.stringify({ nonce: 'cn-1' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const client = makeClient(fetchFn);
    await client.get('/state');
    expect(seen.filter((u) => u.endsWith('/command-nonce'))).toHaveLength(0);

    await client.command('/panic', { confirmPhrase: 'FLATTEN' });
    expect(seen.filter((u) => u.endsWith('/command-nonce'))).toHaveLength(1);
  });

  it('requests command nonces for every Mission mutation', async () => {
    const seen: string[] = [];
    const fetchFn = (async (url: string) => {
      seen.push(String(url));
      if (String(url).endsWith('/command-nonce')) {
        return new Response(JSON.stringify({ nonce: `cn-${seen.length}` }), { status: 200 });
      }
      return new Response('{}', { status: 202 });
    }) as unknown as typeof fetch;

    const client = makeClient(fetchFn);
    await client.command('/missions/mission-1/plan', { snapshot: {} });
    await client.command('/missions/mission-1/abandon', { reason: 'invalidated' });
    await client.command('/missions/mission-1/review', { decision: {} });
    await client.command('/missions/mission-1/orders', { intentId: 'intent-1' });

    expect(seen.filter((u) => u.endsWith('/command-nonce'))).toHaveLength(4);
  });
});

describe('red team: a phone with a wrong clock', () => {
  it('stamps requests in the desk time frame, not the phone one', async () => {
    // The desk rejects anything more than 60s from its own clock. A phone five
    // minutes behind would otherwise fail every single request — including the
    // reads that would let the operator see what is going on.
    const clock = new TestClock(T0);
    const auth = new Authenticator(clock);
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const enrolled = auth.enrol(
      auth.createEnrolmentCode('phone'),
      publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    );

    const phoneClockMs = T0 - 300_000; // five minutes slow
    let captured: Record<string, string> | undefined;
    const fetchFn = (async (_url: string, init?: { headers?: Record<string, string> }) => {
      captured = init?.headers;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const client = new DeskClient({
      baseUrl: 'https://desk.local',
      signer: {
        identity: { publicKey: '', keyKind: 'ed25519', hardwareBacked: false },
        sign: async (canonical) =>
          sign(null, Buffer.from(canonical, 'utf8'), privateKey).toString('base64'),
        isProvisioned: async () => true,
        provision: async () => ({ publicKey: '', keyKind: 'ed25519', hardwareBacked: false }),
        destroy: async () => undefined,
      },
      deviceId: enrolled.deviceId,
      hashBody: async (b) => createHash('sha256').update(b).digest('base64'),
      randomId: () => 'req-skew',
      fetchFn,
      now: () => phoneClockMs,
      clockOffsetMs: () => 300_000, // measured by the socket
    });

    await client.get('/state', 1);

    // The desk accepts it, because it was stamped in the desk's frame.
    expect(captured).toBeDefined();
    const parts = {
      method: 'GET',
      path: '/state',
      timestamp: Number(captured?.['x-keel-timestamp']),
      nonce: captured?.['x-keel-nonce'] as string,
      bodyHash: deskHashBody(''),
    };
    expect(() =>
      auth.verifyRequest(
        {
          deviceId: enrolled.deviceId,
          ...parts,
          signature: captured?.['x-keel-signature'] as string,
        },
        false,
      ),
    ).not.toThrow();
  });

  it('turns a clock-skew rejection into something the operator can act on', async () => {
    const fetchFn = (async () =>
      new Response(
        JSON.stringify({
          code: 'CLOCK_SKEW',
          detail: 'request timestamp is too far from desk time',
        }),
        { status: 401 },
      )) as unknown as typeof fetch;
    const res = await makeClient(fetchFn).get('/state', 1);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('CLOCK_SKEW');
    expect(res.title).toMatch(/clock/i);
    expect(res.detail).toMatch(/automatic date and time/i);
  });
});
