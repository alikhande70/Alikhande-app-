import type { AssetClass, InstrumentSpec, PositionModel } from '@keel/core';
import * as D from '@keel/core';
import type { Mt5HostInstrument } from './host-types.js';
import type { Mt5SymbolMap } from './symbol-map.js';

export class Mt5InstrumentBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Mt5InstrumentBindingError';
  }
}

/**
 * Metadata that MT5 does not expose with semantics strong enough for Keel to
 * treat as broker truth. It must therefore be configured explicitly per
 * canonical instrument instead of guessed from the venue symbol.
 */
export interface Mt5InstrumentMetadata {
  readonly assetClass: AssetClass;
  readonly base: string;
  readonly quote: string;
  readonly venueTimeZone: string;
}

export type Mt5InstrumentMetadataByCanonical = Readonly<Record<string, Mt5InstrumentMetadata>>;

function validCode(value: string): boolean {
  return value.length > 0 && value.length <= 32 && value.trim() === value;
}

function validTimeZone(value: string): boolean {
  return value.length > 0 && value.length <= 128 && value.trim() === value;
}

function validateMetadata(canonical: string, metadata: Mt5InstrumentMetadata): void {
  if (!validCode(metadata.base)) {
    throw new Mt5InstrumentBindingError(`invalid base code for MT5 canonical '${canonical}'`);
  }
  if (!validCode(metadata.quote)) {
    throw new Mt5InstrumentBindingError(`invalid quote code for MT5 canonical '${canonical}'`);
  }
  if (!validTimeZone(metadata.venueTimeZone)) {
    throw new Mt5InstrumentBindingError(`invalid venue timezone for MT5 canonical '${canonical}'`);
  }
}

/**
 * Binds venue-reported numerical instrument facts to installation-specific
 * semantic metadata.
 *
 * Numeric execution constraints still come from MT5. Semantic fields that MT5
 * cannot prove reliably (asset class and session timezone in particular) come
 * only from explicit configuration. Missing metadata blocks publication of an
 * InstrumentSpec rather than inventing plausible values from a symbol name.
 */
export class Mt5InstrumentBinding {
  private readonly symbolMap: Mt5SymbolMap;
  private readonly metadata: ReadonlyMap<string, Mt5InstrumentMetadata>;

  constructor(symbolMap: Mt5SymbolMap, metadata: Mt5InstrumentMetadataByCanonical = {}) {
    this.symbolMap = symbolMap;
    const rows = new Map<string, Mt5InstrumentMetadata>();
    for (const [canonical, row] of Object.entries(metadata)) {
      validateMetadata(canonical, row);
      rows.set(canonical, row);
    }
    this.metadata = rows;
  }

  canonicalFor(venueSymbol: string, hostCanonical?: string): string {
    return this.symbolMap.canonicalFor(venueSymbol, hostCanonical);
  }

  /**
   * Bind a whole snapshot, refusing any batch in which two venue symbols resolve
   * to the same canonical.
   *
   * `Mt5SymbolMap` enforces one-to-one only across *configured* aliases. An
   * unconfigured symbol falls back to the host-declared canonical, so a terminal
   * carrying both `XAUUSD` and `XAUUSD.x` -- each declaring canonical `XAUUSD` --
   * produces two specs with one identity. Nothing downstream deduplicates them:
   * `getQuote` resolves by first match, so sizing would silently price one
   * instrument off the other's book, and which one won would depend on array
   * order. Fail the batch instead; a collision is a configuration error the
   * operator must resolve, not something to pick a winner for.
   */
  toInstrumentSpecs(
    raws: readonly Mt5HostInstrument[],
    positionModel: PositionModel,
  ): readonly InstrumentSpec[] {
    const specs = raws.map((raw) => this.toInstrumentSpec(raw, positionModel));
    const byCanonical = new Map<string, string>();
    for (const spec of specs) {
      const priorSymbol = byCanonical.get(spec.canonical);
      if (priorSymbol !== undefined && priorSymbol !== spec.symbol) {
        throw new Mt5InstrumentBindingError(
          `MT5 symbols '${priorSymbol}' and '${spec.symbol}' both resolve to canonical ` +
            `'${spec.canonical}'. Configure an explicit alias for each so they cannot be ` +
            'reconciled or priced against one another.',
        );
      }
      byCanonical.set(spec.canonical, spec.symbol);
    }
    return specs;
  }

  toInstrumentSpec(raw: Mt5HostInstrument, positionModel: PositionModel): InstrumentSpec {
    const canonical = this.canonicalFor(raw.symbol, raw.canonical);
    const metadata = this.metadata.get(canonical);
    if (metadata === undefined) {
      throw new Mt5InstrumentBindingError(
        `MT5 instrument '${raw.symbol}' resolves to '${canonical}' but has no explicit semantic metadata`,
      );
    }

    // Host-provided semantic fields are deliberately ignored here. Older host
    // protocol versions carried them, but trusting them would re-introduce the
    // symbol-name guessing that this binding is intended to eliminate.
    return {
      symbol: raw.symbol,
      canonical,
      assetClass: metadata.assetClass,
      base: metadata.base,
      quote: metadata.quote,
      digits: raw.digits,
      tickSize: D.dec(raw.tickSize),
      contractSize: D.dec(raw.contractSize),
      minVolume: D.dec(raw.minVolume),
      maxVolume: D.dec(raw.maxVolume),
      volumeStep: D.dec(raw.volumeStep),
      ...(raw.tickValueAccount === undefined
        ? {}
        : { tickValueAccount: D.dec(raw.tickValueAccount) }),
      stopsLevel: D.dec(raw.stopsLevel),
      freezeLevel: D.dec(raw.freezeLevel),
      marginRate: D.dec(raw.marginRate),
      positionModel,
      venueTimeZone: metadata.venueTimeZone,
      asOf: raw.asOf,
    };
  }
}
