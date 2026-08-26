import { createServer, type Server, type Socket } from 'node:net';
import { decodeAgentMessage, Mt5AgentLineDecoder } from './agent-protocol.js';
import {
  Mt5AgentSession,
  type Mt5AgentSessionOptions,
  type Mt5AgentTransport,
} from './agent-session.js';

export interface Mt5AgentBridgeServerOptions extends Omit<Mt5AgentSessionOptions, 'onAuthenticated'> {
  readonly port: number;
  readonly host?: '127.0.0.1' | '::1';
  readonly onSessionReady?: (session: Mt5AgentSession) => void;
  readonly onProtocolError?: (error: Error) => void;
}

/**
 * Loopback-only TCP listener for KeelAgent.mq5.
 *
 * The EA is outbound-only, so it connects to this listener. Authentication happens
 * inside Mt5AgentSession before any heartbeat, snapshot, transaction, or command is
 * accepted. At most one authenticated agent owns the active session; a freshly
 * authenticated replacement closes the previous connection so two EAs cannot both
 * receive the same order command.
 */
export class Mt5AgentBridgeServer {
  private server: Server | undefined;
  private active: { session: Mt5AgentSession; socket: Socket } | undefined;

  constructor(private readonly options: Mt5AgentBridgeServerOptions) {}

  async listen(): Promise<void> {
    if (this.server !== undefined) throw new Error('MT5 agent bridge is already listening');
    const host = this.options.host ?? '127.0.0.1';
    if (host !== '127.0.0.1' && host !== '::1') {
      throw new Error('MT5 agent bridge must bind to loopback only');
    }

    this.server = createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      const server = this.server;
      if (server === undefined) return reject(new Error('MT5 agent bridge server missing'));
      server.once('error', reject);
      server.listen(this.options.port, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    const active = this.active;
    this.active = undefined;
    if (active !== undefined) {
      active.session.disconnect('MT5 agent bridge stopped');
      active.socket.destroy();
    }
    const server = this.server;
    this.server = undefined;
    if (server === undefined) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }

  session(): Mt5AgentSession | undefined {
    return this.active?.session;
  }

  private accept(socket: Socket): void {
    socket.setNoDelay(true);
    const decoder = new Mt5AgentLineDecoder();
    let session: Mt5AgentSession;
    const transport: Mt5AgentTransport = {
      write: (data) => socket.write(data, 'utf8'),
      close: () => socket.destroy(),
    };

    session = new Mt5AgentSession(transport, {
      token: this.options.token,
      ...(this.options.commandTimeoutMs === undefined
        ? {}
        : { commandTimeoutMs: this.options.commandTimeoutMs }),
      ...(this.options.heartbeatStaleMs === undefined
        ? {}
        : { heartbeatStaleMs: this.options.heartbeatStaleMs }),
      ...(this.options.onSnapshot === undefined ? {} : { onSnapshot: this.options.onSnapshot }),
      ...(this.options.onTransaction === undefined
        ? {}
        : { onTransaction: this.options.onTransaction }),
      onAuthenticated: () => {
        const previous = this.active;
        this.active = { session, socket };
        if (previous !== undefined && previous.socket !== socket) {
          previous.session.disconnect('replaced by newly authenticated MT5 agent');
          previous.socket.destroy();
        }
        this.options.onSessionReady?.(session);
      },
    });

    socket.on('data', (chunk) => {
      try {
        for (const line of decoder.feed(chunk)) session.receive(decodeAgentMessage(line));
      } catch (error) {
        const parsed = error instanceof Error ? error : new Error(String(error));
        this.options.onProtocolError?.(parsed);
        session.disconnect(parsed.message);
        socket.destroy();
      }
    });
    socket.on('close', () => {
      session.disconnect('MT5 agent socket closed');
      if (this.active?.socket === socket) this.active = undefined;
    });
    socket.on('error', (error) => {
      this.options.onProtocolError?.(error);
      session.disconnect(`MT5 agent socket error: ${error.message}`);
    });
  }
}
