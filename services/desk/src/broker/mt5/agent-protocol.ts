import { StringDecoder } from 'node:string_decoder';
import type { Mt5HostSnapshot, Mt5HostSubmitResult } from './host-types.js';

export const MT5_AGENT_PROTOCOL_VERSION = 1 as const;
export const MT5_AGENT_MAX_LINE_BYTES = 256 * 1024;

export interface Mt5AgentHello {
  readonly type: 'hello';
  readonly protocolVersion: 1;
  readonly token: string;
  readonly agentId: string;
  readonly terminalBuild: number;
  readonly accountLogin: string;
  readonly server: string;
  readonly tradeMode: 'demo' | 'contest' | 'real';
  readonly positionModel: 'netting' | 'hedging';
  readonly agentEpoch?: string;
  readonly at: number;
}

export interface Mt5AgentHeartbeat {
  readonly type: 'heartbeat';
  readonly serverMillis?: number;
  readonly serverUtcOffsetSec?: number;
  readonly eventSeq: string;
  readonly terminalConnected: boolean;
  readonly tradeAllowed: boolean;
  readonly serverTime: number;
  readonly at: number;
}

export interface Mt5AgentSnapshotMessage {
  readonly type: 'snapshot';
  readonly requestId: string;
  readonly eventSeq: string;
  readonly snapshot: Mt5HostSnapshot;
}

export interface Mt5AgentTransactionMessage {
  readonly type: 'transaction';
  readonly eventSeq: string;
  readonly validTime: number;
  readonly transactionType: string;
  readonly orderTicket?: string;
  readonly dealTicket?: string;
  readonly positionId?: string;
  readonly symbol?: string;
  readonly magic?: string;
  readonly volume?: string;
  readonly price?: string;
}

export interface Mt5AgentResultMessage {
  readonly type: 'result';
  readonly requestId: string;
  readonly result: Mt5HostSubmitResult;
}

export type Mt5AgentMessage =
  | Mt5AgentHello
  | Mt5AgentHeartbeat
  | Mt5AgentSnapshotMessage
  | Mt5AgentTransactionMessage
  | Mt5AgentResultMessage;

export interface Mt5DeskCommandMessage {
  readonly type: 'command';
  readonly protocolVersion: 1;
  readonly requestId: string;
  readonly command:
    | 'snapshot'
    | 'calc_margin'
    | 'place_order'
    | 'cancel_order'
    | 'modify_position'
    | 'close_position'
    | 'reconcile';
  readonly payload: unknown;
}

export class Mt5AgentProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Mt5AgentProtocolError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== 'string' || field.length === 0) {
    throw new Mt5AgentProtocolError(`MT5 agent message requires non-empty string ${key}`);
  }
  return field;
}

function requiredNumber(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  if (typeof field !== 'number' || !Number.isFinite(field)) {
    throw new Mt5AgentProtocolError(`MT5 agent message requires finite number ${key}`);
  }
  return field;
}

function optionalString(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  if (field === undefined) return undefined;
  if (typeof field !== 'string') {
    throw new Mt5AgentProtocolError(`MT5 agent message field ${key} must be a string`);
  }
  return field;
}

function parseSequence(value: Record<string, unknown>): string {
  const seq = requiredString(value, 'eventSeq');
  try {
    if (BigInt(seq) < 0n) throw new Error('negative');
  } catch {
    throw new Mt5AgentProtocolError('MT5 eventSeq must be an unsigned decimal integer string');
  }
  return seq;
}

