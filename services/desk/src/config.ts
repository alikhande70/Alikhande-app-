import { z } from 'zod';

/**
 * Desk configuration.
 *
 * Validated at boot and never read again from the environment, so a
 * misconfiguration is a startup failure rather than a surprise at 14:30 when
 * the first order goes out.
 *
 * The defaults are the safe ones: loopback only, paper broker, no live
 * credentials. Every step toward real money is an explicit opt-in.
 */

export const DeskConfig = z.object({
  /**
   * Bind address. Loopback by default (ADR-0011): remote access is expected via
   * WireGuard or Tailscale, not by exposing a trading desk to the internet.
   */
  host: z.string().default('127.0.0.1'),
  port: z.number().int().min(1).max(65535).default(8787),

  /**
   * Exposing beyond loopback requires saying so, and then also requires TLS.
   * Two deliberate steps, because the failure mode is total.
   */
  allowNonLoopback: z.boolean().default(false),
  tlsCertPath: z.string().optional(),
  tlsKeyPath: z.string().optional(),

  dataDir: z.string().default('./data'),
  /** `FULL` fsyncs every commit. Only lower it for tests. */
  synchronous: z.enum(['FULL', 'NORMAL', 'OFF']).default('FULL'),

  broker: z.enum(['paper', 'oanda', 'metaapi']).default('paper'),
  /** Reference market-data provider. `none` disables the second plane. */
  referenceProvider: z.enum(['cryptocom', 'none']).default('none'),

  accountCurrency: z.string().length(3).default('USD'),
  instruments: z.array(z.string()).default(['XAUUSD', 'EURUSD']),

  reconcileIntervalMs: z.number().int().min(1_000).default(10_000),
  guardIntervalMs: z.number().int().min(1_000).default(5_000),

  /** Expo push token for the operator's device. Alerts are logged without it. */
  expoPushToken: z.string().optional(),

  /** Anthropic API key for the copilot. The copilot is disabled without it. */
  anthropicApiKey: z.string().optional(),

  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'silent']).default('info'),
});

export type DeskConfig = z.infer<typeof DeskConfig>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DeskConfig {
  const raw = {
    host: env.KEEL_HOST,
    port: env.KEEL_PORT === undefined ? undefined : Number(env.KEEL_PORT),
    allowNonLoopback: env.KEEL_ALLOW_NON_LOOPBACK === 'true',
    tlsCertPath: env.KEEL_TLS_CERT,
    tlsKeyPath: env.KEEL_TLS_KEY,
    dataDir: env.KEEL_DATA_DIR,
    synchronous: env.KEEL_SYNCHRONOUS,
    broker: env.KEEL_BROKER,
    referenceProvider: env.KEEL_REFERENCE_PROVIDER,
    accountCurrency: env.KEEL_ACCOUNT_CURRENCY,
    instruments: env.KEEL_INSTRUMENTS?.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    reconcileIntervalMs:
      env.KEEL_RECONCILE_INTERVAL_MS === undefined
        ? undefined
        : Number(env.KEEL_RECONCILE_INTERVAL_MS),
    guardIntervalMs:
      env.KEEL_GUARD_INTERVAL_MS === undefined ? undefined : Number(env.KEEL_GUARD_INTERVAL_MS),
    expoPushToken: env.KEEL_EXPO_PUSH_TOKEN,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    logLevel: env.KEEL_LOG_LEVEL,
  };

  const cleaned = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined));
  const parsed = DeskConfig.safeParse(cleaned);
  if (!parsed.success) {
    throw new ConfigError(
      `invalid desk configuration:\n${parsed.error.issues
        .map((i) => `  ${i.path.join('.')}: ${i.message}`)
        .join('\n')}`,
    );
  }
  assertSafeExposure(parsed.data);
  return parsed.data;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * Refuse to start in a configuration that would put a trading desk on a network
 * without encryption. This is a startup failure, not a warning, because a
 * warning in a log nobody reads is how it ends up running that way for months.
 */
export function assertSafeExposure(cfg: DeskConfig): void {
  if (LOOPBACK.has(cfg.host)) return;
  if (!cfg.allowNonLoopback) {
    throw new ConfigError(
      `host is ${cfg.host}, which is not loopback. Remote access is expected over a private ` +
        'network (WireGuard/Tailscale) with the desk still bound to loopback. If you really mean ' +
        'to bind wider, set KEEL_ALLOW_NON_LOOPBACK=true and provide TLS.',
    );
  }
  if (cfg.tlsCertPath === undefined || cfg.tlsKeyPath === undefined) {
    throw new ConfigError(
      `host is ${cfg.host} with KEEL_ALLOW_NON_LOOPBACK=true, but no TLS certificate is ` +
        'configured. Set KEEL_TLS_CERT and KEEL_TLS_KEY. A trading desk will not serve plaintext ' +
        'on a network interface.',
    );
  }
}
