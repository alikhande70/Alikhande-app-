/**
 * The device key.
 *
 * Two implementations, and the difference is not cosmetic:
 *
 * - `EnclaveSigner` uses an ECDSA P-256 key generated *inside* the Secure
 *   Enclave (iOS) or StrongBox/TEE (Android). The private key never exists in
 *   application memory, so a compromised app cannot exfiltrate it. This requires
 *   a small native module; see the note on `EnclaveSigner` for what it needs.
 * - `KeychainSigner` keeps a software key in `expo-secure-store`, encrypted at
 *   rest and gated behind biometrics. Good, but the key is readable by the app
 *   process. The desk records which kind it enrolled so the operator can see
 *   the difference rather than assuming the stronger one.
 *
 * Whichever is used, `sign` is the only way the app can produce a valid request,
 * and it is the only place a biometric prompt appears.
 */

export type KeyKind = 'p256' | 'ed25519';

export interface SignerIdentity {
  /** SPKI DER, base64 — exactly what the desk enrols. */
  readonly publicKey: string;
  readonly keyKind: KeyKind;
  /** Whether the private key lives in a security processor. */
  readonly hardwareBacked: boolean;
}

export interface SecureSigner {
  readonly identity: SignerIdentity;
  /**
   * Sign the canonical string.
   *
   * `reason` is shown in the biometric prompt. It is required rather than
   * optional because the prompt is the last thing between a tap and a position,
   * and a generic "Authenticate" wastes it.
   *
   * P-256 signatures MUST be raw `r||s` (IEEE P1363). The desk verifies in that
   * form; a DER-encoded signature silently fails.
   */
  sign(canonical: string, reason: string, requireBiometric: boolean): Promise<string>;
  /** Whether a key exists yet. */
  isProvisioned(): Promise<boolean>;
  /** Create the key. Called once, during enrolment. */
  provision(): Promise<SignerIdentity>;
  /** Destroy the key. Used when un-pairing a device. */
  destroy(): Promise<void>;
}

export class SignerError extends Error {
  constructor(
    message: string,
    readonly code: 'NO_KEY' | 'BIOMETRIC_FAILED' | 'UNAVAILABLE' | 'CANCELLED',
  ) {
    super(message);
    this.name = 'SignerError';
  }
}

/**
 * The platform bridge an enclave-backed signer needs.
 *
 * Deliberately expressed as an interface rather than a direct native import,
 * for two reasons: the app must run in a simulator and in tests without one,
 * and it makes explicit exactly how small the native surface is — three
 * methods, no key material crossing the bridge in either direction.
 *
 * **Verification status: the native module is not implemented in this
 * repository.** `EnclaveSigner` is written against this interface and unit
 * tested through a stub. Wiring it to a real enclave is a native task and is
 * listed in docs/VERIFICATION.md as externally blocked.
 */
export interface EnclaveBridge {
  /** Whether this device has a usable security processor. */
  isAvailable(): Promise<boolean>;
  /** Generate a non-extractable P-256 key. Returns SPKI DER, base64. */
  generateKey(alias: string, requireBiometric: boolean): Promise<string>;
  hasKey(alias: string): Promise<boolean>;
  /** Sign, prompting for biometrics if the key was created requiring them. */
  sign(alias: string, payloadUtf8: string, prompt: string): Promise<string>;
  deleteKey(alias: string): Promise<void>;
}

const KEY_ALIAS = 'app.keel.desk.device-key';

export class EnclaveSigner implements SecureSigner {
  private cached: SignerIdentity | undefined;

  constructor(
    private readonly bridge: EnclaveBridge,
    private readonly alias = KEY_ALIAS,
  ) {}

  get identity(): SignerIdentity {
    if (this.cached === undefined) {
      throw new SignerError('no device key has been provisioned yet', 'NO_KEY');
    }
    return this.cached;
  }

