import type {
  Mt5HostCancelRequest,
  Mt5HostCloseRequest,
  Mt5HostModifyRequest,
  Mt5HostOrderRequest,
  Mt5HostReconcileRequest,
} from './host-types.js';
import type { Mt5MarginRequest } from './margin-wire.js';

export class Mt5CommandValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Mt5CommandValidationError';
  }
}

type CommandName =
  | 'snapshot'
  | 'calc_margin'
  | 'place_order'
  | 'cancel_order'
  | 'modify_position'
  | 'close_position'
  | 'reconcile';

export type ValidatedMt5Command =
  | { readonly command: 'snapshot'; readonly payload: Record<string, never> }
  | { readonly command: 'calc_margin'; readonly payload: Mt5MarginRequest }
  | { readonly command: 'place_order'; readonly payload: Mt5HostOrderRequest }
  | { readonly command: 'cancel_order'; readonly payload: Mt5HostCancelRequest }
  | { readonly command: 'modify_position'; readonly payload: Mt5HostModifyRequest }
  | { readonly command: 'close_position'; readonly payload: Mt5HostCloseRequest }
  | { readonly command: 'reconcile'; readonly payload: Mt5HostReconcileRequest };

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Mt5CommandValidationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== 'string' || field.trim().length === 0) {
    throw new Mt5CommandValidationError(`${key} must be a non-empty string`);
  }
  return field;
}

function optionalText(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  if (field === undefined) return undefined;
  if (typeof field !== 'string' || field.trim().length === 0) {
    throw new Mt5CommandValidationError(`${key} must be a non-empty string when supplied`);
  }
  return field;
}

const unsignedInteger = /^(0|[1-9][0-9]*)$/;
const nonNegativeDecimal = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
const zeroDecimal = /^0(?:\.0+)?$/;

function unsigned(value: Record<string, unknown>, key: string): string {
  const field = text(value, key);
  if (!unsignedInteger.test(field)) {
    throw new Mt5CommandValidationError(`${key} must be an unsigned decimal integer string`);
  }
  return field;
}

function decimal(value: Record<string, unknown>, key: string, allowZero = false): string {
  const field = text(value, key);
  if (!nonNegativeDecimal.test(field)) {
    throw new Mt5CommandValidationError(`${key} must be a plain non-negative decimal string`);
  }
  if (!allowZero && zeroDecimal.test(field)) {
    throw new Mt5CommandValidationError(`${key} must be greater than zero`);
  }
  return field;
}

function optionalDecimal(value: Record<string, unknown>, key: string): string | undefined {
  const field = optionalText(value, key);
  if (field === undefined) return undefined;
  if (!nonNegativeDecimal.test(field) || zeroDecimal.test(field)) {
    throw new Mt5CommandValidationError(`${key} must be a positive plain decimal string`);
  }
  return field;
}

function finiteTime(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  if (typeof field !== 'number' || !Number.isFinite(field) || field < 0) {
    throw new Mt5CommandValidationError(
      `${key} must be a finite non-negative millisecond timestamp`,
    );
  }
  return field;
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw new Mt5CommandValidationError(`unexpected MT5 command field(s): ${unknown.join(', ')}`);
  }
}

function validateSide(value: Record<string, unknown>): 'buy' | 'sell' {
  const side = value.side;
  if (side !== 'buy' && side !== 'sell') {
    throw new Mt5CommandValidationError('side must be buy or sell');
  }
  return side;
}

function validateKind(
  value: Record<string, unknown>,
): 'market' | 'limit' | 'stop' | 'stop_limit' {
  const kind = value.kind;
  if (kind !== 'market' && kind !== 'limit' && kind !== 'stop' && kind !== 'stop_limit') {
    throw new Mt5CommandValidationError('kind must be market, limit, stop, or stop_limit');
  }
  return kind;
}

function validateMargin(payload: unknown): Mt5MarginRequest {
  const value = record(payload, 'calc_margin payload');
  rejectUnknownKeys(value, ['symbol', 'side', 'kind', 'volume', 'price']);
  return {
    symbol: text(value, 'symbol'),
    side: validateSide(value),
    kind: validateKind(value),
    volume: decimal(value, 'volume'),
    price: decimal(value, 'price'),
  };
}

