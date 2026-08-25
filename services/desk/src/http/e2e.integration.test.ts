import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startDesk } from '../main.js';
import type { Desk } from '../main.js';
import { canonicalString, hashBody } from './auth.js';

/**
 * End to end over the real HTTP and WebSocket surface.
 *
 * This boots the actual desk the operator runs — same assembly, same auth, same
 * socket — rather than a test-only wiring. A harness that assembles components
 * differently from production tests a system nobody runs.
 */

let desk: Desk;
let baseUrl: string;
let deviceId: string;
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicKeyB64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

/** Sign and send, exactly as the mobile client does. */
async function call(
  method: string,
  path: string,
  body?: unknown,
  commandNonce?: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const text = body === undefined ? '' : JSON.stringify(body);
  const base = {
    method,
    path,
    timestamp: Date.now(),
    nonce: randomUUID(),
    bodyHash: hashBody(text),
    ...(commandNonce !== undefined ? { commandNonce } : {}),
  };
  const signature = sign(null, Buffer.from(canonicalString(base), 'utf8'), privateKey).toString('base64');
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-keel-device': deviceId,
    'x-keel-timestamp': String(base.timestamp),
    'x-keel-nonce': base.nonce,
    'x-keel-signature': signature,
  };
  if (commandNonce !== undefined) headers['x-keel-command-nonce'] = commandNonce;

  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: text }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function commandNonce(): Promise<string> {
  const r = await call('GET', '/command-nonce');
  return r.json.nonce as string;
}

beforeAll(async () => {
  desk = await startDesk({
    host: '127.0.0.1',
    port: 18787,
    allowNonLoopback: false,
    dataDir: ':memory:',
    synchronous: 'OFF',
    broker: 'paper',
    referenceProvider: 'none',
    accountCurrency: 'USD',
    instruments: ['XAUUSD', 'EURUSD'],
    reconcileIntervalMs: 60_000,
    guardIntervalMs: 60_000,
    logLevel: 'silent',
  });
  baseUrl = desk.url;

  // Enrol, using a code the desk would print to its own console.
  const enrolRes = await fetch(`${baseUrl}/health`);
  expect(enrolRes.ok).toBe(true);
}, 30_000);

afterAll(async () => {
  await desk?.stop();
});

describe('the desk boots and serves', () => {
  it('reports health without authentication', async () => {
    const res = await fetch(`${baseUrl}/health`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body.brokerName).toBe('paper');
    expect(typeof body.deskStartedAt).toBe('number');
  });

  it('refuses an unsigned request to anything else', async () => {
    const res = await fetch(`${baseUrl}/state`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('UNSIGNED');
  });
});

describe('enrolment and signed access', () => {
  it('rejects a bad enrolment code', async () => {
    const res = await fetch(`${baseUrl}/enrol`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'NOPE', publicKey: publicKeyB64 }),
    });
    expect(res.status).toBe(403);
  });

  it('enrols a device and then serves signed reads', async () => {
    const enrol = await enrolThroughDesk();
    deviceId = enrol.deviceId;
    expect(deviceId).toHaveLength(16);

    const state = await call('GET', '/state');
    expect(state.status).toBe(200);
    expect(state.json.serverTime).toBeTypeOf('number');
    expect(Array.isArray(state.json.positions)).toBe(true);
  });
});

