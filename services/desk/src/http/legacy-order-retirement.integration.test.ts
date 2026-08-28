import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Desk } from '../main.js';
import { startDesk } from '../main.js';
import { canonicalString, hashBody } from './auth.js';

let desk: Desk;
let baseUrl: string;
let deviceId: string;
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicKeyB64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

async function signedCall(
  method: string,
  path: string,
  body?: unknown,
  commandNonce?: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const text = body === undefined ? '' : JSON.stringify(body);
  const request = {
    method,
    path,
    timestamp: Date.now(),
    nonce: randomUUID(),
    bodyHash: hashBody(text),
    ...(commandNonce === undefined ? {} : { commandNonce }),
  };
  const signature = sign(
    null,
    Buffer.from(canonicalString(request), 'utf8'),
    privateKey,
  ).toString('base64');
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-keel-device': deviceId,
    'x-keel-timestamp': String(request.timestamp),
    'x-keel-nonce': request.nonce,
    'x-keel-signature': signature,
  };
  if (commandNonce !== undefined) headers['x-keel-command-nonce'] = commandNonce;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: text }),
  });
  return {
    status: response.status,
    json: (await response.json()) as Record<string, unknown>,
  };
}

beforeAll(async () => {
  desk = await startDesk({
    host: '127.0.0.1',
    port: 18789,
    allowNonLoopback: false,
    dataDir: ':memory:',
    synchronous: 'OFF',
    broker: 'paper',
    referenceProvider: 'none',
    accountCurrency: 'USD',
    instruments: ['XAUUSD'],
    reconcileIntervalMs: 60_000,
    guardIntervalMs: 60_000,
    logLevel: 'silent',
  });
  baseUrl = desk.url;
  const code = desk.createEnrolmentCode('legacy retirement test', 60_000);
  const response = await fetch(`${baseUrl}/enrol`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, publicKey: publicKeyB64 }),
  });
  const body = (await response.json()) as { deviceId: string };
  if (!response.ok) throw new Error(`enrolment failed: ${JSON.stringify(body)}`);
  deviceId = body.deviceId;
}, 30_000);

afterAll(async () => {
  await desk?.stop();
});

describe('ADR-0018 missionless order retirement', () => {
  it('returns 410 before the legacy handler can create an intent', async () => {
    const nonceResponse = await signedCall('GET', '/command-nonce');
    const commandNonce = nonceResponse.json.nonce as string;
    const intentId = randomUUID();

    const response = await signedCall(
      'POST',
      '/orders',
      {
        intentId,
        canonical: 'XAUUSD',
        side: 'buy',
        kind: 'market',
        stopPrice: '2395.00',
        riskPct: '0.005',
        preTradeNote: 'this legacy path must never execute',
      },
      commandNonce,
    );

    expect(response.status).toBe(410);
    expect(response.json.code).toBe('MISSION_REQUIRED');
    expect(response.json.outcomeUnknown).toBe(false);

    const row = desk.ledger.db
      .prepare("SELECT COUNT(*) AS count FROM ledger WHERE stream = ? AND kind = 'intent.created'")
      .get(intentId) as { count: number };
    expect(row.count).toBe(0);
  });
});
