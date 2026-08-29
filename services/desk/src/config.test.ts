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

describe('MT5 configuration', () => {
  const metadata = JSON.stringify({
    XAUUSD: { assetClass: 'metal', base: 'XAU', quote: 'USD', venueTimeZone: 'Europe/Riga' },
  });

  const complete = {
    KEEL_BROKER: 'mt5',
    KEEL_MT5_HOST_URL: 'http://127.0.0.1:28762',
    KEEL_MT5_HOST_TOKEN: 'host-token-0123456789',
    KEEL_MT5_INSTRUMENT_METADATA: metadata,
  };

  it('refuses KEEL_BROKER=mt5 with nothing configured', () => {
    // The desk cannot infer the execution host, its credential, or what an
    // instrument means. Failing at boot beats failing while sizing an order.
    expect(() => base({ KEEL_BROKER: 'mt5' })).toThrow(/KEEL_MT5_HOST_URL/);
  });

  it('names each missing field', () => {
    expect(() => base({ KEEL_BROKER: 'mt5', KEEL_MT5_HOST_URL: 'http://x' })).toThrow(
      /KEEL_MT5_HOST_TOKEN/,
    );
  });

  it('requires instrument metadata rather than inferring it from symbol names', () => {
    expect(() =>
      base({ ...complete, KEEL_MT5_INSTRUMENT_METADATA: undefined as unknown as string }),
    ).toThrow(/KEEL_MT5_INSTRUMENT_METADATA/);
  });

  it('accepts a complete demo configuration', () => {
    const cfg = base(complete);
    expect(cfg.broker).toBe('mt5');
    expect(cfg.mt5AllowedTradeModes).toEqual(['demo']);
    expect(cfg.mt5AllowRealTrading).toBe(false);
  });

  it('rejects malformed alias or metadata JSON instead of starting blind', () => {
    expect(() => base({ ...complete, KEEL_MT5_SYMBOL_ALIASES: '{oops' })).toThrow(/valid JSON/);
    expect(() => base({ ...complete, KEEL_MT5_INSTRUMENT_METADATA: '[]' })).toThrow(/JSON object/);
  });

  it('hard-blocks a real account behind a second deliberate step', () => {
    expect(() => base({ ...complete, KEEL_MT5_ALLOWED_TRADE_MODES: 'demo,real' })).toThrow(
      /KEEL_MT5_ALLOW_REAL_TRADING=true/,
    );
  });

  it('still requires the operator to opt in twice for real', () => {
    const cfg = base({
      ...complete,
      KEEL_MT5_ALLOWED_TRADE_MODES: 'demo,real',
      KEEL_MT5_ALLOW_REAL_TRADING: 'true',
    });
    expect(cfg.mt5AllowedTradeModes).toContain('real');
  });

  it('no longer offers the rejected metaapi bridge', () => {
    // ADR-0016 rejected third-party MT5 cloud on credential custody; offering
    // the value implied a path that will not exist.
    expect(() => base({ KEEL_BROKER: 'metaapi' })).toThrow();
  });
});
