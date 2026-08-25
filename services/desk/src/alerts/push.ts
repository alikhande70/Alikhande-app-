import { request } from 'undici';
import type { Alert, PushSender } from './engine.js';

/**
 * Expo push delivery.
 *
 * Expo's push service is the pragmatic choice for a single-operator app: no
 * APNs certificate handling, no FCM project, and it works with the same Expo
 * account that builds the app.
 *
 * **Verification status: not verified.** Sending a real push needs an Expo push
 * token from a physical device, which this build environment does not have. The
 * request shape, the receipt handling and the error classification below follow
 * Expo's documented API and are unit-tested against a stubbed transport; none of
 * it has been exercised against the live service. See docs/VERIFICATION.md.
 */

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

export interface ExpoPushOptions {
  /** `ExponentPushToken[...]`, obtained on the device at enrolment. */
  readonly token: string;
  readonly requestTimeoutMs?: number;
  /** Injected for tests. */
  readonly transport?: (body: unknown) => Promise<{ status: number; json: unknown }>;
}

interface ExpoTicket {
  status?: string;
  message?: string;
  details?: { error?: string };
}

export class ExpoPushSender implements PushSender {
  readonly name = 'expo';

  constructor(private readonly opts: ExpoPushOptions) {}

  async send(alert: Alert): Promise<{ delivered: boolean; detail: string }> {
    const body = {
      to: this.opts.token,
      title: alert.title,
      body: alert.body,
      // Critical alerts bypass the quiet hours a trader is most likely to be
      // asleep in. That is the whole reason the desk runs without the phone.
      priority: alert.severity === 'critical' ? 'high' : 'normal',
      sound: alert.severity === 'critical' ? 'default' : null,
      channelId: alert.severity === 'critical' ? 'critical' : 'default',
      data: {
        alertId: alert.alertId,
        kind: alert.kind,
        severity: alert.severity,
        route: alert.route ?? null,
      },
    };

    try {
      const result =
        this.opts.transport !== undefined
          ? await this.opts.transport(body)
          : await this.post(body);

      if (result.status >= 400) {
        return { delivered: false, detail: `expo returned HTTP ${result.status}` };
      }

      const data = (result.json as { data?: ExpoTicket | ExpoTicket[] } | undefined)?.data;
      const ticket = Array.isArray(data) ? data[0] : data;
      if (ticket === undefined) {
        return { delivered: false, detail: 'expo returned no ticket' };
      }
      if (ticket.status === 'ok') {
        return { delivered: true, detail: 'accepted by expo' };
      }
      // A DeviceNotRegistered means the token is dead and the operator will
      // never see anything again until they re-enrol. Say so specifically.
      const code = ticket.details?.error ?? 'unknown';
      const detail =
        code === 'DeviceNotRegistered'
          ? 'the device token is no longer valid; re-enrol the phone or alerts will not arrive'
          : `expo rejected the push: ${ticket.message ?? code}`;
      return { delivered: false, detail };
    } catch (err) {
      return {
        delivered: false,
        detail: `push transport failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private async post(body: unknown): Promise<{ status: number; json: unknown }> {
    const res = await request(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      headersTimeout: this.opts.requestTimeoutMs ?? 10_000,
      bodyTimeout: this.opts.requestTimeoutMs ?? 10_000,
    });
    return { status: res.statusCode, json: await res.body.json() };
  }
}
