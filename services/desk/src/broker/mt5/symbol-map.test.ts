import { describe, expect, it } from 'vitest';
import { Mt5SymbolMap, Mt5SymbolMapError } from './symbol-map.js';

describe('Mt5SymbolMap', () => {
  it('uses an explicit installation-specific venue alias', () => {
    const map = new Mt5SymbolMap({ 'XAUUSD.x': 'XAUUSD' });
    expect(map.canonicalFor('XAUUSD.x', 'XAUUSD.x')).toBe('XAUUSD');
  });

  it('preserves a valid host canonical when no alias is configured', () => {
    const map = new Mt5SymbolMap();
    expect(map.canonicalFor('EURUSD', 'EURUSD')).toBe('EURUSD');
  });

  it('never guesses by stripping broker suffixes', () => {
    const map = new Mt5SymbolMap();
    expect(map.canonicalFor('XAUUSD.x', 'XAUUSD.X')).toBe('XAUUSD.X');
  });

  it('rejects two venue symbols mapped to the same canonical execution identity', () => {
    expect(() => new Mt5SymbolMap({ 'XAUUSD.a': 'XAUUSD', 'XAUUSD.b': 'XAUUSD' })).toThrow(
      Mt5SymbolMapError,
    );
  });

  it('rejects invalid fallback canonical values instead of normalising them silently', () => {
    const map = new Mt5SymbolMap();
    expect(() => map.canonicalFor('XAUUSD.x', 'xau usd')).toThrow(Mt5SymbolMapError);
  });
});
