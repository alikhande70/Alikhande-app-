import type {
  Mt5EvidenceCandidate,
  Mt5EvidenceOrderState,
  Mt5ReconcileObservation,
} from './evidence.js';
import type { Mt5HostReconcileResponse } from './host-types.js';

export class Mt5ReconcileValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Mt5ReconcileValidationError';
  }
}

type RecordLike = Record<string, unknown>;

const KINDS = new Set(['order', 'deal', 'position']);
const SIDES = new Set(['buy', 'sell']);
const ORDER_STATES = new Set<Mt5EvidenceOrderState>([
  'PENDING_SUBMIT',
  'WORKING',
  'PARTIAL',
  'FILLED',
  'CANCEL_PENDING',
  'CANCELLED',
  'REJECTED',
  'EXPIRED',
  'UNKNOWN',
]);
const UINT64_MAX = 18_446_744_073_709_551_615n;

function record(value: unknown, path: string): RecordLike {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Mt5ReconcileValidationError(`${path} must be an object`);
  }
  return value as RecordLike;
}

function booleanField(value: RecordLike, key: string, path: string): boolean {
  const field = value[key];
  if (typeof field !== 'boolean') {
    throw new Mt5ReconcileValidationError(`${path}.${key} must be boolean`);
  }
  return field;
}

function numberField(value: RecordLike, key: string, path: string): number {
  const field = value[key];
  if (typeof field !== 'number' || !Number.isFinite(field) || field < 0) {
    throw new Mt5ReconcileValidationError(`${path}.${key} must be a finite non-negative number`);
  }
  return field;
}

function stringField(value: RecordLike, key: string, path: string): string {
  const field = value[key];
  if (typeof field !== 'string' || field.length === 0) {
    throw new Mt5ReconcileValidationError(`${path}.${key} must be a non-empty string`);
  }
  return field;
}

function optionalString(value: RecordLike, key: string, path: string): string | undefined {
  const field = value[key];
  if (field === undefined) return undefined;
  if (typeof field !== 'string' || field.length === 0) {
    throw new Mt5ReconcileValidationError(`${path}.${key} must be a non-empty string when present`);
  }
  return field;
}

function unsignedIntegerText(value: RecordLike, key: string, path: string): string {
  const field = stringField(value, key, path);
  if (!/^(0|[1-9]\d*)$/.test(field)) {
    throw new Mt5ReconcileValidationError(`${path}.${key} must be an unsigned integer string`);
  }
  try {
    const parsed = BigInt(field);
    if (parsed < 0n || parsed > UINT64_MAX) throw new Error('out of range');
  } catch {
    throw new Mt5ReconcileValidationError(`${path}.${key} is outside the MT5 uint64 domain`);
  }
  return field;
}

function optionalUnsignedIntegerText(
  value: RecordLike,
  key: string,
  path: string,
): string | undefined {
  if (value[key] === undefined) return undefined;
  return unsignedIntegerText(value, key, path);
}

function decimalText(value: RecordLike, key: string, path: string): string {
  const field = stringField(value, key, path);
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(field)) {
    throw new Mt5ReconcileValidationError(`${path}.${key} must be a plain decimal string`);
  }
  return field;
}

function optionalDecimal(value: RecordLike, key: string, path: string): string | undefined {
  const field = optionalString(value, key, path);
  if (field === undefined) return undefined;
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(field)) {
    throw new Mt5ReconcileValidationError(
      `${path}.${key} must be a plain decimal string when present`,
    );
  }
  return field;
}

function parseCandidate(value: unknown, index: number): Mt5EvidenceCandidate {
  const path = `reconcile.observation.candidates[${index}]`;
  const row = record(value, path);
  const kind = stringField(row, 'kind', path);
  if (!KINDS.has(kind)) throw new Mt5ReconcileValidationError(`${path}.kind is unsupported`);
  const side = stringField(row, 'side', path);
  if (!SIDES.has(side)) throw new Mt5ReconcileValidationError(`${path}.side is unsupported`);

  const price = optionalDecimal(row, 'price', path);
  const positionId = optionalUnsignedIntegerText(row, 'positionId', path);
  const rawOrderState = optionalString(row, 'orderState', path);
  let orderState: Mt5EvidenceOrderState | undefined;

  if (kind === 'order') {
    if (rawOrderState === undefined || !ORDER_STATES.has(rawOrderState as Mt5EvidenceOrderState)) {
      throw new Mt5ReconcileValidationError(`${path}.orderState is required and must be recognised`);
    }
    orderState = rawOrderState as Mt5EvidenceOrderState;
  } else if (rawOrderState !== undefined) {
    throw new Mt5ReconcileValidationError(`${path}.orderState is forbidden for ${kind} evidence`);
  }

  return {
    kind: kind as Mt5EvidenceCandidate['kind'],
    ticket: unsignedIntegerText(row, 'ticket', path),
    magic: unsignedIntegerText(row, 'magic', path),
    symbol: stringField(row, 'symbol', path),
    side: side as Mt5EvidenceCandidate['side'],
    volume: decimalText(row, 'volume', path),
    ...(price === undefined ? {} : { price }),
    serverTime: numberField(row, 'serverTime', path),
    ...(positionId === undefined ? {} : { positionId }),
    ...(orderState === undefined ? {} : { orderState }),
  };
}

function parseObservation(value: unknown): Mt5ReconcileObservation {
  const path = 'reconcile.observation';
  const row = record(value, path);
  const candidatesRaw = row.candidates;
  if (!Array.isArray(candidatesRaw)) {
    throw new Mt5ReconcileValidationError(`${path}.candidates must be an array`);
  }
  const historyFrom = numberField(row, 'historyFrom', path);
  const historyTo = numberField(row, 'historyTo', path);
  if (historyTo < historyFrom) {
    throw new Mt5ReconcileValidationError(`${path}.historyTo must be >= historyFrom`);
  }

  return {
    observedAt: numberField(row, 'observedAt', path),
    connected: booleanField(row, 'connected', path),
    positionsScanned: booleanField(row, 'positionsScanned', path),
    ordersScanned: booleanField(row, 'ordersScanned', path),
    historySelected: booleanField(row, 'historySelected', path),
    historyFrom,
    historyTo,
    candidates: candidatesRaw.map(parseCandidate),
  };
}

export function validateMt5HostReconcileResponse(value: unknown): Mt5HostReconcileResponse {
  const row = record(value, 'reconcile');
  return { observation: parseObservation(row.observation) };
}
