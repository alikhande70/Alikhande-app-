import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TestClock } from '../sim/clock.js';
import { AuthError, Authenticator, canonicalString, hashBody } from './auth.js';

const T0 = Date.UTC(2026, 5, 15, 14, 0);

function makeDevice(): { publicKey: string; signWith: (msg: string) => string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    signWith: (msg: string) => sign(null, Buffer.from(msg, 'utf8'), privateKey).toString('base64'),
  };
}

function setup() {
  const clock = new TestClock(T0);
  const auth = new Authenticator(clock);
  const device = makeDevice();
  const code = auth.createEnrolmentCode('iPhone');
  const enrolled = auth.enrol(code, device.publicKey);
  return { clock, auth, device, enrolled };
}

function signedRequest(
  device: ReturnType<typeof makeDevice>,
  deviceId: string,
  over: Partial<{
    method: string;
    path: string;
    timestamp: number;
    nonce: string;
    body: string;
    commandNonce: string;
  }> = {},
) {
  const base = {
    method: over.method ?? 'POST',
    path: over.path ?? '/orders',
    timestamp: over.timestamp ?? T0,
    nonce: over.nonce ?? 'n-1',
    bodyHash: hashBody(over.body ?? '{}'),
    ...(over.commandNonce !== undefined ? { commandNonce: over.commandNonce } : {}),
  };
  return { deviceId, ...base, signature: device.signWith(canonicalString(base)) };
}

describe('enrolment', () => {
  it('accepts a valid code exactly once', () => {
    const clock = new TestClock(T0);
    const auth = new Authenticator(clock);
    const d = makeDevice();
    const code = auth.createEnrolmentCode('iPhone');
    expect(auth.enrol(code, d.publicKey).label).toBe('iPhone');
    expect(() => auth.enrol(code, d.publicKey)).toThrow(/unknown enrolment code/);
  });

  it('consumes a code even on a failed attempt, so it cannot be brute-forced', () => {
    const clock = new TestClock(T0);
    const auth = new Authenticator(clock);
    const code = auth.createEnrolmentCode('iPhone');
    expect(() => auth.enrol(code, 'not-a-key')).toThrow(AuthError);
    // The second attempt fails as unknown, not as a bad key: the code is gone.
    expect(() => auth.enrol(code, makeDevice().publicKey)).toThrow(/unknown enrolment code/);
  });

  it('expires a code', () => {
    const clock = new TestClock(T0);
    const auth = new Authenticator(clock);
    const code = auth.createEnrolmentCode('iPhone', 60_000);
    void clock.advance(120_000);
    expect(() => auth.enrol(code, makeDevice().publicKey)).toThrow(/expired/);
  });

  it('refuses a key type neither an enclave nor the desk supports', () => {
    const clock = new TestClock(T0);
    const auth = new Authenticator(clock);
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const code = auth.createEnrolmentCode('iPhone');
    expect(() =>
      auth.enrol(code, publicKey.export({ format: 'der', type: 'spki' }).toString('base64')),
    ).toThrow(/P-256 or Ed25519/);
  });

  it('refuses an EC key on a curve no enclave can hold', () => {
    const clock = new TestClock(T0);
    const auth = new Authenticator(clock);
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
    const code = auth.createEnrolmentCode('iPhone');
    expect(() =>
      auth.enrol(code, publicKey.export({ format: 'der', type: 'spki' }).toString('base64')),
    ).toThrow(/must be P-256/);
  });

  it('accepts an ECDSA P-256 key, which is what a Secure Enclave can hold', () => {
    const clock = new TestClock(T0);
    const auth = new Authenticator(clock);
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const code = auth.createEnrolmentCode('iPhone');
    const device = auth.enrol(
      code,
      publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
      true,
    );
    expect(device.keyKind).toBe('p256');
    expect(device.claimsHardwareBacked).toBe(true);
    expect(auth.softwareOnlyDevices()).toHaveLength(0);
  });

  it('records a software-only key as such, so the operator can see the difference', () => {
    const clock = new TestClock(T0);
    const auth = new Authenticator(clock);
    const code = auth.createEnrolmentCode('laptop CLI');
    const device = auth.enrol(code, makeDevice().publicKey);
    expect(device.keyKind).toBe('ed25519');
    expect(device.claimsHardwareBacked).toBe(false);
    expect(auth.softwareOnlyDevices().map((d) => d.deviceId)).toContain(device.deviceId);
  });
});

describe('P-256 signing, the enclave path', () => {
  function p256Device() {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    return {
      publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
      // Raw r||s, as WebCrypto and the platform enclave APIs produce. DER would
      // silently fail to verify, which is exactly the integration bug this pins.
      signWith: (msg: string) =>
        sign('sha256', Buffer.from(msg, 'utf8'), {
          key: privateKey,
          dsaEncoding: 'ieee-p1363',
        }).toString('base64'),
    };
  }

  it('verifies a P-256 signature in raw r||s form', () => {
    const clock = new TestClock(T0);
    const auth = new Authenticator(clock);
    const device = p256Device();
    const enrolled = auth.enrol(auth.createEnrolmentCode('iPhone'), device.publicKey, true);
    const req = signedRequest(device, enrolled.deviceId, { method: 'GET', path: '/state' });
    expect(auth.verifyRequest(req, false).keyKind).toBe('p256');
  });

  it('rejects a P-256 signature over the wrong message', () => {
    const clock = new TestClock(T0);
    const auth = new Authenticator(clock);
    const device = p256Device();
    const enrolled = auth.enrol(auth.createEnrolmentCode('iPhone'), device.publicKey, true);
    const req = signedRequest(device, enrolled.deviceId, { body: '{"a":1}' });
    expect(() => auth.verifyRequest({ ...req, bodyHash: hashBody('{"a":2}') }, false)).toThrow(
      /signature does not verify/,
    );
  });
});

