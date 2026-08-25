import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify } from 'node:crypto';
import type { Clock } from '../sim/clock.js';

/**
 * Authentication (ADR-0011).
 *
 * No passwords, no registration, no reset flow — a reset flow is an attack
 * surface that exists only to serve users who forget passwords, and there is
 * exactly one user here who will not.
 *
 * Instead: the device holds a non-extractable Ed25519 private key in its secure
 * enclave and signs every request. There is no bearer secret to phish, log, or
 * leak in a backup. Commands that can move money additionally consume a
 * server-issued single-use nonce, so a captured request cannot be replayed even
 * by someone who owns the transport.
 */

export class AuthError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 401,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export interface EnrolledDevice {
  readonly deviceId: string;
  /** SPKI DER, base64. */
  readonly publicKey: string;
  readonly label: string;
  readonly enrolledAt: number;
}

export interface SignedRequest {
  readonly deviceId: string;
  readonly method: string;
  readonly path: string;
  readonly timestamp: number;
  /** Per-request random value, replay-protected within the clock skew window. */
  readonly nonce: string;
  readonly bodyHash: string;
  /** Base64 Ed25519 signature over the canonical string. */
  readonly signature: string;
  /** Server-issued single-use nonce. Required for commands. */
  readonly commandNonce?: string;
}

/** Requests older or newer than this are refused, bounding replay. */
export const MAX_CLOCK_SKEW_MS = 60_000;
/** How long a command nonce stays claimable. */
export const COMMAND_NONCE_TTL_MS = 120_000;

/**
 * The exact bytes that get signed.
 *
 * Every field that could change the meaning of the request is in here. Omitting
 * the body hash would let an attacker keep a valid signature and swap the
 * order; omitting the path would let them redirect a signed request to a
 * different endpoint.
 */
export function canonicalString(r: Omit<SignedRequest, 'signature' | 'deviceId'>): string {
  return [
    'keel-v1',
    r.method.toUpperCase(),
    r.path,
    String(r.timestamp),
    r.nonce,
    r.bodyHash,
    r.commandNonce ?? '-',
  ].join('\n');
}

export function hashBody(body: string | Buffer | undefined): string {
  return createHash('sha256')
    .update(body ?? '')
    .digest('base64');
}

export class Authenticator {
  private readonly devices = new Map<string, EnrolledDevice>();
  /** Request nonces seen inside the skew window, to stop straight replay. */
  private readonly seenNonces = new Map<string, number>();
  /** Server-issued command nonces awaiting use. */
  private readonly commandNonces = new Map<string, number>();
  /** Single-use enrolment codes. */
  private readonly enrolmentCodes = new Map<string, { expiresAt: number; label: string }>();

  constructor(private readonly clock: Clock) {}

  // --- Enrolment ------------------------------------------------------------

  /**
   * Issue a one-time enrolment code, shown on the desk host and typed or
   * scanned into the phone. Short-lived and single-use: an enrolment window
   * that stays open is a permanent way in.
   */
  createEnrolmentCode(label: string, ttlMs = 300_000): string {
    const code = randomBytes(5).toString('hex').toUpperCase();
    this.enrolmentCodes.set(code, { expiresAt: this.clock.now() + ttlMs, label });
    return code;
  }

  enrol(code: string, publicKeyBase64: string): EnrolledDevice {
    const entry = this.enrolmentCodes.get(code.toUpperCase());
    if (entry === undefined) throw new AuthError('unknown enrolment code', 'BAD_CODE', 403);
    // Consumed whether or not the rest succeeds, so a code cannot be brute-forced
    // by retrying with different keys.
    this.enrolmentCodes.delete(code.toUpperCase());
    if (this.clock.now() > entry.expiresAt) {
      throw new AuthError('enrolment code has expired', 'CODE_EXPIRED', 403);
    }

    let deviceId: string;
    try {
      const key = createPublicKey({
        key: Buffer.from(publicKeyBase64, 'base64'),
        format: 'der',
        type: 'spki',
      });
      if (key.asymmetricKeyType !== 'ed25519') {
        throw new AuthError('device key must be Ed25519', 'BAD_KEY', 400);
      }
      deviceId = createHash('sha256').update(publicKeyBase64).digest('hex').slice(0, 16);
    } catch (err) {
      if (err instanceof AuthError) throw err;
      throw new AuthError('device public key is not valid SPKI', 'BAD_KEY', 400);
    }

    const device: EnrolledDevice = {
      deviceId,
      publicKey: publicKeyBase64,
      label: entry.label,
      enrolledAt: this.clock.now(),
    };
    this.devices.set(deviceId, device);
    return device;
  }