function validatePlaceOrder(payload: unknown): Mt5HostOrderRequest {
  const value = record(payload, 'place_order payload');
  rejectUnknownKeys(value, [
    'clientOrderId',
    'magic',
    'symbol',
    'side',
    'kind',
    'volume',
    'limitPrice',
    'stopTriggerPrice',
    'stopLoss',
    'takeProfit',
    'timeInForce',
    'maxSlippage',
  ]);

  const side = validateSide(value);
  const kind = validateKind(value);

  const limitPrice = optionalDecimal(value, 'limitPrice');
  const stopTriggerPrice = optionalDecimal(value, 'stopTriggerPrice');
  const stopLoss = optionalDecimal(value, 'stopLoss');
  const takeProfit = optionalDecimal(value, 'takeProfit');
  const maxSlippage = optionalDecimal(value, 'maxSlippage');
  if ((kind === 'limit' || kind === 'stop_limit') && limitPrice === undefined) {
    throw new Mt5CommandValidationError(`${kind} order requires limitPrice`);
  }
  if ((kind === 'stop' || kind === 'stop_limit') && stopTriggerPrice === undefined) {
    throw new Mt5CommandValidationError(`${kind} order requires stopTriggerPrice`);
  }

  return {
    clientOrderId: text(value, 'clientOrderId'),
    magic: unsigned(value, 'magic'),
    symbol: text(value, 'symbol'),
    side,
    kind,
    volume: decimal(value, 'volume'),
    ...(limitPrice === undefined ? {} : { limitPrice }),
    ...(stopTriggerPrice === undefined ? {} : { stopTriggerPrice }),
    ...(stopLoss === undefined ? {} : { stopLoss }),
    ...(takeProfit === undefined ? {} : { takeProfit }),
    timeInForce: text(value, 'timeInForce'),
    ...(maxSlippage === undefined ? {} : { maxSlippage }),
  };
}

function validateCancel(payload: unknown): Mt5HostCancelRequest {
  const value = record(payload, 'cancel_order payload');
  rejectUnknownKeys(value, ['orderTicket', 'clientOrderId', 'magic']);
  return {
    orderTicket: unsigned(value, 'orderTicket'),
    clientOrderId: text(value, 'clientOrderId'),
    magic: unsigned(value, 'magic'),
  };
}

function validateModify(payload: unknown): Mt5HostModifyRequest {
  const value = record(payload, 'modify_position payload');
  rejectUnknownKeys(value, ['positionId', 'stopLoss', 'takeProfit']);
  const stopLoss = optionalDecimal(value, 'stopLoss');
  const takeProfit = optionalDecimal(value, 'takeProfit');
  if (stopLoss === undefined && takeProfit === undefined) {
    throw new Mt5CommandValidationError('modify_position requires stopLoss or takeProfit');
  }
  return {
    positionId: unsigned(value, 'positionId'),
    ...(stopLoss === undefined ? {} : { stopLoss }),
    ...(takeProfit === undefined ? {} : { takeProfit }),
  };
}

function validateClose(payload: unknown): Mt5HostCloseRequest {
  const value = record(payload, 'close_position payload');
  rejectUnknownKeys(value, ['positionId', 'volume', 'clientOrderId', 'magic']);
  const volume = optionalDecimal(value, 'volume');
  return {
    positionId: unsigned(value, 'positionId'),
    ...(volume === undefined ? {} : { volume }),
    clientOrderId: text(value, 'clientOrderId'),
    magic: unsigned(value, 'magic'),
  };
}

function validateReconcile(payload: unknown): Mt5HostReconcileRequest {
  const value = record(payload, 'reconcile payload');
  rejectUnknownKeys(value, ['magic', 'symbol', 'side', 'volume', 'sentNotBefore', 'sentNotAfter']);
  const side = validateSide(value);
  const sentNotBefore = finiteTime(value, 'sentNotBefore');
  const sentNotAfter = finiteTime(value, 'sentNotAfter');
  if (sentNotAfter < sentNotBefore) {
    throw new Mt5CommandValidationError(
      'sentNotAfter must be greater than or equal to sentNotBefore',
    );
  }
  return {
    magic: unsigned(value, 'magic'),
    symbol: text(value, 'symbol'),
    side,
    volume: decimal(value, 'volume'),
    sentNotBefore,
    sentNotAfter,
  };
}

/**
 * Validates the exact desk -> EA payload before it can cross the execution boundary.
 * The EA still validates independently; this is defense in depth and prevents malformed
 * commands from ever entering the transport/journal path.
 */
export function validateMt5Command(command: CommandName, payload: unknown): ValidatedMt5Command {
  switch (command) {
    case 'snapshot': {
      const value = record(payload, 'snapshot payload');
      rejectUnknownKeys(value, []);
      return { command, payload: {} };
    }
    case 'calc_margin':
      return { command, payload: validateMargin(payload) };
    case 'place_order':
      return { command, payload: validatePlaceOrder(payload) };
    case 'cancel_order':
      return { command, payload: validateCancel(payload) };
    case 'modify_position':
      return { command, payload: validateModify(payload) };
    case 'close_position':
      return { command, payload: validateClose(payload) };
    case 'reconcile':
      return { command, payload: validateReconcile(payload) };
  }
}