describe('request signing', () => {
  it('accepts a correctly signed read request', () => {
    const { auth, device, enrolled } = setup();
    const req = signedRequest(device, enrolled.deviceId, { method: 'GET', path: '/state' });
    expect(auth.verifyRequest(req, false).deviceId).toBe(enrolled.deviceId);
  });

  it('rejects an unknown device', () => {
    const { auth, device } = setup();
    expect(() => auth.verifyRequest(signedRequest(device, 'nope'), false)).toThrow(/unknown device/);
  });

  it('rejects a tampered body while the signature stays valid for the old one', () => {
    const { auth, device, enrolled } = setup();
    const req = signedRequest(device, enrolled.deviceId, { body: '{"volume":"0.1"}' });
    const tampered = { ...req, bodyHash: hashBody('{"volume":"10.0"}') };
    expect(() => auth.verifyRequest(tampered, false)).toThrow(/signature does not verify/);
  });

  it('rejects a request redirected to another path', () => {
    const { auth, device, enrolled } = setup();
    const req = signedRequest(device, enrolled.deviceId, { path: '/preview' });
    expect(() => auth.verifyRequest({ ...req, path: '/orders' }, false)).toThrow(
      /signature does not verify/,
    );
  });

  it('rejects a stale timestamp', () => {
    const { auth, device, enrolled } = setup();
    const req = signedRequest(device, enrolled.deviceId, { timestamp: T0 - 300_000 });
    expect(() => auth.verifyRequest(req, false)).toThrow(/from desk time/);
  });

  it('rejects a replayed request nonce', () => {
    const { auth, device, enrolled } = setup();
    const req = signedRequest(device, enrolled.deviceId, { method: 'GET', path: '/state' });
    auth.verifyRequest(req, false);
    expect(() => auth.verifyRequest(req, false)).toThrow(/already been used/);
  });

  it('does not consume a nonce when the signature fails', () => {
    // Otherwise an attacker who cannot forge a signature could still lock the
    // operator out by burning their nonces.
    const { auth, device, enrolled } = setup();
    const req = signedRequest(device, enrolled.deviceId, { method: 'GET', path: '/state' });
    expect(() => auth.verifyRequest({ ...req, signature: 'AAAA' }, false)).toThrow();
    expect(auth.verifyRequest(req, false).deviceId).toBe(enrolled.deviceId);
  });
});

describe('command nonces protect anything that moves money', () => {
  it('requires one on a command endpoint', () => {
    const { auth, device, enrolled } = setup();
    expect(() => auth.verifyRequest(signedRequest(device, enrolled.deviceId), true)).toThrow(
      /requires a command nonce/,
    );
  });

  it('accepts a freshly issued nonce', () => {
    const { auth, device, enrolled } = setup();
    const { nonce } = auth.issueCommandNonce();
    const req = signedRequest(device, enrolled.deviceId, { commandNonce: nonce });
    expect(auth.verifyRequest(req, true).deviceId).toBe(enrolled.deviceId);
  });

  it('makes a captured request useless — the nonce is single use', () => {
    const { auth, device, enrolled } = setup();
    const { nonce } = auth.issueCommandNonce();
    const req = signedRequest(device, enrolled.deviceId, { commandNonce: nonce });
    auth.verifyRequest(req, true);
    // Replaying the exact bytes, signature and all, now fails.
    const replay = signedRequest(device, enrolled.deviceId, {
      commandNonce: nonce,
      nonce: 'n-2',
    });
    expect(() => auth.verifyRequest(replay, true)).toThrow(/unknown or already used/);
  });

  it('expires an unused nonce', () => {
    const { clock, auth, device, enrolled } = setup();
    const { nonce } = auth.issueCommandNonce();
    void clock.advance(200_000);
    const req = signedRequest(device, enrolled.deviceId, {
      commandNonce: nonce,
      timestamp: clock.now(),
    });
    expect(() => auth.verifyRequest(req, true)).toThrow(/unknown or already used|expired/);
  });

  it('binds the nonce into the signature, so it cannot be swapped in', () => {
    const { auth, device, enrolled } = setup();
    const a = auth.issueCommandNonce();
    const b = auth.issueCommandNonce();
    const req = signedRequest(device, enrolled.deviceId, { commandNonce: a.nonce });
    expect(() => auth.verifyRequest({ ...req, commandNonce: b.nonce }, true)).toThrow(
      /signature does not verify/,
    );
  });

  it('leaves reads working when nonces are unavailable', () => {
    // A flaky network must not lock the operator out of *seeing* their
    // positions — only out of changing them.
    const { auth, device, enrolled } = setup();
    const read = signedRequest(device, enrolled.deviceId, { method: 'GET', path: '/state' });
    expect(auth.verifyRequest(read, false).deviceId).toBe(enrolled.deviceId);
  });
});

describe('revocation', () => {
  it('a revoked device cannot sign anything', () => {
    const { auth, device, enrolled } = setup();
    expect(auth.revoke(enrolled.deviceId)).toBe(true);
    expect(() => auth.verifyRequest(signedRequest(device, enrolled.deviceId), false)).toThrow(
      /unknown device/,
    );
  });
});
