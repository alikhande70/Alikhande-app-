import { z } from 'zod';
import type { Authenticator, EnrolledDevice } from './auth.js';
import { AuthError, hashBody } from './auth.js';

const streamHelloAuthSchema = z.object({
  deviceId: z.string().min(1),
  timestamp: z.number().finite(),
  nonce: z.string().min(1),
  signature: z.string().min(1),
});

export interface StreamHelloAuth {
  readonly deviceId: string;
  readonly timestamp: number;
  readonly nonce: string;
  readonly signature: string;
}

/**
 * Authenticate the first WebSocket frame with the same device signature used
 * by HTTP reads. The upgrade itself remains header-free because React Native
 * WebSocket header support is platform-dependent; the client proves identity
 * before it is admitted to RealtimeHub or allowed to subscribe to any topic.
 *
 * The canonical request is deliberately GET /stream with an empty body and no
 * command nonce. A fresh per-connection nonce makes a captured hello useless on
 * reconnect while keeping read-only realtime access independent of command
 * authorisation.
 */
export function verifyStreamHelloAuth(
  input: unknown,
  authenticator: Pick<Authenticator, 'verifyRequest'>,
): EnrolledDevice {
  const parsed = streamHelloAuthSchema.safeParse(input);
  if (!parsed.success) {
    throw new AuthError('stream hello is not signed correctly', 'UNSIGNED');
  }

  return authenticator.verifyRequest(
    {
      deviceId: parsed.data.deviceId,
      method: 'GET',
      path: '/stream',
      timestamp: parsed.data.timestamp,
      nonce: parsed.data.nonce,
      bodyHash: hashBody(''),
      signature: parsed.data.signature,
    },
    false,
  );
}