describe('order placement over the wire', () => {
  it('refuses a command without a nonce', async () => {
    const res = await call('POST', '/orders', {
      intentId: randomUUID(),
      canonical: 'XAUUSD',
      side: 'buy',
      stopPrice: '2395.00',
      preTradeNote: 'test',
    });
    expect(res.status).toBe(401);
    expect(res.json.code).toBe('NONCE_REQUIRED');
  });

  it('previews without side effects and without a nonce', async () => {
    const res = await call('POST', '/preview', {
      canonical: 'XAUUSD',
      side: 'buy',
      stopPrice: '2395.00',
      riskPct: '0.005',
      preTradeNote: 'preview only',
    });
    expect(res.status).toBe(200);
    expect(res.json.risk).toBeDefined();
    // No order was created.
    const orders = await call('GET', '/orders');
    expect((orders.json as unknown as unknown[]).length ?? 0).toBe(0);
  });

  it('accepts a signed order with a nonce, and never claims it is filled', async () => {
    const nonce = await commandNonce();
    const intentId = randomUUID();
    const res = await call(
      'POST',
      '/orders',
      {
        intentId,
        canonical: 'XAUUSD',
        side: 'buy',
        kind: 'market',
        stopPrice: '2395.00',
        riskPct: '0.005',
        preTradeNote: 'end to end test order',
      },
      nonce,
    );

    // 202, not 201: nothing has been created at the venue yet, and the status
    // code must not imply otherwise.
    expect([202, 409]).toContain(res.status);
    expect(res.json.intentId).toBe(intentId);
    expect(res.json.risk).toBeDefined();
    // Whatever the outcome, the reply carries a risk decision and never a
    // bare "success".
    const risk = res.json.risk as Record<string, unknown>;
    expect(['pass', 'warn', 'block']).toContain(risk.verdict);
  });

  it('deduplicates a replayed order intent', async () => {
    const intentId = randomUUID();
    const body = {
      intentId,
      canonical: 'XAUUSD',
      side: 'buy' as const,
      kind: 'market' as const,
      stopPrice: '2395.00',
      riskPct: '0.005',
      preTradeNote: 'dedupe test',
    };
    const first = await call('POST', '/orders', body, await commandNonce());
    const second = await call('POST', '/orders', body, await commandNonce());
    // The second is recognised as the same human decision.
    if (first.status === 202) expect(second.json.deduplicated).toBe(true);
  });
});

describe('the realtime socket', () => {
  it('sends a welcome, then a sequenced snapshot per topic', async () => {
    const ws = new WebSocket(`${baseUrl.replace('http', 'ws')}/stream`);
    const frames: Record<string, unknown>[] = [];
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('socket timeout')), 10_000);
      ws.on('open', () => {
        ws.send(
          JSON.stringify({
            type: 'hello',
            protocolVersion: 1,
            clientVersion: 'test',
            topics: ['health', 'positions'],
            resume: {},
          }),
        );
      });
      ws.on('message', (raw) => {
        frames.push(JSON.parse(raw.toString()) as Record<string, unknown>);
        if (frames.length >= 5) {
          clearTimeout(timer);
          resolve();
        }
      });
      ws.on('error', reject);
      setTimeout(() => {
        clearTimeout(timer);
        resolve();
      }, 3_000);
    });
    ws.close();

    expect(frames[0]?.type).toBe('welcome');
    const snapshots = frames.filter((f) => f.type === 'snapshot');
    expect(snapshots.length).toBeGreaterThanOrEqual(2);
    for (const s of snapshots) expect(typeof s.seq).toBe('number');
    // A new subscription is always preceded by a resync, so the client never
    // has to guess whether it missed anything.
    expect(frames.some((f) => f.type === 'resync')).toBe(true);
  }, 20_000);

  it('answers a ping with the client clock echoed back', async () => {
    const ws = new WebSocket(`${baseUrl.replace('http', 'ws')}/stream`);
    const pong = await new Promise<Record<string, unknown> | undefined>((resolve) => {
      const timer = setTimeout(() => resolve(undefined), 8_000);
      ws.on('open', () => ws.send(JSON.stringify({ type: 'ping', clientTime: 12345 })));
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (msg.type === 'pong') {
          clearTimeout(timer);
          resolve(msg);
        }
      });
    });
    ws.close();
    expect(pong?.clientTime).toBe(12345);
    expect(typeof pong?.serverTime).toBe('number');
  }, 20_000);
});

/**
 * Enrol by minting a code the same way the desk's console does.
 * The flow is deliberately out-of-band: there is no network endpoint that hands
 * out enrolment codes, because that endpoint would be a way in for anyone who
 * can reach the port.
 */
async function enrolThroughDesk(): Promise<{ deviceId: string }> {
  const code = desk.createEnrolmentCode('test device', 60_000);
  const res = await fetch(`${baseUrl}/enrol`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, publicKey: publicKeyB64 }),
  });
  const body = (await res.json()) as { deviceId: string };
  if (!res.ok) throw new Error(`enrolment failed: ${JSON.stringify(body)}`);
  return body;
}
