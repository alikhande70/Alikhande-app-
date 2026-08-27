import { describe, expect, it } from 'vitest';
import type { PairingMetadata } from './pairing.js';
import {
  type PairingStorage,
  PairingStoreError,
  SecurePairingMetadataStore,
} from './pairing-store.js';

class MemoryStorage implements PairingStorage {
  value: string | null = null;
  fail: 'read' | 'write' | 'clear' | undefined;

  async getItem(): Promise<string | null> {
    if (this.fail === 'read') throw new Error('read failed');
    return this.value;
  }

  async setItem(_key: string, value: string): Promise<void> {
    if (this.fail === 'write') throw new Error('write failed');
    this.value = value;
  }

  async removeItem(): Promise<void> {
    if (this.fail === 'clear') throw new Error('clear failed');
    this.value = null;
  }
}

function pairing(overrides: Partial<PairingMetadata> = {}): PairingMetadata {
  return {
    baseUrl: 'https://desk.example.test',
    deviceId: 'device-123',
    publicKey: 'public-key',
    keyKind: 'ed25519',
    hardwareBacked: false,
    label: 'Ali phone',
    enrolledAt: 1_787_000_000_000,
    ...overrides,
  };
}

describe('SecurePairingMetadataStore', () => {
  it('round-trips validated pairing metadata', async () => {
    const storage = new MemoryStorage();
    const store = new SecurePairingMetadataStore(storage);

    await store.save(pairing({ streamUrl: 'wss://desk.example.test/stream' }));

    expect(await store.load()).toEqual(pairing({ streamUrl: 'wss://desk.example.test/stream' }));
    expect(storage.value).toContain('"version":1');
  });

  it('returns undefined only when no pairing record exists', async () => {
    const store = new SecurePairingMetadataStore(new MemoryStorage());
    await expect(store.load()).resolves.toBeUndefined();
  });

  it('fails closed on corrupt JSON instead of pretending the phone is unpaired', async () => {
    const storage = new MemoryStorage();
    storage.value = '{broken';
    const store = new SecurePairingMetadataStore(storage);

    await expect(store.load()).rejects.toMatchObject({ code: 'CORRUPT_METADATA' });
  });

  it('fails closed on unsupported versions and invalid identity fields', async () => {
    const storage = new MemoryStorage();
    const store = new SecurePairingMetadataStore(storage);

    storage.value = JSON.stringify({ version: 2, pairing: pairing() });
    await expect(store.load()).rejects.toMatchObject({ code: 'CORRUPT_METADATA' });

    storage.value = JSON.stringify({
      version: 1,
      pairing: { ...pairing(), enrolledAt: Number.NaN },
    });
    await expect(store.load()).rejects.toMatchObject({ code: 'CORRUPT_METADATA' });
  });

  it('rejects credential-bearing or unsafe endpoint URLs', async () => {
    const storage = new MemoryStorage();
    const store = new SecurePairingMetadataStore(storage);

    storage.value = JSON.stringify({
      version: 1,
      pairing: pairing({ baseUrl: 'https://user:pass@desk.example.test' }),
    });
    await expect(store.load()).rejects.toMatchObject({ code: 'CORRUPT_METADATA' });

    await expect(
      store.save(pairing({ streamUrl: 'https://desk.example.test/stream' })),
    ).rejects.toMatchObject({ code: 'CORRUPT_METADATA' });
  });

  it('surfaces storage I/O failures distinctly', async () => {
    const storage = new MemoryStorage();
    const store = new SecurePairingMetadataStore(storage);

    storage.fail = 'read';
    await expect(store.load()).rejects.toMatchObject({ code: 'READ_FAILED' });

    storage.fail = 'write';
    await expect(store.save(pairing())).rejects.toMatchObject({ code: 'WRITE_FAILED' });

    storage.fail = 'clear';
    await expect(store.clear()).rejects.toMatchObject({ code: 'CLEAR_FAILED' });
  });

  it('clears only through an explicit clear operation', async () => {
    const storage = new MemoryStorage();
    const store = new SecurePairingMetadataStore(storage);
    await store.save(pairing());

    await store.clear();

    expect(storage.value).toBeNull();
    await expect(store.load()).resolves.toBeUndefined();
  });

  it('uses PairingStoreError for malformed records', async () => {
    const storage = new MemoryStorage();
    storage.value = JSON.stringify({ version: 1, pairing: [] });
    const store = new SecurePairingMetadataStore(storage);

    await expect(store.load()).rejects.toBeInstanceOf(PairingStoreError);
  });
});
