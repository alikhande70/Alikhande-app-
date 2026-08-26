import { describe, expect, it } from 'vitest';
import type { Mt5HostInstrument } from './host-types.js';
import { Mt5InstrumentBinding, Mt5InstrumentBindingError } from './instrument-binding.js';
import { Mt5SymbolMap } from './symbol-map.js';

const RAW: Mt5HostInstrument = {
  symbol: 'XAUUSD.x',
  canonical: 'XAUUSD.x',
  assetClass: 'metal',
  base: 'XAU',
  quote: 'USD',
  digits: 2,
  tickSize: '0.01',
  contractSize: '100',
  minVolume: '0.01',
  maxVolume: '100',
  volumeStep: '0.01',
  tickValueAccount: '1',
  stopsLevel: '0.10',
  freezeLevel: '0.00',
  marginRate: '0.01',
  venueTimeZone: 'Etc/UTC',
  asOf: 1_700_000_000_000,
};

describe('Mt5InstrumentBinding', () => {
  it('uses explicit symbol aliases and semantic metadata while preserving MT5 numeric facts', () => {
    const binding = new Mt5InstrumentBinding(new Mt5SymbolMap({ 'XAUUSD.x': 'XAUUSD' }), {
      XAUUSD: {
        assetClass: 'metal',
        base: 'XAU',
        quote: 'USD',
        venueTimeZone: 'Etc/UTC',
      },
    });

    const spec = binding.toInstrumentSpec(RAW, 'hedging');
    expect(spec.symbol).toBe('XAUUSD.x');
    expect(spec.canonical).toBe('XAUUSD');
    expect(spec.assetClass).toBe('metal');
    expect(spec.base).toBe('XAU');
    expect(spec.quote).toBe('USD');
    expect(spec.positionModel).toBe('hedging');
    expect(spec.contractSize).toEqual({ v: 100n, s: 0 });
    expect(spec.tickSize).toEqual({ v: 1n, s: 2 });
  });

  it('fails closed when a venue symbol has no configured semantic metadata', () => {
    const binding = new Mt5InstrumentBinding(new Mt5SymbolMap({ 'XAUUSD.x': 'XAUUSD' }));
    expect(() => binding.toInstrumentSpec(RAW, 'netting')).toThrow(Mt5InstrumentBindingError);
  });

  it('does not trust semantic fields supplied by the host when explicit metadata disagrees', () => {
    const binding = new Mt5InstrumentBinding(new Mt5SymbolMap({ 'XAUUSD.x': 'XAUUSD' }), {
      XAUUSD: {
        assetClass: 'commodity',
        base: 'GOLD',
        quote: 'USD',
        venueTimeZone: 'Europe/Berlin',
      },
    });

    const spec = binding.toInstrumentSpec(RAW, 'netting');
    expect(spec.assetClass).toBe('commodity');
    expect(spec.base).toBe('GOLD');
    expect(spec.venueTimeZone).toBe('Europe/Berlin');
  });

  it('rejects malformed configured metadata instead of normalising it', () => {
    expect(
      () =>
        new Mt5InstrumentBinding(new Mt5SymbolMap(), {
          XAUUSD: {
            assetClass: 'metal',
            base: ' XAU',
            quote: 'USD',
            venueTimeZone: 'Etc/UTC',
          },
        }),
    ).toThrow(Mt5InstrumentBindingError);
  });
});

describe('canonical collision', () => {
  const facts = (symbol: string) => ({
    symbol,
    digits: 2,
    point: '0.01',
    tickSize: '0.01',
    contractSize: '100',
    minVolume: '0.01',
    maxVolume: '50',
    volumeStep: '0.01',
    stopsLevel: '0',
    freezeLevel: '0',
    tradeMode: 4,
    asOf: 1_000,
  });

  it('refuses a snapshot where an alias collides with an unaliased symbol', () => {
    // The realistic case. The operator aliases the suffixed symbol so it reads
    // as XAUUSD -- and the terminal also lists a plain XAUUSD, which maps to
    // itself. Mt5SymbolMap only enforces uniqueness *among aliases*, so nothing
    // caught the two meeting. getQuote resolves by first match, so sizing would
    // price one instrument off the other's book with array order deciding which.
    const binding = new Mt5InstrumentBinding(new Mt5SymbolMap({ 'XAUUSD.x': 'XAUUSD' }), {
      XAUUSD: { assetClass: 'metal', base: 'XAU', quote: 'USD', venueTimeZone: 'Europe/Riga' },
    });
    expect(() =>
      binding.toInstrumentSpecs([facts('XAUUSD'), facts('XAUUSD.x')], 'netting'),
    ).toThrow(/both resolve to canonical/);
  });

  it('accepts distinct canonicals in one snapshot', () => {
    const binding = new Mt5InstrumentBinding(new Mt5SymbolMap({ 'XAUUSD.x': 'XAUUSDX' }), {
      XAUUSD: { assetClass: 'metal', base: 'XAU', quote: 'USD', venueTimeZone: 'Europe/Riga' },
      XAUUSDX: { assetClass: 'metal', base: 'XAU', quote: 'USD', venueTimeZone: 'Europe/Riga' },
    });
    const specs = binding.toInstrumentSpecs([facts('XAUUSD'), facts('XAUUSD.x')], 'netting');
    expect(specs.map((spec) => spec.canonical)).toEqual(['XAUUSD', 'XAUUSDX']);
  });

  it('never publishes a marginRate, because MT5 does not provide one', () => {
    const binding = new Mt5InstrumentBinding(new Mt5SymbolMap(), {
      XAUUSD: { assetClass: 'metal', base: 'XAU', quote: 'USD', venueTimeZone: 'Europe/Riga' },
    });
    const [spec] = binding.toInstrumentSpecs([facts('XAUUSD')], 'netting');
    expect(spec?.marginRate).toBeUndefined();
  });
});