  /** Restore enrolments at boot. */
  loadDevices(devices: readonly EnrolledDevice[]): void {
    for (const d of devices) this.devices.set(d.deviceId, d);
  }

  listDevices(): readonly EnrolledDevice[] {
    return [...this.devices.values()];
  }

  revoke(deviceId: string): boolean {
    return this.devices.delete(deviceId);
  }

  // --- Command nonces -------------------------------------------------------

  /**
   * Issue a nonce that a command must carry.
   *
   * This is what makes a captured order request useless: the nonce is
   * single-use and short-lived, so replaying the exact bytes fails even with a
   * valid signature.
   */
  issueCommandNonce(): { nonce: string; expiresAt: number } {
    const nonce = randomBytes(16).toString('base64url');
    const expiresAt = this.clock.now() + COMMAND_NONCE_TTL_MS;
    this.commandNonces.set(nonce, expiresAt);
    this.sweep();
    return { nonce, expiresAt };
  }

  // --- Verification ---------------------------------------------------------

  /**
   * Verify a signed request.
   *
   * `requireCommandNonce` is set for anything that can move money. Read
   * endpoints do not consume a nonce, so a flaky network cannot lock the
   * operator out of *seeing* their positions — only out of changing them.
   */
  verifyRequest(r: SignedRequest, requireCommandNonce: boolean): EnrolledDevice {
    const device = this.devices.get(r.deviceId);
    if (device === undefined) throw new AuthError('unknown device', 'UNKNOWN_DEVICE', 403);

    const skew = Math.abs(this.clock.now() - r.timestamp);
    if (skew > MAX_CLOCK_SKEW_MS) {
      throw new AuthError(
        `request timestamp is ${Math.round(skew / 1000)}s from desk time`,
        'CLOCK_SKEW',
      );
    }

    const nonceKey = `${r.deviceId}:${r.nonce}`;
    if (this.seenNonces.has(nonceKey)) {
      throw new AuthError('request nonce has already been used', 'REPLAY');
    }

    if (requireCommandNonce) {
      if (r.commandNonce === undefined) {
        throw new AuthError('this endpoint requires a command nonce', 'NONCE_REQUIRED');
      }
      const expiresAt = this.commandNonces.get(r.commandNonce);
      if (expiresAt === undefined) {
        throw new AuthError('command nonce is unknown or already used', 'BAD_COMMAND_NONCE');
      }
      if (this.clock.now() > expiresAt) {
        this.commandNonces.delete(r.commandNonce);
        throw new AuthError('command nonce has expired', 'COMMAND_NONCE_EXPIRED');
      }
    }

    const message = Buffer.from(
      canonicalString({
        method: r.method,
        path: r.path,
        timestamp: r.timestamp,
        nonce: r.nonce,
        bodyHash: r.bodyHash,
        ...(r.commandNonce !== undefined ? { commandNonce: r.commandNonce } : {}),
      }),
      'utf8',
    );

    let ok = false;
    try {
      const key = createPublicKey({
        key: Buffer.from(device.publicKey, 'base64'),
        format: 'der',
        type: 'spki',
      });
      ok = verify(null, message, key, Buffer.from(r.signature, 'base64'));
    } catch {
      ok = false;
    }
    if (!ok) throw new AuthError('signature does not verify', 'BAD_SIGNATURE');

    // Consume only after the signature checks out, so an unsigned request
    // cannot burn a valid nonce and lock the operator out under attack.
    this.seenNonces.set(nonceKey, this.clock.now() + MAX_CLOCK_SKEW_MS);
    if (requireCommandNonce && r.commandNonce !== undefined) {
      this.commandNonces.delete(r.commandNonce);
    }
    this.sweep();
    return device;
  }

  private sweep(): void {
    const now = this.clock.now();
    for (const [k, expiry] of this.seenNonces) if (expiry < now) this.seenNonces.delete(k);
    for (const [k, expiry] of this.commandNonces) if (expiry < now) this.commandNonces.delete(k);
    for (const [k, v] of this.enrolmentCodes) if (v.expiresAt < now) this.enrolmentCodes.delete(k);
  }

  get pendingCommandNonces(): number {
    return this.commandNonces.size;
  }
}

/** Constant-time comparison, for anything that is still a shared secret. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
