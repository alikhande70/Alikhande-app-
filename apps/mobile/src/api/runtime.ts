import type { DeskClient } from './client.js';

/**
 * Runtime binding for the authenticated Desk client.
 *
 * Pairing/bootstrap owns installation. Screens may read the binding, but they
 * must fail closed when it is absent. Keeping the absence explicit is safer
 * than letting UI code fabricate a successful local handoff while no signed
 * transport exists.
 */
let client: DeskClient | undefined;

export function installDeskClient(next: DeskClient): void {
  client = next;
}

export function clearDeskClient(): void {
  client = undefined;
}

export function currentDeskClient(): DeskClient | undefined {
  return client;
}
