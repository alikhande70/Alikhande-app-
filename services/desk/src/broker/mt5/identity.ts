import { createHash } from 'node:crypto';

/**
 * MT5 has no durable client-order-id primitive. ADR-0015 reserves the lower
 * 63 bits of request.magic as:
 *
 *   [ 16-bit Keel system prefix ][ 47-bit deterministic intent fingerprint ]
 *
 * The sign bit is deliberately never set because DEAL_MAGIC / ORDER_MAGIC are
 * read back through signed `long` APIs in MQL5 history. Keeping the value below
 * 2^63 avoids a value that was written as ulong comparing unequal when read.
 */
const INTENT_BITS = 47n;
const INTENT_MASK = (1n << INTENT_BITS) - 1n;
const MAX_MAGIC_EXCLUSIVE = 1n << 63n;
const MAX_PREFIX = 0xffff;

export class Mt5IdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Mt5IdentityError';
  }
}

export function validateSystemPrefix(prefix: number): number {
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > MAX_PREFIX) {
    throw new Mt5IdentityError(`MT5 system prefix must be an integer from 0 to ${MAX_PREFIX}`);
  }
  return prefix;
}

/**
 * Produce the MT5 magic number for a Keel client-order id.
 *
 * The client-order id is already a deterministic derivative of the durable
 * intent id, so deriving magic from it preserves idempotency without extending
 * BrokerPort with an MT5-specific field. The full client id -> magic mapping is
 * still persisted by the desk before transmission; the hash is not reversible.
 */
export function magicForClientOrderId(clientOrderId: string, systemPrefix: number): bigint {
  validateSystemPrefix(systemPrefix);
  if (clientOrderId.length === 0) throw new Mt5IdentityError('client order id must not be empty');

  const digest = createHash('sha256').update(clientOrderId, 'utf8').digest();
  let tail = 0n;
  for (let i = digest.length - 8; i < digest.length; i += 1) {
    tail = (tail << 8n) | BigInt(digest[i] ?? 0);
  }

  const fingerprint = tail & INTENT_MASK;
  const magic = (BigInt(systemPrefix) << INTENT_BITS) | fingerprint;
  if (magic < 0n || magic >= MAX_MAGIC_EXCLUSIVE) {
    // This should be impossible if the constants above are changed coherently.
    throw new Mt5IdentityError('derived MT5 magic escaped the signed 63-bit domain');
  }
  return magic;
}

/** MQL5/JSON transport uses decimal strings so no 53-bit JS number truncation is possible. */
export function magicToWire(magic: bigint): string {
  if (magic < 0n || magic >= MAX_MAGIC_EXCLUSIVE) {
    throw new Mt5IdentityError('MT5 magic must be in the non-negative signed 63-bit domain');
  }
  return magic.toString(10);
}

/** Whether a venue object belongs to this Keel installation. */
export function hasSystemPrefix(magic: bigint, systemPrefix: number): boolean {
  validateSystemPrefix(systemPrefix);
  if (magic < 0n || magic >= MAX_MAGIC_EXCLUSIVE) return false;
  return magic >> INTENT_BITS === BigInt(systemPrefix);
}

/** Parse a magic received as a decimal string without ever passing through Number. */
export function magicFromWire(raw: string): bigint {
  if (!/^[0-9]+$/.test(raw)) throw new Mt5IdentityError(`invalid MT5 magic '${raw}'`);
  const value = BigInt(raw);
  if (value >= MAX_MAGIC_EXCLUSIVE) {
    throw new Mt5IdentityError('MT5 magic has the sign bit set; refusing an ambiguous identity');
  }
  return value;
}
