import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
  encodeDeskCommand,
  type Mt5AgentHeartbeat,
  type Mt5AgentHello,
  type Mt5AgentMessage,
  Mt5AgentProtocolError,
  type Mt5AgentSnapshotMessage,
  type Mt5AgentTransactionMessage,
  type Mt5DeskCommandMessage,
} from './agent-protocol.js';
import type { Mt5HostSubmitResult } from './host-types.js';

export interface Mt5AgentTransport {
  write(data: string): void;
  close(): void;
}

export class Mt5AgentDisconnectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Mt5AgentDisconnectedError';
  }
}

export interface Mt5AgentSessionOptions {
  readonly token: string;
  readonly commandTimeoutMs?: number;
  readonly heartbeatStaleMs?: number;
  readonly onAuthenticated?: (hello: Mt5AgentHello) => void;
  readonly onSnapshot?: (message: Mt5AgentSnapshotMessage) => void;
  readonly onTransaction?: (message: Mt5AgentTransactionMessage) => void;
}

interface PendingCommand {
  readonly resolve: (result: Mt5HostSubmitResult) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

function tokensEqual(expected: string, actual: string): boolean {
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(actual, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

export class Mt5AgentSession {
  private readonly commandTimeoutMs: number;
  private readonly heartbeatStaleMs: number;
  private readonly pending = new Map<string, PendingCommand>();
  private helloMessage: Mt5AgentHello | undefined;
  private heartbeatMessage: Mt5AgentHeartbeat | undefined;
  private lastEventSeq = -1n;
  private disconnected = false;

  constructor(
    private readonly transport: Mt5AgentTransport,
    private readonly options: Mt5AgentSessionOptions,
  ) {
    if (options.token.length < 16) {
      throw new Mt5AgentProtocolError('MT5 agent token must be at least 16 characters');
    }
    this.commandTimeoutMs = options.commandTimeoutMs ?? 5_000;
    this.heartbeatStaleMs = options.heartbeatStaleMs ?? 5_000;
  }

  receive(message: Mt5AgentMessage): void {
    if (this.disconnected) throw new Mt5AgentDisconnectedError('MT5 agent session is closed');

    if (this.helloMessage === undefined) {
      if (message.type !== 'hello') {
        this.transport.close();
        throw new Mt5AgentProtocolError('MT5 agent must authenticate with hello first');
      }
      if (!tokensEqual(this.options.token, message.token)) {
        this.transport.close();
        throw new Mt5AgentProtocolError('MT5 agent authentication failed');
      }
      this.helloMessage = message;
      this.options.onAuthenticated?.(message);
      return;
    }

    if (message.type === 'hello') {
      throw new Mt5AgentProtocolError('MT5 agent sent duplicate hello');
    }

    switch (message.type) {
      case 'heartbeat':
        if (!this.acceptSequence(message.eventSeq)) return;
        this.heartbeatMessage = message;
        return;
      case 'snapshot':
        if (!this.acceptSequence(message.eventSeq)) return;
        this.options.onSnapshot?.(message);
        return;
      case 'transaction':
        if (!this.acceptSequence(message.eventSeq)) return;
        this.options.onTransaction?.(message);
        return;
      case 'result': {
        const pending = this.pending.get(message.requestId);
        if (pending === undefined) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.requestId);
        pending.resolve(message.result);
        return;
      }
    }
  }

  isAuthenticated(): boolean {
    return this.helloMessage !== undefined && !this.disconnected;
  }

  hello(): Mt5AgentHello | undefined {
    return this.helloMessage;
  }

  heartbeat(): Mt5AgentHeartbeat | undefined {
    return this.heartbeatMessage;
  }

  watermark(): string | undefined {
    return this.lastEventSeq < 0n ? undefined : this.lastEventSeq.toString();
  }

  isLive(now = Date.now()): boolean {
    const heartbeat = this.heartbeatMessage;
    return (
      this.isAuthenticated() &&
      heartbeat?.terminalConnected === true &&
      now - heartbeat.at <= this.heartbeatStaleMs
    );
  }

  async command(
    command: Mt5DeskCommandMessage['command'],
    payload: unknown,
  ): Promise<Mt5HostSubmitResult> {
    if (!this.isAuthenticated()) {
      throw new Mt5AgentDisconnectedError('MT5 agent is not authenticated');
    }
    if (!this.isLive()) {
      throw new Mt5AgentDisconnectedError('MT5 agent heartbeat is stale or terminal disconnected');
    }

    const requestId = randomUUID();
    const message: Mt5DeskCommandMessage = {
      type: 'command',
      protocolVersion: 1,
      requestId,
      command,
      payload,
    };

    return new Promise<Mt5HostSubmitResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Mt5AgentDisconnectedError(`MT5 agent command ${command} timed out`));
      }, this.commandTimeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        this.transport.write(encodeDeskCommand(message));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  disconnect(reason = 'MT5 agent disconnected'): void {
    if (this.disconnected) return;
    this.disconnected = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Mt5AgentDisconnectedError(reason));
    }
    this.pending.clear();
  }

  private acceptSequence(sequence: string): boolean {
    const parsed = BigInt(sequence);
    if (parsed <= this.lastEventSeq) return false;
    this.lastEventSeq = parsed;
    return true;
  }
}
