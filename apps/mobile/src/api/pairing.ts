import type { RestoredPairing, RunningDeskRuntime } from './bootstrap.js';
import type { SecureSigner, SignerIdentity } from './signer.js';

export interface PairingMetadata extends RestoredPairing {
  readonly publicKey: string;
  readonly keyKind: SignerIdentity['keyKind'];
  readonly hardwareBacked: boolean;
  readonly label: string;
  readonly enrolledAt: number;
}

export interface PairingMetadataStore {
  load(): Promise<PairingMetadata | undefined>;
  save(pairing: PairingMetadata): Promise<void>;
  clear(): Promise<void>;
}

export interface PairDeskRequest {
  readonly baseUrl: string;
  readonly code: string;
}

export interface PairDeskOptions {
  readonly signer: SecureSigner;
  readonly store: PairingMetadataStore;
  readonly startRuntime: (pairing: PairingMetadata) => Promise<RunningDeskRuntime>;
  readonly fetchFn?: typeof fetch;
}

export class PairingError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'ALREADY_PAIRED'
      | 'BAD_DESK_URL'
      | 'BAD_CODE'
      | 'KEY_IDENTITY_UNAVAILABLE'
      | 'ENROL_FAILED'
      | 'ENROL_RESPONSE_INVALID'
      | 'METADATA_PERSIST_FAILED'
      | 'BOOTSTRAP_FAILED'
      | 'ROLLBACK_FAILED',
    readonly enrolledDeviceId?: string,
    /** True once HTTP success proves the Desk accepted this device key. */
    readonly serverAccepted = false,
  ) {
    super(message);
    this.name = 'PairingError';
  }
}

interface EnrolResponse {
  readonly deviceId: string;
  readonly label: string;
  readonly keyKind: SignerIdentity['keyKind'];
  readonly claimsHardwareBacked: boolean;
  readonly enrolledAt: number;
}

/**
 * Complete the first-time pairing ceremony around an already-selected signer.
 *
 * Security boundary:
 * - a key created for an enrolment that the Desk rejects is rolled back;
 * - once the Desk has accepted the key, it is never destroyed automatically,
 *   even if its success response is malformed or local persistence/bootstrap
 *   fails. Destroying it after server acceptance would manufacture an
 *   unrecoverable enrolled device.
 * - an existing local key is never destroyed by a failed pairing attempt.
 */
export async function pairDesk(
  request: PairDeskRequest,
  options: PairDeskOptions,
): Promise<{ pairing: PairingMetadata; runtime: RunningDeskRuntime }> {
  const existing = await options.store.load();
  if (existing !== undefined) {
    throw new PairingError(
      `this app is already paired to device ${existing.deviceId}; unpair explicitly before enrolling again`,
      'ALREADY_PAIRED',
      existing.deviceId,
    );
  }

  const baseUrl = normalizeDeskUrl(request.baseUrl);
  const code = request.code.trim().toUpperCase();
  if (!/^[0-9A-F]{10}$/.test(code)) {
    throw new PairingError('enrolment code must be the 10-character code shown by the Desk', 'BAD_CODE');
  }

  const alreadyProvisioned = await options.signer.isProvisioned();
  let createdKey = false;
  let identity: SignerIdentity;

  if (alreadyProvisioned) {
    try {
      identity = options.signer.identity;
    } catch {
      throw new PairingError(
        'a device key exists but its public identity has not been restored; restore the signer before pairing',
        'KEY_IDENTITY_UNAVAILABLE',
      );
    }
  } else {
    identity = await options.signer.provision();
    createdKey = true;
  }

  let enrolled: EnrolResponse;
  try {
    enrolled = await enrol(baseUrl, code, identity, options.fetchFn ?? fetch);
  } catch (error) {
    const accepted = error instanceof PairingError && error.serverAccepted;
    if (createdKey && !accepted) await rollbackNewKey(options.signer, error);
    throw error;
  }

  const pairing: PairingMetadata = {
    baseUrl,
    deviceId: enrolled.deviceId,
    publicKey: identity.publicKey,
    keyKind: enrolled.keyKind,
    hardwareBacked: enrolled.claimsHardwareBacked,
    label: enrolled.label,
    enrolledAt: enrolled.enrolledAt,
  };

  try {
    await options.store.save(pairing);
  } catch (error) {
    throw new PairingError(
      `Desk enrolled device ${enrolled.deviceId}, but pairing metadata could not be saved: ${messageOf(error)}. ` +
        'The device key was deliberately preserved; recover/persist this enrolment rather than creating another one.',
      'METADATA_PERSIST_FAILED',
      enrolled.deviceId,
      true,
    );
  }

  try {
    const runtime = await options.startRuntime(pairing);
    return { pairing, runtime };
  } catch (error) {
    throw new PairingError(
      `pairing was saved, but the Desk runtime could not start: ${messageOf(error)}. ` +
        'Keep the pairing and retry bootstrap; do not enrol a second device.',
      'BOOTSTRAP_FAILED',
      enrolled.deviceId,
      true,
    );
  }
}

