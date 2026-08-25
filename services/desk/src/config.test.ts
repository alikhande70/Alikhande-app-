import { describe, expect, it } from 'vitest';
import { assertBrokerCredentials, ConfigError, DeskConfig, loadConfig } from './config.js';

/**
 * These are the checks that decide whether the desk is allowed to start at all.
 * They are the cheapest place in the whole system to stop a dangerous
 * configuration, so they are worth pinning precisely.
 */

const base = (env: Record<string, string> = {}) => loadConfig(env as NodeJS.ProcessEnv);

describe('defaults', () => {
  it('is loopback, paper, and fsynced unless told otherwise', () => {
    const cfg = base();
    expect(cfg.host).toBe('127.0.0.1');
    expect(cfg.broker).toBe('paper');
    expect(cfg.synchronous).toBe('FULL');
    expect(cfg.oandaEnvironment).toBe('practice');
  });
});

describe('network exposure', () => {
  it('refuses a non-loopback bind without an explicit opt-in', () => {
    expect(() => base({ KEEL_HOST: '0.0.0.0' })).toThrow(ConfigError);
  });

  it('still refuses once opted in, if there is no TLS', () => {
    expect(() => base({ KEEL_HOST: '0.0.0.0', KEEL_ALLOW_NON_LOOPBACK: 'true' })).toThrow(/TLS/);
  });

  it('accepts a non-loopback bind with both steps taken', () => {
    const cfg = base({
      KEEL_HOST: '0.0.0.0',
      KEEL_ALLOW_NON_LOOPBACK: 'true',
      KEEL_TLS_CERT: '/etc/keel/cert.pem',
      KEEL_TLS_KEY: '/etc/keel/key.pem',
    });
    expect(cfg.host).toBe('0.0.0.0');
  });
});

describe('broker credentials', () => {
  it('refuses KEEL_BROKER=oanda with no token or account', () => {
    expect(() => base({ KEEL_BROKER: 'oanda' })).toThrow(
      /KEEL_OANDA_TOKEN and KEEL_OANDA_ACCOUNT_ID/,
    );
  });

  it('names only the credential that is actually missing', () => {
    expect(() => base({ KEEL_BROKER: 'oanda', KEEL_OANDA_TOKEN: 'x' })).toThrow(
      /needs KEEL_OANDA_ACCOUNT_ID/,
    );
  });

  it('accepts a complete practice configuration', () => {
    const cfg = base({
      KEEL_BROKER: 'oanda',
      KEEL_OANDA_TOKEN: 'token',
      KEEL_OANDA_ACCOUNT_ID: '101-004-1234567-001',
    });
    expect(cfg.oandaEnvironment).toBe('practice');
  });

  it('refuses live trading on one setting alone', () => {
    // Selecting the live environment is not the same as acknowledging what it
    // means. The second flag is the acknowledgement.
    expect(() =>
      base({
        KEEL_BROKER: 'oanda',
        KEEL_OANDA_TOKEN: 'token',
        KEEL_OANDA_ACCOUNT_ID: '101-004-1234567-001',
        KEEL_OANDA_ENVIRONMENT: 'live',
      }),
    ).toThrow(/KEEL_OANDA_ALLOW_LIVE=true/);
  });

  it('allows live trading once both steps are taken', () => {
    const cfg = base({
      KEEL_BROKER: 'oanda',
      KEEL_OANDA_TOKEN: 'token',
      KEEL_OANDA_ACCOUNT_ID: '101-004-1234567-001',
      KEEL_OANDA_ENVIRONMENT: 'live',
      KEEL_OANDA_ALLOW_LIVE: 'true',
    });
    expect(cfg.oandaEnvironment).toBe('live');
  });

  it('leaves the paper broker alone', () => {
    const cfg = DeskConfig.parse({ broker: 'paper' });
    expect(() => assertBrokerCredentials(cfg)).not.toThrow();
  });
});
