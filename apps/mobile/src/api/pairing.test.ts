import { describe, expect, it, vi } from 'vitest';
import type { RunningDeskRuntime } from './bootstrap.js';
import {
  pairDesk,
  PairingError,
  type PairingMetadata,
  type PairingMetadataStore,
} from './pairing.js';
import type { SecureSigner, SignerIdentity } from './signer.js';

class MemoryPairingStore implements PairingMetadataStore {
  value: PairingMetadata | undefined;
  failSave = false;

  async load(): Promise<PairingMetadata | undefined> {
    return this.value;
  }

  async save(pairing: PairingMetadata): Promise<void> {
    if (this.failSave) throw new Error('disk full');
    this.value = pairing;
  }

  async clear(): Promise<void> {
    this.value = undefined;
  }
}

class FakeSigner implements SecureSigner {
  provisioned = false;
  destroyed = 0;
  readonly identity: SignerIdentity = {
    publicKey: 'MCowBQYDK2VwAyEA7xKj9zjVX9iYV7KZ9p1j0kZ9gY0m8YQ0Y0Y0Y0Y0Y0Y=',
    keyKind: 'ed25519',
    hardwareBacked: false,
  };

  async sign(): Promise<string> {
    return 'signature';
  }

  async isProvisioned(): Promise<boolean> {
    return this.provisioned;
  }

  async provision(): Promise<SignerIdentity> {
    this.provisioned = true;
    return this.identity;
  }

  async destroy(): Promise<void> {
    this.destroyed += 1;
    this.provisioned = false;
  }
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function accepted(identity: SignerIdentity) {
  return {
    deviceId: 'device-1234',
    label: 'Ali phone',
    keyKind: identity.keyKind,
    claimsHardwareBacked: identity.hardwareBacked,
    enrolledAt: 1_787_000_000_000,
  };
}

function runtime(): RunningDeskRuntime {
  return {
    client: {} as RunningDeskRuntime['client'],
    socket: {} as RunningDeskRuntime['socket'],
    stop() {},
  };
}

describe('first-time mobile pairing', () => {
  it('provisions, enrols, persists and starts runtime in that order', async () => {
    const signer = new FakeSigner();
    const store = new MemoryPairingStore();
    const starts: PairingMetadata[] = [];
    const fetchFn = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.code).toBe('A1B2C3D4E5');
      expect(body.publicKey).toBe(signer.identity.publicKey);
      expect(body.hardwareBacked).toBe(false);
      return response(accepted(signer.identity));
    });

    const result = await pairDesk(
      { baseUrl: 'https://desk.example.test/', code: 'a1b2c3d4e5' },
      {
        signer,
        store,
        fetchFn,
        startRuntime: async (pairing) => {
          starts.push(pairing);
          return runtime();
        },
      },
    );

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(signer.destroyed).toBe(0);
    expect(store.value).toEqual(result.pairing);
    expect(starts).toEqual([result.pairing]);
    expect(result.pairing.baseUrl).toBe('https://desk.example.test');
  });

  it('rolls back a key created for an enrolment the Desk rejects', async () => {
    const signer = new FakeSigner();
    const store = new MemoryPairingStore();

    await expect(
      pairDesk(
        { baseUrl: 'https://desk.example.test', code: 'A1B2C3D4E5' },
        {
          signer,
          store,
          fetchFn: async () => response({ code: 'CODE_EXPIRED', detail: 'expired' }, 403),
          startRuntime: async () => runtime(),
        },
      ),
    ).rejects.toMatchObject({ code: 'ENROL_FAILED' });

    expect(signer.destroyed).toBe(1);
    expect(signer.provisioned).toBe(false);
    expect(store.value).toBeUndefined();
  });

  it('does not destroy a pre-existing key when a fresh enrolment attempt fails', async () => {
    const signer = new FakeSigner();
    signer.provisioned = true;
    const store = new MemoryPairingStore();

    await expect(
      pairDesk(
        { baseUrl: 'https://desk.example.test', code: 'A1B2C3D4E5' },
        {
          signer,
          store,
          fetchFn: async () => response({ code: 'BAD_CODE', detail: 'unknown code' }, 403),
          startRuntime: async () => runtime(),
        },
      ),
    ).rejects.toMatchObject({ code: 'ENROL_FAILED' });

    expect(signer.destroyed).toBe(0);
    expect(signer.provisioned).toBe(true);
  });

  it('preserves the accepted key when metadata persistence fails after enrolment', async () => {
    const signer = new FakeSigner();
    const store = new MemoryPairingStore();
    store.failSave = true;
    let started = false;

    let caught: unknown;
    try {
      await pairDesk(
        { baseUrl: 'https://desk.example.test', code: 'A1B2C3D4E5' },
        {
          signer,
          store,
          fetchFn: async () => response(accepted(signer.identity)),
          startRuntime: async () => {
            started = true;
            return runtime();
          },
        },
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(PairingError);
    expect(caught).toMatchObject({
      code: 'METADATA_PERSIST_FAILED',
      enrolledDeviceId: 'device-1234',
    });
    expect(signer.destroyed).toBe(0);
    expect(signer.provisioned).toBe(true);
    expect(started).toBe(false);
  });

  it('keeps persisted pairing when runtime bootstrap fails so restore can retry', async () => {
    const signer = new FakeSigner();
    const store = new MemoryPairingStore();

    await expect(
      pairDesk(
        { baseUrl: 'https://desk.example.test', code: 'A1B2C3D4E5' },
        {
          signer,
          store,
          fetchFn: async () => response(accepted(signer.identity)),
          startRuntime: async () => {
            throw new Error('socket unavailable');
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'BOOTSTRAP_FAILED', enrolledDeviceId: 'device-1234' });

    expect(store.value?.deviceId).toBe('device-1234');
    expect(signer.destroyed).toBe(0);
  });

  it('refuses a duplicate local pairing before provisioning or network activity', async () => {
    const signer = new FakeSigner();
    const store = new MemoryPairingStore();
    store.value = {
      baseUrl: 'https://desk.example.test',
      deviceId: 'existing',
      publicKey: signer.identity.publicKey,
      keyKind: 'ed25519',
      hardwareBacked: false,
      label: 'Existing phone',
      enrolledAt: 1,
    };
    const fetchFn = vi.fn<typeof fetch>();

    await expect(
      pairDesk(
        { baseUrl: 'https://other.example.test', code: 'A1B2C3D4E5' },
        { signer, store, fetchFn, startRuntime: async () => runtime() },
      ),
    ).rejects.toMatchObject({ code: 'ALREADY_PAIRED', enrolledDeviceId: 'existing' });

    expect(fetchFn).not.toHaveBeenCalled();
    expect(signer.provisioned).toBe(false);
  });

  it('rejects malformed Desk URLs and enrolment codes before touching the key', async () => {
    const signer = new FakeSigner();
    const store = new MemoryPairingStore();

    await expect(
      pairDesk(
        { baseUrl: 'ftp://desk.example.test', code: 'A1B2C3D4E5' },
        { signer, store, startRuntime: async () => runtime() },
      ),
    ).rejects.toMatchObject({ code: 'BAD_DESK_URL' });

    await expect(
      pairDesk(
        { baseUrl: 'https://desk.example.test', code: 'short' },
        { signer, store, startRuntime: async () => runtime() },
      ),
    ).rejects.toMatchObject({ code: 'BAD_CODE' });

    expect(signer.provisioned).toBe(false);
    expect(signer.destroyed).toBe(0);
  });
});
