import type { RunningDeskRuntime } from './bootstrap.js';
import type { PairingMetadata, PairingMetadataStore } from './pairing.js';
import type { SecureSigner } from './signer.js';

/**
 * App-shell dependencies required by the first-time pairing screen.
 *
 * The screen deliberately does not create a signer itself. Key provisioning is
 * a security boundary and must be installed by the platform bootstrap after it
 * has selected a truthful implementation (hardware-backed enclave/TEE when
 * actually available, otherwise an explicitly software-backed signer).
 */
export interface PairingRuntime {
  readonly signer: SecureSigner;
  readonly store: PairingMetadataStore;
  readonly startRuntime: (pairing: PairingMetadata) => Promise<RunningDeskRuntime>;
}

let installed: PairingRuntime | undefined;

/** Install the platform pairing dependencies once the app shell has verified them. */
export function installPairingRuntime(runtime: PairingRuntime): void {
  installed = runtime;
}

/** Remove the binding during explicit unpair/test teardown. */
export function clearPairingRuntime(): void {
  installed = undefined;
}

/**
 * Pairing UI must fail closed when no secure signer has been installed.
 * Returning undefined is intentional: the screen can explain the blocked state
 * without inventing a software key or claiming hardware protection.
 */
export function getPairingRuntime(): PairingRuntime | undefined {
  return installed;
}
