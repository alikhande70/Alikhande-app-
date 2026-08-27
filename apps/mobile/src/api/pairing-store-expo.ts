import * as ExpoSecureStore from 'expo-secure-store';
import type { PairingMetadataStore } from './pairing.js';
import { SecurePairingMetadataStore } from './pairing-store.js';

/**
 * Production adapter for pairing metadata.
 *
 * This module is intentionally separate from the platform-neutral store logic so
 * Vitest never has to parse the React Native implementation of expo-secure-store.
 */
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
