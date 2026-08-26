import type {
  Mt5HostAccount,
  Mt5HostInstrument,
  Mt5HostOrder,
  Mt5HostPosition,
  Mt5HostQuote,
  Mt5HostSnapshot,
} from './host-types.js';

export class Mt5SnapshotValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Mt5SnapshotValidationError';
  }
}

type RecordLike = Record<string, unknown>;

const ASSET_CLASSES = new Set(['fx', 'metal', 'index', 'commodity', 'crypto', 'equity', 'future']);
const ORDER_STATES = new Set([
  'PENDING_SUBMIT',
  'WORKING',
  'PARTIAL',
  'FILLED',
  'CANCEL_PENDING',
  'CANCELLED',
  'REJECTED',
  'UNKNOWN',
]);

function record(value: unknown, path: string): RecordLike {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Mt5SnapshotValidationError(`${path} must be an object`);
  }
  return value as RecordLike;
}

function stringField(value: RecordLike, key: string, path: string): string {
  const field = value[key];
  if (typeof field !== 'string' || field.length === 0) {
    throw new Mt5SnapshotValidationError(`${path}.${key} must be a non-empty string`);
  }
  return field;
}

function optionalString(value: RecordLike, key: string, path: string): string | undefined {
  const field = value[key];
  if (field === undefined) return undefined;
  if (typeof field !== 'string' || field.length === 0) {
    throw new Mt5SnapshotValidationError(`${path}.${key} must be a non-empty string when present`);
  }
  return field;
}

function booleanField(value: RecordLike, key: string, path: string): boolean {
  const field = value[key];
  if (typeof field !== 'boolean') {
    throw new Mt5SnapshotValidationError(`${path}.${key} must be boolean`);
  }
  return field;
}

function numberField(value: RecordLike, key: string, path: string): number {
  const field = value[key];
  if (typeof field !== 'number' || !Number.isFinite(field) || field < 0) {
    throw new Mt5SnapshotValidationError(`${path}.${key} must be a finite non-negative number`);
  }
  return field;
}

function unsignedIntegerText(value: RecordLike, key: string, path: string): string {
  const field = stringField(value, key, path);
  if (!/^(0|[1-9]\d*)$/.test(field)) {
    throw new Mt5SnapshotValidationError(`${path}.${key} must be an unsigned integer string`);
  }
  try {
    const parsed = BigInt(field);
    if (parsed < 0n || parsed > 18_446_744_073_709_551_615n) throw new Error('out of range');
  } catch {
    throw new Mt5SnapshotValidationError(`${path}.${key} is outside the MT5 uint64 domain`);
  }
  return field;
}

function decimalText(value: RecordLike, key: string, path: string): string {
  const field = stringField(value, key, path);
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(field)) {
    throw new Mt5SnapshotValidationError(`${path}.${key} must be a plain decimal string`);
  }
  return field;
}

function optionalDecimal(value: RecordLike, key: string, path: string): string | undefined {
  const field = optionalString(value, key, path);
  if (field === undefined) return undefined;
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(field)) {
    throw new Mt5SnapshotValidationError(
      `${path}.${key} must be a plain decimal string when present`,
    );
  }
  return field;
}

function oneOf<T extends string>(
  value: RecordLike,
  key: string,
  path: string,
  allowed: ReadonlySet<string>,
): T {
  const field = stringField(value, key, path);
  if (!allowed.has(field)) {
    throw new Mt5SnapshotValidationError(`${path}.${key} has unsupported value ${field}`);
  }
  return field as T;
}

function arrayField(value: RecordLike, key: string, path: string): readonly unknown[] {
  const field = value[key];
  if (!Array.isArray(field)) {
    throw new Mt5SnapshotValidationError(`${path}.${key} must be an array`);
  }
  return field;
}

function parseAccount(value: unknown): Mt5HostAccount {
  const row = record(value, 'snapshot.account');
  const tradeMode = oneOf<Mt5HostAccount['tradeMode']>(
    row,
    'tradeMode',
    'snapshot.account',
    new Set(['demo', 'contest', 'real']),
  );
  const positionModel = oneOf<Mt5HostAccount['positionModel']>(
    row,
    'positionModel',
    'snapshot.account',
    new Set(['netting', 'hedging']),
  );
  return {
    login: unsignedIntegerText(row, 'login', 'snapshot.account'),
    server: stringField(row, 'server', 'snapshot.account'),
    company: stringField(row, 'company', 'snapshot.account'),
    currency: stringField(row, 'currency', 'snapshot.account'),
    tradeMode,
    positionModel,
    balance: decimalText(row, 'balance', 'snapshot.account'),
    equity: decimalText(row, 'equity', 'snapshot.account'),
    marginUsed: decimalText(row, 'marginUsed', 'snapshot.account'),
    marginFree: decimalText(row, 'marginFree', 'snapshot.account'),
    asOf: numberField(row, 'asOf', 'snapshot.account'),
  };
}

