export class Mt5SymbolMapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Mt5SymbolMapError';
  }
}

export type Mt5SymbolAliases = Readonly<Record<string, string>>;

function validSymbol(value: string): boolean {
  return value.length > 0 && value.length <= 64 && value.trim() === value;
}

function validCanonical(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 64 &&
    value.trim() === value &&
    /^[A-Z0-9][A-Z0-9._:/-]*$/.test(value)
  );
}

/**
 * Explicit venue-symbol -> canonical mapping.
 *
 * No suffix stripping or fuzzy matching is performed. Broker symbol names are
 * execution identifiers, so guessing that e.g. `XAUUSD.x` means `XAUUSD` would
 * be an execution-risk bug. Installation-specific aliases must be configured
 * explicitly and are validated one-to-one.
 */
export class Mt5SymbolMap {
  private readonly aliases: ReadonlyMap<string, string>;

  constructor(aliases: Mt5SymbolAliases = {}) {
    const byRaw = new Map<string, string>();
    const rawByCanonical = new Map<string, string>();

    for (const [raw, canonical] of Object.entries(aliases)) {
      if (!validSymbol(raw)) {
        throw new Mt5SymbolMapError(`invalid MT5 venue symbol alias key '${raw}'`);
      }
      if (!validCanonical(canonical)) {
        throw new Mt5SymbolMapError(`invalid canonical symbol '${canonical}' for MT5 symbol '${raw}'`);
      }
      const priorRaw = rawByCanonical.get(canonical);
      if (priorRaw !== undefined && priorRaw !== raw) {
        throw new Mt5SymbolMapError(
          `canonical symbol '${canonical}' is mapped from both '${priorRaw}' and '${raw}'`,
        );
      }
      byRaw.set(raw, canonical);
      rawByCanonical.set(canonical, raw);
    }

    this.aliases = byRaw;
  }

  canonicalFor(venueSymbol: string, hostCanonical?: string): string {
    if (!validSymbol(venueSymbol)) {
      throw new Mt5SymbolMapError(`invalid MT5 venue symbol '${venueSymbol}'`);
    }
    const explicit = this.aliases.get(venueSymbol);
    if (explicit !== undefined) return explicit;

    const fallback = hostCanonical ?? venueSymbol;
    if (!validCanonical(fallback)) {
      throw new Mt5SymbolMapError(
        `MT5 symbol '${venueSymbol}' has no explicit alias and host canonical '${fallback}' is invalid`,
      );
    }
    return fallback;
  }
}
