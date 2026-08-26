import { describe, expect, it } from 'vitest';
import {
  hasSystemPrefix,
  Mt5IdentityError,
  magicForClientOrderId,
  magicFromWire,
  magicToWire,
  validateSystemPrefix,
} from './identity.js';

describe('MT5 intent identity', () => {
  it('is deterministic for the same client order id and prefix', () => {
    const a = magicForClientOrderId('k-01JZEXAMPLE', 0x4b45);
    const b = magicForClientOrderId('k-01JZEXAMPLE', 0x4b45);
    expect(a).toBe(b);
  });

  it('changes when the client order id changes', () => {
    expect(magicForClientOrderId('intent-a', 7)).not.toBe(magicForClientOrderId('intent-b', 7));
  });

  it('carries the 16-bit installation prefix', () => {
    const magic = magicForClientOrderId('stable-intent', 0xabcd);
    expect(hasSystemPrefix(magic, 0xabcd)).toBe(true);
    expect(hasSystemPrefix(magic, 0xabce)).toBe(false);
  });

  it('never sets the signed long sign bit', () => {
    const maxSignedDomain = 1n << 63n;
    for (let prefix = 0; prefix <= 0xffff; prefix += 4093) {
      const magic = magicForClientOrderId(`intent-${prefix}`, prefix);
      expect(magic).toBeGreaterThanOrEqual(0n);
      expect(magic).toBeLessThan(maxSignedDomain);
    }
  });

  it('round-trips as a decimal string without Number precision loss', () => {
    const magic = magicForClientOrderId('high-precision-intent', 0xffff);
    expect(magic).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
    expect(magicFromWire(magicToWire(magic))).toBe(magic);
  });

  it('rejects malformed or sign-bit-set wire values', () => {
    expect(() => magicFromWire('-1')).toThrow(Mt5IdentityError);
    expect(() => magicFromWire('12.3')).toThrow(Mt5IdentityError);
    expect(() => magicFromWire((1n << 63n).toString())).toThrow(/sign bit/);
  });

  it('rejects invalid system prefixes', () => {
    expect(() => validateSystemPrefix(-1)).toThrow(Mt5IdentityError);
    expect(() => validateSystemPrefix(65_536)).toThrow(Mt5IdentityError);
    expect(() => validateSystemPrefix(1.5)).toThrow(Mt5IdentityError);
  });

  it('rejects an empty client order id', () => {
    expect(() => magicForClientOrderId('', 1)).toThrow(/must not be empty/);
  });
});