export function decodeAgentMessage(line: string): Mt5AgentMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Mt5AgentProtocolError('MT5 agent sent invalid JSON');
  }
  if (!isRecord(parsed)) throw new Mt5AgentProtocolError('MT5 agent message must be an object');

  switch (parsed.type) {
    case 'hello': {
      if (parsed.protocolVersion !== MT5_AGENT_PROTOCOL_VERSION) {
        throw new Mt5AgentProtocolError('unsupported MT5 agent protocol version');
      }
      const tradeMode = parsed.tradeMode;
      if (tradeMode !== 'demo' && tradeMode !== 'contest' && tradeMode !== 'real') {
        throw new Mt5AgentProtocolError('invalid MT5 account trade mode');
      }
      const positionModel = parsed.positionModel;
      if (positionModel !== 'netting' && positionModel !== 'hedging') {
        throw new Mt5AgentProtocolError('invalid MT5 position model');
      }
      return {
        type: 'hello',
        protocolVersion: 1,
        token: requiredString(parsed, 'token'),
        agentId: requiredString(parsed, 'agentId'),
        terminalBuild: requiredNumber(parsed, 'terminalBuild'),
        accountLogin: requiredString(parsed, 'accountLogin'),
        server: requiredString(parsed, 'server'),
        tradeMode,
        positionModel,
        at: requiredNumber(parsed, 'at'),
        ...(typeof parsed.agentEpoch === 'string' && /^[0-9]+$/.test(parsed.agentEpoch)
          ? { agentEpoch: parsed.agentEpoch }
          : {}),
      };
    }
    case 'heartbeat':
      if (
        typeof parsed.terminalConnected !== 'boolean' ||
        typeof parsed.tradeAllowed !== 'boolean'
      ) {
        throw new Mt5AgentProtocolError('heartbeat connection flags must be boolean');
      }
      return {
        type: 'heartbeat',
        eventSeq: parseSequence(parsed),
        terminalConnected: parsed.terminalConnected,
        tradeAllowed: parsed.tradeAllowed,
        serverTime: requiredNumber(parsed, 'serverTime'),
        at: requiredNumber(parsed, 'at'),
        ...(typeof parsed.serverMillis === 'number' ? { serverMillis: parsed.serverMillis } : {}),
        ...(typeof parsed.serverUtcOffsetSec === 'number'
          ? { serverUtcOffsetSec: parsed.serverUtcOffsetSec }
          : {}),
      };
    case 'snapshot':
      if (!isRecord(parsed.snapshot)) {
        throw new Mt5AgentProtocolError('snapshot message requires snapshot object');
      }
      return {
        type: 'snapshot',
        requestId: requiredString(parsed, 'requestId'),
        eventSeq: parseSequence(parsed),
        snapshot: parsed.snapshot as unknown as Mt5HostSnapshot,
      };
    case 'transaction':
      return {
        type: 'transaction',
        eventSeq: parseSequence(parsed),
        validTime: requiredNumber(parsed, 'validTime'),
        transactionType: requiredString(parsed, 'transactionType'),
        ...(optionalString(parsed, 'orderTicket') === undefined
          ? {}
          : { orderTicket: optionalString(parsed, 'orderTicket') }),
        ...(optionalString(parsed, 'dealTicket') === undefined
          ? {}
          : { dealTicket: optionalString(parsed, 'dealTicket') }),
        ...(optionalString(parsed, 'positionId') === undefined
          ? {}
          : { positionId: optionalString(parsed, 'positionId') }),
        ...(optionalString(parsed, 'symbol') === undefined
          ? {}
          : { symbol: optionalString(parsed, 'symbol') }),
        ...(optionalString(parsed, 'magic') === undefined
          ? {}
          : { magic: optionalString(parsed, 'magic') }),
        ...(optionalString(parsed, 'volume') === undefined
          ? {}
          : { volume: optionalString(parsed, 'volume') }),
        ...(optionalString(parsed, 'price') === undefined
          ? {}
          : { price: optionalString(parsed, 'price') }),
      } as Mt5AgentTransactionMessage;
    case 'result':
      if (!isRecord(parsed.result))
        throw new Mt5AgentProtocolError('result message requires result object');
      return {
        type: 'result',
        requestId: requiredString(parsed, 'requestId'),
        // Result bodies are request-id correlated and command-specific. Submit
        // paths consume the submit shape; calc_margin re-parses the same opaque
        // object with the stricter margin parser before it can reach risk.
        result: parsed.result as unknown as Mt5HostSubmitResult,
      };
    default:
      throw new Mt5AgentProtocolError('unknown MT5 agent message type');
  }
}

export function encodeDeskCommand(message: Mt5DeskCommandMessage): string {
  return `${JSON.stringify(message)}\n`;
}

/** Streaming UTF-8 newline decoder with an explicit memory ceiling. */
export class Mt5AgentLineDecoder {
  private readonly decoder = new StringDecoder('utf8');
  private buffer = '';

  feed(chunk: Buffer): string[] {
    this.buffer += this.decoder.write(chunk);
    if (Buffer.byteLength(this.buffer, 'utf8') > MT5_AGENT_MAX_LINE_BYTES) {
      this.buffer = '';
      throw new Mt5AgentProtocolError('MT5 agent line exceeded maximum size');
    }

    const lines: string[] = [];
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length > 0) lines.push(line);
    }
    return lines;
  }
}
