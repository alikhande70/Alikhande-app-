import { describe, expect, it, vi } from 'vitest';
import type { EnrolledDevice } from './auth.js';
import { AuthError, hashBody } from './auth.js';
import { verifyStreamHelloAuth } from './stream-auth.js';

const device: EnrolledDevice = {
  deviceId: 'device-1',
  publicKey: 'unused-in-this-unit-test',
  keyKind: 'ed25519',
  claimsHardwareBacked: false,
  label: 'phone',
  enrolledAt: 1,
};

describe('stream hello authentication', () => {
  it('uses the ordinary signed-read contract for GET /stream', () => {
    const verifyRequest = vi.fn(() => device);

    expect(
      verifyStreamHelloAuth(
        {
          deviceId: 'device-1',
          timestamp: 1234,
          nonce: 'fresh-nonce',
          signature: 'signed-by-device',
        },
        { verifyRequest },
      ),
    ).toBe(device);

    expect(verifyRequest).toHaveBeenCalledWith(
      {
        deviceId: 'device-1',
        method: 'GET',
        path: '/stream',
        timestamp: 1234,
        nonce: 'fresh-nonce',
        bodyHash: hashBody(''),
        signature: 'signed-by-device',
      },
      false,
    );
  });

  it('rejects an unsigned or malformed hello before it can reach the hub', () => {
    const verifyRequest = vi.fn(() => device);

    expect(() => verifyStreamHelloAuth(undefined, { verifyRequest })).toThrow(AuthError);
    expect(() =>
      verifyStreamHelloAuth(
        {
          deviceId: 'device-1',
          timestamp: '1234',
          nonce: 'fresh-nonce',
          signature: 'signed-by-device',
        },
        { verifyRequest },
      ),
    ).toThrow('stream hello is not signed correctly');
    expect(verifyRequest).not.toHaveBeenCalled();
  });

  it('does not hide verifier failures such as replay, skew or bad signatures', () => {
    const verifyRequest = vi.fn(() => {
      throw new AuthError('request nonce has already been used', 'REPLAY');
    });

    expect(() =>
      verifyStreamHelloAuth(
        {
          deviceId: 'device-1',
          timestamp: 1234,
          nonce: 'replayed',
          signature: 'captured',
        },
        { verifyRequest },
      ),
    ).toThrow('request nonce has already been used');
  });
});
