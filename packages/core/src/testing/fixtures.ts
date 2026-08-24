import { dec } from '../money/decimal.js';
import type { InstrumentSpec } from '../market/instrument.js';

/**
 * Instrument fixtures modelled on real MetaTrader 5 / venue specifications.
 * Used by tests and by the paper broker. Values are representative of a typical
 * retail ECN account; a live desk always reads the real spec from the venue.
 */

const BASE_TIME = Date.UTC(2026, 7, 24, 12, 0, 0);

export const XAUUSD: InstrumentSpec = {
  symbol: 'XAUUSD',
  canonical: 'XAUUSD',
  assetClass: 'metal',
  base: 'XAU',
  quote: 'USD',
  digits: 2,
  tickSize: dec('0.01'),
  contractSize: dec('100'), // 100 troy ounces per lot
  minVolume: dec('0.01'),
  maxVolume: dec('50.00'),
  volumeStep: dec('0.01'),
  stopsLevel: dec('0.30'),
  freezeLevel: dec('0.00'),
  marginRate: dec('0.005'), // 200:1
  positionModel: 'hedging',
  venueTimeZone: 'Europe/Athens', // typical MT5 broker server time, GMT+2/+3
  asOf: BASE_TIME,
};

export const EURUSD: InstrumentSpec = {
  symbol: 'EURUSD',
  canonical: 'EURUSD',
  assetClass: 'fx',
  base: 'EUR',
  quote: 'USD',
  digits: 5,
  tickSize: dec('0.00001'),
  contractSize: dec('100000'),
  minVolume: dec('0.01'),
  maxVolume: dec('100.00'),
  volumeStep: dec('0.01'),
  stopsLevel: dec('0.00000'),
  freezeLevel: dec('0.00000'),
  marginRate: dec('0.0033'),
  positionModel: 'hedging',
  venueTimeZone: 'Europe/Athens',
  asOf: BASE_TIME,
};

export const USDJPY: InstrumentSpec = {
  ...EURUSD,
  symbol: 'USDJPY',
  canonical: 'USDJPY',
  base: 'USD',
  quote: 'JPY',
  digits: 3,
  tickSize: dec('0.001'),
  stopsLevel: dec('0.000'),
  freezeLevel: dec('0.000'),
};

/** The instrument that exposes account-currency conversion bugs: quote is JPY. */
export const GBPJPY: InstrumentSpec = {
  ...USDJPY,
  symbol: 'GBPJPY',
  canonical: 'GBPJPY',
  base: 'GBP',
  quote: 'JPY',
};

export const BTCUSD_PERP: InstrumentSpec = {
  symbol: 'BTCUSD-PERP',
  canonical: 'BTCUSD',
  assetClass: 'crypto',
  base: 'BTC',
  quote: 'USD',
  digits: 1,
  tickSize: dec('0.1'),
  contractSize: dec('1'),
  minVolume: dec('0.0001'),
  maxVolume: dec('100.0000'),
  volumeStep: dec('0.0001'),
  stopsLevel: dec('0.0'),
  freezeLevel: dec('0.0'),
  marginRate: dec('0.02'), // 50:1
  positionModel: 'netting',
  venueTimeZone: 'UTC',
  asOf: BASE_TIME,
};

export const ALL_FIXTURES = [XAUUSD, EURUSD, USDJPY, GBPJPY, BTCUSD_PERP] as const;

export const FIXTURE_TIME = BASE_TIME;
