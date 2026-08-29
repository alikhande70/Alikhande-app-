import type { DesktopSigner } from './client.js';

export type WindowsKeyProtection = 'os-user-protected' | 'hardware-backed-reported';

export interface WindowsNativeKeyRecord {
  readonly publicKey: string;
  readonly protection: WindowsKeyProtection;
}

/**
 * Boundary implemented by the eventual native Windows shell.
 *
 * Private key material never crosses this interface. The shell owns generation,
 * protected persistence and signing through Windows-native facilities. Repository
 * code deliberately does not claim hardware backing merely because the bridge
 * reports it; target-runtime verification remains a separate external gate.
 */
export interface WindowsNativeEd25519Bridge {
  hasKey(keyName: string): Promise<boolean>;
  generateKey(keyName: string): Promise<WindowsNativeKeyRecord>;
  sign(keyName: string, message: string, reason: string, consequential: boolean): Promise<string>;
  removeKey(keyName: string): Promise<void>;
}

export interface WindowsSignerMetadata {
  readonly version: 1;
  readonly keyName: string;
  readonly publicKey: string;
  readonly protection: WindowsKeyProtection;
  readonly createdAt: number;
}

export interface WindowsSignerMetadataStore {
  load(): Promise<unknown>;
  save(metadata: WindowsSignerMetadata): Promise<void>;
  clear(): Promise<void>;
}

export interface WindowsSignerStatus {
  readonly publicKey: string;
  readonly protection: WindowsKeyProtection;
  /**
   * Always false in repository-only execution. It may become true only after a
   * target-Windows proof step records evidence outside this adapter.
   */
  readonly hardwareBackedVerified: false;
}

function isBase64(value: string): boolean {
  if (value.length < 16 || value.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function parseMetadata(raw: unknown): WindowsSignerMetadata | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object') throw new Error('Windows signer metadata is malformed');
  const row = raw as Record<string, unknown>;
  if (
    row.version !== 1 ||
    typeof row.keyName !== 'string' ||
    row.keyName.length < 3 ||
    typeof row.publicKey !== 'string' ||
    !isBase64(row.publicKey) ||
    (row.protection !== 'os-user-protected' && row.protection !== 'hardware-backed-reported') ||
    typeof row.createdAt !== 'number' ||
    !Number.isFinite(row.createdAt) ||
    row.createdAt <= 0
  ) {
    throw new Error('Windows signer metadata is malformed');
  }
  return {
    version: 1,
    keyName: row.keyName,
    publicKey: row.publicKey,
    protection: row.protection,
    createdAt: row.createdAt,
  };
}

/**
 * DesktopSigner backed by an opaque Windows-native Ed25519 key.
 *
 * Important failure rule: if metadata says a device identity exists but the
 * native private key is missing, this adapter does NOT silently generate a new
 * identity. The Desk may still trust the old public key, so silent replacement
 * would create a split-brain device identity. Recovery must be explicit.
 */
export class WindowsProtectedSigner implements DesktopSigner {
  private constructor(
    private readonly bridge: WindowsNativeEd25519Bridge,
    private readonly metadata: WindowsSignerMetadata,
  ) {}

  /**
   * Restore an identity that has already been paired with the Desk.
   *
   * This path never generates a key. Runtime bootstrap must use it so missing
   * local identity cannot silently become a different key while the Desk still
   * trusts the old public key.
   */
  static async restore(options: {
    readonly bridge: WindowsNativeEd25519Bridge;
    readonly store: WindowsSignerMetadataStore;
  }): Promise<WindowsProtectedSigner> {
    const existing = parseMetadata(await options.store.load());
    if (existing === undefined) {
      throw new Error('Windows signer metadata is missing; explicit pairing is required');
    }
    if (!(await options.bridge.hasKey(existing.keyName))) {
      throw new Error(
        'Windows signer metadata exists but its native private key is missing; explicit re-pairing is required',
      );
    }
    return new WindowsProtectedSigner(options.bridge, existing);
  }

  /**
   * First-time local provisioning helper. Pairing code may use this before the
   * public key is enrolled with the Desk; normal runtime bootstrap must use
   * restore() instead.
   */
  static async restoreOrProvision(options: {
    readonly bridge: WindowsNativeEd25519Bridge;
    readonly store: WindowsSignerMetadataStore;
    readonly keyName?: string;
    readonly now?: () => number;
  }): Promise<WindowsProtectedSigner> {
    const existing = parseMetadata(await options.store.load());
    if (existing !== undefined) {
      if (!(await options.bridge.hasKey(existing.keyName))) {
        throw new Error(
          'Windows signer metadata exists but its native private key is missing; explicit re-pairing is required',
        );
      }
      return new WindowsProtectedSigner(options.bridge, existing);
    }

    const keyName = options.keyName ?? 'keel-desktop-device-v1';
    if (await options.bridge.hasKey(keyName)) {
      throw new Error(
        'A native Windows key exists without trusted metadata; refusing to guess device identity',
      );
    }

    const generated = await options.bridge.generateKey(keyName);
    if (!isBase64(generated.publicKey)) {
      throw new Error('Windows native bridge returned a malformed public key');
    }
    if (
      generated.protection !== 'os-user-protected' &&
      generated.protection !== 'hardware-backed-reported'
    ) {
      throw new Error('Windows native bridge returned an unknown key protection class');
    }

    const metadata: WindowsSignerMetadata = {
      version: 1,
      keyName,
      publicKey: generated.publicKey,
      protection: generated.protection,
      createdAt: (options.now ?? (() => Date.now()))(),
    };

    // Do not auto-delete the key if metadata persistence fails. Deletion itself
    // can fail and hiding that ambiguity by generating another key later is worse.
    // A subsequent restore sees the orphan native key and fails closed.
    await options.store.save(metadata);
    return new WindowsProtectedSigner(options.bridge, metadata);
  }

  status(): WindowsSignerStatus {
    return {
      publicKey: this.metadata.publicKey,
      protection: this.metadata.protection,
      hardwareBackedVerified: false,
    };
  }

  async sign(message: string, reason: string, consequential: boolean): Promise<string> {
    if (!(await this.bridge.hasKey(this.metadata.keyName))) {
      throw new Error('Windows signing key is no longer available; command is not authorised');
    }
    const signature = await this.bridge.sign(this.metadata.keyName, message, reason, consequential);
    if (!isBase64(signature))
      throw new Error('Windows native bridge returned a malformed signature');
    return signature;
  }

  /**
   * Explicit local reset only. Callers must revoke/unpair the old Desk device
   * before treating a newly generated key as the same device.
   */
  async clearLocalIdentity(store: WindowsSignerMetadataStore): Promise<void> {
    await this.bridge.removeKey(this.metadata.keyName);
    await store.clear();
  }
}
