import { describe, expect, it, vi } from 'vitest';
import {
  WindowsProtectedSigner,
  type WindowsNativeEd25519Bridge,
  type WindowsSignerMetadata,
  type WindowsSignerMetadataStore,
} from '../../../desktop/src/windows-signer.js';

const publicKey = 'QUJDREVGR0hJSktMTU5PUA==';
const signature = 'U0lHTkFUVVJFLURBVEEtMDE=';

class MemoryStore implements WindowsSignerMetadataStore {
  value: unknown;
  failSave = false;

  constructor(initial?: unknown) {
    this.value = initial;
  }

  async load(): Promise<unknown> {
    return this.value;
  }

  async save(metadata: WindowsSignerMetadata): Promise<void> {
    if (this.failSave) throw new Error('disk denied');
    this.value = metadata;
  }

  async clear(): Promise<void> {
    this.value = undefined;
  }
}

function bridge(existing = false): WindowsNativeEd25519Bridge & {
  present: boolean;
  generateKey: ReturnType<typeof vi.fn>;
  sign: ReturnType<typeof vi.fn>;
  removeKey: ReturnType<typeof vi.fn>;
} {
  const state = {
    present: existing,
    hasKey: async () => state.present,
    generateKey: vi.fn(async () => {
      state.present = true;
      return { publicKey, protection: 'hardware-backed-reported' as const };
    }),
    sign: vi.fn(async () => signature),
    removeKey: vi.fn(async () => {
      state.present = false;
    }),
  };
  return state;
}

function metadata(overrides: Partial<WindowsSignerMetadata> = {}): WindowsSignerMetadata {
  return {
    version: 1,
    keyName: 'keel-desktop-device-v1',
    publicKey,
    protection: 'os-user-protected',
    createdAt: 1_800_000_000_000,
    ...overrides,
  };
}

describe('Windows protected signer adapter', () => {
  it('provisions once, persists only public metadata, and signs through the opaque native key', async () => {
    const native = bridge(false);
    const store = new MemoryStore();

    const signer = await WindowsProtectedSigner.restoreOrProvision({
      bridge: native,
      store,
      now: () => 1_800_000_000_000,
    });

    expect(native.generateKey).toHaveBeenCalledTimes(1);
    expect(store.value).toEqual({
      version: 1,
      keyName: 'keel-desktop-device-v1',
      publicKey,
      protection: 'hardware-backed-reported',
      createdAt: 1_800_000_000_000,
    });
    expect(JSON.stringify(store.value)).not.toContain('private');
    expect(signer.status()).toEqual({
      publicKey,
      protection: 'hardware-backed-reported',
      hardwareBackedVerified: false,
    });

    await expect(signer.sign('payload', 'Send Mission order', true)).resolves.toBe(signature);
    expect(native.sign).toHaveBeenCalledWith(
      'keel-desktop-device-v1',
      'payload',
      'Send Mission order',
      true,
    );
  });

  it('restores the existing identity without silently generating another key', async () => {
    const native = bridge(true);
    const store = new MemoryStore(metadata());

    const signer = await WindowsProtectedSigner.restoreOrProvision({ bridge: native, store });

    expect(signer.status().publicKey).toBe(publicKey);
    expect(native.generateKey).not.toHaveBeenCalled();
  });

  it('fails closed when metadata survives but the native private key is missing', async () => {
    const native = bridge(false);
    const store = new MemoryStore(metadata());

    await expect(
      WindowsProtectedSigner.restoreOrProvision({ bridge: native, store }),
    ).rejects.toThrow('explicit re-pairing is required');
    expect(native.generateKey).not.toHaveBeenCalled();
  });

  it('fails closed on an orphan native key instead of guessing that it matches this Desk identity', async () => {
    const native = bridge(true);
    const store = new MemoryStore();

    await expect(
      WindowsProtectedSigner.restoreOrProvision({ bridge: native, store }),
    ).rejects.toThrow('refusing to guess device identity');
    expect(native.generateKey).not.toHaveBeenCalled();
  });

  it('rejects malformed persisted metadata rather than treating corruption as unpaired state', async () => {
    const native = bridge(false);
    const store = new MemoryStore({ version: 1, keyName: 'x', publicKey: 'bad' });

    await expect(
      WindowsProtectedSigner.restoreOrProvision({ bridge: native, store }),
    ).rejects.toThrow('metadata is malformed');
    expect(native.generateKey).not.toHaveBeenCalled();
  });

  it('leaves an ambiguous orphan key visible when metadata persistence fails', async () => {
    const native = bridge(false);
    const store = new MemoryStore();
    store.failSave = true;

    await expect(
      WindowsProtectedSigner.restoreOrProvision({ bridge: native, store }),
    ).rejects.toThrow('disk denied');
    expect(native.present).toBe(true);

    store.failSave = false;
    await expect(
      WindowsProtectedSigner.restoreOrProvision({ bridge: native, store }),
    ).rejects.toThrow('refusing to guess device identity');
  });

  it('refuses to sign after the native key disappears', async () => {
    const native = bridge(true);
    const signer = await WindowsProtectedSigner.restoreOrProvision({
      bridge: native,
      store: new MemoryStore(metadata()),
    });
    native.present = false;

    await expect(signer.sign('payload', 'Read Mission state', false)).rejects.toThrow(
      'key is no longer available',
    );
    expect(native.sign).not.toHaveBeenCalled();
  });
});