async function enrol(
  baseUrl: string,
  code: string,
  identity: SignerIdentity,
  fetchFn: typeof fetch,
): Promise<EnrolResponse> {
  let response: Response;
  try {
    response = await fetchFn(`${baseUrl}/enrol`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code,
        publicKey: identity.publicKey,
        hardwareBacked: identity.hardwareBacked,
      }),
    });
  } catch (error) {
    throw new PairingError(`could not reach the Desk enrolment endpoint: ${messageOf(error)}`, 'ENROL_FAILED');
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new PairingError(
      `Desk enrolment returned HTTP ${response.status} with a non-JSON response`,
      response.ok ? 'ENROL_RESPONSE_INVALID' : 'ENROL_FAILED',
      undefined,
      response.ok,
    );
  }

  if (!response.ok) {
    const detail = errorDetail(body);
    throw new PairingError(
      `Desk refused enrolment (HTTP ${response.status})${detail === undefined ? '' : `: ${detail}`}`,
      'ENROL_FAILED',
    );
  }

  let enrolled: EnrolResponse;
  try {
    enrolled = parseEnrolResponse(body);
  } catch (error) {
    if (error instanceof PairingError) {
      throw new PairingError(error.message, error.code, error.enrolledDeviceId, true);
    }
    throw new PairingError(
      `Desk accepted enrolment but returned an invalid response: ${messageOf(error)}`,
      'ENROL_RESPONSE_INVALID',
      undefined,
      true,
    );
  }

  if (enrolled.keyKind !== identity.keyKind) {
    throw new PairingError(
      `Desk enrolled key kind ${enrolled.keyKind}, but the device provisioned ${identity.keyKind}`,
      'ENROL_RESPONSE_INVALID',
      enrolled.deviceId,
      true,
    );
  }
  if (enrolled.claimsHardwareBacked !== identity.hardwareBacked) {
    throw new PairingError(
      'Desk hardware-backed claim does not match the device identity that was submitted',
      'ENROL_RESPONSE_INVALID',
      enrolled.deviceId,
      true,
    );
  }
  return enrolled;
}

function parseEnrolResponse(value: unknown): EnrolResponse {
  if (typeof value !== 'object' || value === null) {
    throw new PairingError('Desk enrolment response is not an object', 'ENROL_RESPONSE_INVALID');
  }
  const body = value as Record<string, unknown>;
  const deviceId = nonEmpty(body.deviceId);
  const label = nonEmpty(body.label);
  const keyKind = body.keyKind;
  const claimsHardwareBacked = body.claimsHardwareBacked;
  const enrolledAt = body.enrolledAt;
  if (
    deviceId === undefined ||
    label === undefined ||
    (keyKind !== 'p256' && keyKind !== 'ed25519') ||
    typeof claimsHardwareBacked !== 'boolean' ||
    typeof enrolledAt !== 'number' ||
    !Number.isFinite(enrolledAt) ||
    enrolledAt <= 0
  ) {
    throw new PairingError('Desk enrolment response is missing required identity fields', 'ENROL_RESPONSE_INVALID');
  }
  return { deviceId, label, keyKind, claimsHardwareBacked, enrolledAt };
}

async function rollbackNewKey(signer: SecureSigner, originalError: unknown): Promise<never> {
  try {
    await signer.destroy();
  } catch (rollbackError) {
    throw new PairingError(
      `enrolment failed (${messageOf(originalError)}) and the newly-created key could not be rolled back (${messageOf(rollbackError)})`,
      'ROLLBACK_FAILED',
    );
  }
  throw originalError;
}

function normalizeDeskUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new PairingError('Desk URL is not a valid URL', 'BAD_DESK_URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new PairingError(`unsupported Desk URL protocol: ${url.protocol}`, 'BAD_DESK_URL');
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new PairingError('Desk URL must not contain credentials', 'BAD_DESK_URL');
  }
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function errorDetail(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const body = value as Record<string, unknown>;
  return nonEmpty(body.detail) ?? nonEmpty(body.title) ?? nonEmpty(body.code);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