  async isProvisioned(): Promise<boolean> {
    return this.bridge.hasKey(this.alias);
  }

  async provision(): Promise<SignerIdentity> {
    if (!(await this.bridge.isAvailable())) {
      throw new SignerError(
        'this device has no usable secure enclave; use the keychain signer and enrol as ' +
          'software-backed rather than claiming hardware protection',
        'UNAVAILABLE',
      );
    }
    const publicKey = await this.bridge.generateKey(this.alias, true);
    this.cached = { publicKey, keyKind: 'p256', hardwareBacked: true };
    return this.cached;
  }

  async sign(canonical: string, reason: string, _requireBiometric: boolean): Promise<string> {
    // The enclave key was created requiring biometrics, so the prompt is
    // enforced by the platform on every use — it cannot be skipped by the app,
    // which is exactly the property that makes it worth the native module.
    try {
      return await this.bridge.sign(this.alias, canonical, reason);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new SignerError(
        `signing failed: ${message}`,
        /cancel/i.test(message) ? 'CANCELLED' : 'BIOMETRIC_FAILED',
      );
    }
  }

  async destroy(): Promise<void> {
    await this.bridge.deleteKey(this.alias);
    this.cached = undefined;
  }

  /** Load an existing key's identity at start-up. */
  async restore(publicKey: string): Promise<void> {
    this.cached = { publicKey, keyKind: 'p256', hardwareBacked: true };
  }
}

/**
 * Storage the software signer needs. Backed by `expo-secure-store` in the app;
 * an in-memory implementation in tests.
 */
export interface SecureStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string, requireBiometric: boolean): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/** Ed25519 primitives. Supplied by the app (`@noble/ed25519` or equivalent). */
export interface Ed25519Ops {
  generate(): Promise<{ privateKeyBase64: string; publicKeySpkiBase64: string }>;
  sign(privateKeyBase64: string, messageUtf8: string): Promise<string>;
}

export class KeychainSigner implements SecureSigner {
  private cached: SignerIdentity | undefined;

  constructor(
    private readonly store: SecureStore,
    private readonly ops: Ed25519Ops,
    private readonly biometricGate: (reason: string) => Promise<boolean>,
  ) {}

  get identity(): SignerIdentity {
    if (this.cached === undefined) {
      throw new SignerError('no device key has been provisioned yet', 'NO_KEY');
    }
    return this.cached;
  }

  async isProvisioned(): Promise<boolean> {
    return (await this.store.getItem('keel.device.private')) !== null;
  }

  async provision(): Promise<SignerIdentity> {
    const { privateKeyBase64, publicKeySpkiBase64 } = await this.ops.generate();
    await this.store.setItem('keel.device.private', privateKeyBase64, true);
    await this.store.setItem('keel.device.public', publicKeySpkiBase64, false);
    // Honest about what this is: a software key, however well protected at rest.
    this.cached = { publicKey: publicKeySpkiBase64, keyKind: 'ed25519', hardwareBacked: false };
    return this.cached;
  }

  async sign(canonical: string, reason: string, requireBiometric: boolean): Promise<string> {
    if (requireBiometric) {
      const passed = await this.biometricGate(reason);
      if (!passed) throw new SignerError('biometric authentication was not passed', 'BIOMETRIC_FAILED');
    }
    const priv = await this.store.getItem('keel.device.private');
    if (priv === null) throw new SignerError('no device key found', 'NO_KEY');
    return this.ops.sign(priv, canonical);
  }

  async destroy(): Promise<void> {
    await this.store.removeItem('keel.device.private');
    await this.store.removeItem('keel.device.public');
    this.cached = undefined;
  }

  async restore(): Promise<SignerIdentity | undefined> {
    const pub = await this.store.getItem('keel.device.public');
    if (pub === null) return undefined;
    this.cached = { publicKey: pub, keyKind: 'ed25519', hardwareBacked: false };
    return this.cached;
  }
}
