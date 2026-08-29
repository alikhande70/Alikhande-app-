import type { Dec } from '../money/decimal.js';
import * as D from '../money/decimal.js';
import type { DrawdownConfig } from './drawdown.js';

/**
 * The rules the operator commits to when calm, enforced when they are not.
 *
 * Every field is a decision made in advance. Changing one is a ledger event, so
 * the system can always answer "what were my limits when I placed that trade?" —
 * which is the difference between a journal and an alibi.
 */

export interface CorrelationGroup {
  readonly id: string;
  readonly label: string;
  /** Canonical instrument ids in this group. */
  readonly members: readonly string[];
  /** Combined open risk cap for the group, as a fraction of equity. */
  readonly maxRiskPct: Dec;
}

export interface SessionWindowRule {
  /** Sessions in which entries are permitted. Empty means no session restriction. */
  readonly allowed: readonly ('sydney' | 'tokyo' | 'london' | 'newyork')[];
  /** Block entries during the daily rollover, when spreads widen sharply. */
  readonly blockRollover: boolean;
  /** Block entries while the venue reports the market closed. */
  readonly requireMarketOpen: boolean;
}

export interface NewsBlackoutRule {
  readonly enabled: boolean;
  readonly minutesBefore: number;
  readonly minutesAfter: number;
  /** Minimum impact to trigger a blackout. */
  readonly minImpact: 'low' | 'medium' | 'high';
}

export interface RiskPolicy {
  readonly version: number;
  readonly accountCurrency: string;

  /** Default risk per trade, as a fraction of equity. */
  readonly defaultRiskPct: Dec;
  /** Hard ceiling on a single trade's risk. Overrides any ticket input. */
  readonly maxRiskPctPerTrade: Dec;
  /** Combined risk across all open positions. */
  readonly maxOpenRiskPct: Dec;
  /** Loss allowed within one trading day before all entries stop. */
  readonly maxDailyLossPct: Dec;

  readonly maxConcurrentPositions: number;
  readonly maxTradesPerDay: number;
  /** After this many consecutive losses, entries pause for `cooldownMinutes`. */
  readonly lossStreakLimit: number;
  readonly cooldownMinutes: number;

  readonly correlationGroups: readonly CorrelationGroup[];
  readonly sessions: SessionWindowRule;
  readonly news: NewsBlackoutRule;
  readonly drawdown: DrawdownConfig;

  /** Instruments the operator has decided to trade. Anything else is refused. */
  readonly allowedInstruments: readonly string[];
  /** Per-instrument volume ceilings, keyed by canonical id. */
  readonly instrumentMaxVolume: Readonly<Record<string, Dec>>;

  /** Refuse any entry without a stop. */
  readonly requireStopLoss: boolean;
  /** Refuse any entry without a written pre-trade note. */
  readonly requirePreTradeNote: boolean;
  /** Refuse when the spread exceeds this multiple of the instrument's typical spread. */
  readonly maxSpreadMultiple: Dec;
  /** Refuse when the execution quote is older than this. */
  readonly maxQuoteAgeMs: number;
  /** Free margin that must remain after the trade, as a fraction of equity. */
  readonly minFreeMarginPct: Dec;
  /** Reject a materially identical intent seen within this window (double-tap guard). */
  readonly duplicateIntentWindowMs: number;

  /** IANA zone and local time at which the trading day resets. */
  readonly dayBoundaryTimeZone: string;
  readonly dayBoundaryLocalTime: string;
}

/**
 * A starting policy sized for a funded FX/gold account. Conservative on purpose:
 * the defaults should be ones the operator loosens deliberately, not ones they
 * discover were too loose after a breach.
 */
export function defaultRiskPolicy(overrides: Partial<RiskPolicy> = {}): RiskPolicy {
  const base: RiskPolicy = {
    version: 1,
    accountCurrency: 'USD',
    defaultRiskPct: D.dec('0.005'),
    maxRiskPctPerTrade: D.dec('0.01'),
    maxOpenRiskPct: D.dec('0.02'),
    maxDailyLossPct: D.dec('0.03'),
    maxConcurrentPositions: 3,
    maxTradesPerDay: 5,
    lossStreakLimit: 3,
    cooldownMinutes: 60,
    correlationGroups: [
      {
        id: 'usd-short',
        label: 'Short USD',
        members: ['EURUSD', 'GBPUSD', 'AUDUSD', 'NZDUSD', 'XAUUSD'],
        maxRiskPct: D.dec('0.015'),
      },
      {
        id: 'jpy-cross',
        label: 'JPY crosses',
        members: ['USDJPY', 'EURJPY', 'GBPJPY', 'AUDJPY'],
        maxRiskPct: D.dec('0.015'),
      },
      {
        id: 'metals',
        label: 'Precious metals',
        members: ['XAUUSD', 'XAGUSD'],
        maxRiskPct: D.dec('0.015'),
      },
    ],
    sessions: {
      allowed: ['london', 'newyork'],
      blockRollover: true,
      requireMarketOpen: true,
    },
    news: { enabled: true, minutesBefore: 5, minutesAfter: 5, minImpact: 'high' },
    drawdown: {
      model: { kind: 'trailing-eod', amount: D.dec('600.00') },
      basis: 'balance',
      lockAtStartingBalance: true,
      startingBalance: D.dec('10000.00'),
      breachAction: 'soft',
      warnAtRemainingFraction: D.dec('0.25'),
      dayBoundaryTimeZone: 'America/New_York',
      dayBoundaryLocalTime: '17:00',
    },
    allowedInstruments: ['XAUUSD', 'EURUSD', 'GBPUSD', 'USDJPY', 'GBPJPY'],
    instrumentMaxVolume: { XAUUSD: D.dec('2.00'), EURUSD: D.dec('5.00') },
    requireStopLoss: true,
    requirePreTradeNote: true,
    maxSpreadMultiple: D.dec('3.0'),
    maxQuoteAgeMs: 3_000,
    minFreeMarginPct: D.dec('0.30'),
    duplicateIntentWindowMs: 10_000,
    dayBoundaryTimeZone: 'America/New_York',
    dayBoundaryLocalTime: '17:00',
  };
  return { ...base, ...overrides };
}