function parseInstrument(value: unknown, index: number): Mt5HostInstrument {
  const path = `snapshot.instruments[${index}]`;
  const row = record(value, path);
  const assetClass = oneOf<Mt5HostInstrument['assetClass']>(row, 'assetClass', path, ASSET_CLASSES);
  const digits = numberField(row, 'digits', path);
  const tickValueAccount = optionalDecimal(row, 'tickValueAccount', path);
  if (!Number.isInteger(digits) || digits > 20) {
    throw new Mt5SnapshotValidationError(`${path}.digits must be an integer between 0 and 20`);
  }
  return {
    symbol: stringField(row, 'symbol', path),
    canonical: stringField(row, 'canonical', path),
    assetClass,
    base: stringField(row, 'base', path),
    quote: stringField(row, 'quote', path),
    digits,
    tickSize: decimalText(row, 'tickSize', path),
    contractSize: decimalText(row, 'contractSize', path),
    minVolume: decimalText(row, 'minVolume', path),
    maxVolume: decimalText(row, 'maxVolume', path),
    volumeStep: decimalText(row, 'volumeStep', path),
    ...(tickValueAccount === undefined ? {} : { tickValueAccount }),
    stopsLevel: decimalText(row, 'stopsLevel', path),
    freezeLevel: decimalText(row, 'freezeLevel', path),
    marginRate: decimalText(row, 'marginRate', path),
    venueTimeZone: stringField(row, 'venueTimeZone', path),
    asOf: numberField(row, 'asOf', path),
  };
}

function parsePosition(value: unknown, index: number): Mt5HostPosition {
  const path = `snapshot.positions[${index}]`;
  const row = record(value, path);
  const side = oneOf<Mt5HostPosition['side']>(row, 'side', path, new Set(['buy', 'sell']));
  const stopPrice = optionalDecimal(row, 'stopPrice', path);
  const takeProfitPrice = optionalDecimal(row, 'takeProfitPrice', path);
  const unrealisedPnl = optionalDecimal(row, 'unrealisedPnl', path);
  return {
    ticket: unsignedIntegerText(row, 'ticket', path),
    positionId: unsignedIntegerText(row, 'positionId', path),
    magic: unsignedIntegerText(row, 'magic', path),
    symbol: stringField(row, 'symbol', path),
    canonical: stringField(row, 'canonical', path),
    side,
    volume: decimalText(row, 'volume', path),
    entryPrice: decimalText(row, 'entryPrice', path),
    ...(stopPrice === undefined ? {} : { stopPrice }),
    ...(takeProfitPrice === undefined ? {} : { takeProfitPrice }),
    ...(unrealisedPnl === undefined ? {} : { unrealisedPnl }),
    openedAt: numberField(row, 'openedAt', path),
  };
}

function parseOrder(value: unknown, index: number): Mt5HostOrder {
  const path = `snapshot.orders[${index}]`;
  const row = record(value, path);
  const side = oneOf<Mt5HostOrder['side']>(row, 'side', path, new Set(['buy', 'sell']));
  const state = oneOf<Mt5HostOrder['state']>(row, 'state', path, ORDER_STATES);
  const limitPrice = optionalDecimal(row, 'limitPrice', path);
  const stopPrice = optionalDecimal(row, 'stopPrice', path);
  const avgFillPrice = optionalDecimal(row, 'avgFillPrice', path);
  return {
    ticket: unsignedIntegerText(row, 'ticket', path),
    magic: unsignedIntegerText(row, 'magic', path),
    symbol: stringField(row, 'symbol', path),
    canonical: stringField(row, 'canonical', path),
    side,
    state,
    requestedQty: decimalText(row, 'requestedQty', path),
    filledQty: decimalText(row, 'filledQty', path),
    ...(limitPrice === undefined ? {} : { limitPrice }),
    ...(stopPrice === undefined ? {} : { stopPrice }),
    ...(avgFillPrice === undefined ? {} : { avgFillPrice }),
    createdAt: numberField(row, 'createdAt', path),
  };
}

function parseQuote(value: unknown, index: number): Mt5HostQuote {
  const path = `snapshot.quotes[${index}]`;
  const row = record(value, path);
  return {
    canonical: stringField(row, 'canonical', path),
    bid: decimalText(row, 'bid', path),
    ask: decimalText(row, 'ask', path),
    asOf: numberField(row, 'asOf', path),
  };
}

export function validateMt5HostSnapshot(value: unknown): Mt5HostSnapshot {
  const row = record(value, 'snapshot');
  if (row.protocolVersion !== 1) {
    throw new Mt5SnapshotValidationError('snapshot.protocolVersion must equal 1');
  }
  const instruments = arrayField(row, 'instruments', 'snapshot').map(parseInstrument);
  const positions = arrayField(row, 'positions', 'snapshot').map(parsePosition);
  const orders = arrayField(row, 'orders', 'snapshot').map(parseOrder);
  const quotes = arrayField(row, 'quotes', 'snapshot').map(parseQuote);
  return {
    protocolVersion: 1,
    hostId: stringField(row, 'hostId', 'snapshot'),
    terminalConnected: booleanField(row, 'terminalConnected', 'snapshot'),
    tradeAllowed: booleanField(row, 'tradeAllowed', 'snapshot'),
    account: parseAccount(row.account),
    instruments,
    positions,
    orders,
    quotes,
    observedAt: numberField(row, 'observedAt', 'snapshot'),
  };
}
