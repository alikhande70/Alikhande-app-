import * as ExpoSecureStore from 'expo-secure-store';
import type { PairingMetadata, PairingMetadataStore } from './pairing.js';

const PAIRING_KEY = 'keel.desk.pairing.v1';
const FORMAT_VERSION = 1;

export interface PairingStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export class PairingStoreError extends Error {
  constructor(
    message: string,
    readonly code: 'CORRUPT_METADATA' | 'READ_FAILED' | 'WRITE_FAILED' | 'CLEAR_FAILED',
  ) {
    super(message);
    this.name = 'PairingStoreError';
  }
}

/**
 * Durable pairing metadata store.
 *
 * Pairing metadata is not a private key, but it is part of the device identity
 * contract. Corruption must therefore fail closed rather than being treated as
 * "not paired": silently returning undefined could invite the operator to enrol
 * a second device while the Desk still trusts the first one.
 */
export class SecurePairingMetadataStore implements PairingMetadataStore {
  constructor(private readonly storage: PairingStorage) {}

  async load(): Promise<PairingMetadata | undefined> {
    let encoded: string | null;
    try {
      encoded = await this.storage.getItem(PAIRING_KEY);
    } catch (error) {
      throw new PairingStoreError(`could not read pairing metadata: ${messageOf(error)}`, 'READ_FAILED');
    }
    if (encoded === null) return undefined;

    let raw: unknown;
    try {
      raw = JSON.parse(encoded);
    } catch {
      throw new PairingStoreError(
        'stored pairing metadata is not valid JSON; do not re-enrol until this identity is recovered or explicitly cleared',
        'CORRUPT_METADATA',
      );
    }
    return parseStoredPairing(raw);
  }

  async save(pairing: PairingMetadata): Promise<void> {
    // Validate our own output before making it durable. This also prevents a
    // caller from smuggling non-finite timestamps through structural typing.
    const validated = parsePairing(pairing);
    const payload = JSON.stringify({ version: FORMAT_VERSION, pairing: validated });
    try {
      await this.storage.setItem(PAIRING_KEY, payload);
    } catch (error) {
      throw new PairingStoreError(`could not persist pairing metadata: ${messageOf(error)}`, 'WRITE_FAILED');
    }
  }

  async clear(): Promise<void> {
    try {
      await this.storage.removeItem(PAIRING_KEY);
    } catch (error) {
      throw new PairingStoreError(`could not clear pairing metadata: ${messageOf(error)}`, 'CLEAR_FAILED');
    }
  }
}

export function createExpoPairingMetadataStore(): PairingMetadataStore {
  return new SecurePairingMetadataStore({
    getItem: (key) => ExpoSecureStore.getItemAsync(key),
    setItem: async (key, value) => {
      await ExpoSecureStore.setItemAsync(key, value, {
        keychainAccessible: ExpoSecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      });
    },
    removeItem: (key) => ExpoSecureStore.deleteItemAsync(key),
  });
}

function parseStoredPairing(value: unknown): PairingMetadata {
  const obj = asObject(value);
  if (obj.version !== FORMAT_VERSION) {
    throw new PairingStoreError(
      `unsupported pairing metadata version ${String(obj.version)}`,
      'CORRUPT_METADATA',
    );
  }
  return parsePairing(obj.pairing);
}

function parsePairing(value: unknown): PairingMetadata {
  const obj = asObject(value);
  const baseUrl = requiredString(obj.baseUrl, 'baseUrl');
  const deviceId = requiredString(obj.deviceId, 'deviceId');
  const publicKey = requiredString(obj.publicKey, 'publicKey');
  const label = requiredString(obj.label, 'label');
  const keyKind = obj.keyKind;
  const hardwareBacked = obj.hardwareBacked;
  const enrolledAt = obj.enrolledAt;
  const streamUrl = obj.streamUrl;

  if (keyKind !== 'p256' && keyKind !== 'ed25519') corrupt('keyKind');
  if (typeof hardwareBacked !== 'boolean') corrupt('hardwareBacked');
  if (typeof enrolledAt !== 'number' || !Number.isFinite(enrolledAt) || enrolledAt <= 0) {
    corrupt('enrolledAt');
  }
  if (streamUrl !== undefined && (typeof streamUrl !== 'string' || streamUrl.trim().length === 0)) {
    corrupt('streamUrl');
  }

  assertSafeHttpUrl(baseUrl, 'baseUrl');
  if (streamUrl !== undefined) assertSafeStreamUrl(streamUrl);

  return {
    baseUrl,
    deviceId,
    publicKey,
    label,
    keyKind,
    hardwareBacked,
    enrolledAt,
    ...(streamUrl === undefined ? {} : { streamUrl }),
  };
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PairingStoreError('stored pairing metadata is not an object', 'CORRUPT_METADATA');
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) corrupt(field);
  return value.trim();
}

function corrupt(field: string): never {
  throw new PairingStoreError(`stored pairing metadata has invalid ${field}`, 'CORRUPT_METADATA');
}

function assertSafeHttpUrl(value: string, field: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    corrupt(field);
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    corrupt(field);
  }
}

function assertSafeStreamUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    corrupt('streamUrl');
  }
  if ((url.protocol !== 'ws:' && url.protocol !== 'wss:') || url.username || url.password) {
    corrupt('streamUrl');
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
