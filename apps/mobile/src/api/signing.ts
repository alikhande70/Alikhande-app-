/**
 * Request signing, client side.
 *
 * The canonical string here must match the desk's byte for byte. It is written
 * out longhand rather than shared as a package because the two sides are built
 * and deployed independently: if they ever drift, a mismatch should surface as
 * "signature does not verify" on the very first request, which is loud and
 * immediate, rather than as a subtle divergence in what got signed.
 *
 * The `signingContract.test.ts` in this package asserts the two implementations
 * agree, so the drift is caught in CI rather than at 14:30.
 */

export interface SignatureParts {
  readonly method: string;
  readonly path: string;
  readonly timestamp: number;
  readonly nonce: string;
  readonly bodyHash: string;
  readonly commandNonce?: string;
}

/** Must stay identical to `canonicalString` in services/desk/src/http/auth.ts. */
export function canonicalString(p: SignatureParts): string {
  return [
    'keel-v1',
    p.method.toUpperCase(),
    p.path,
    String(p.timestamp),
    p.nonce,
    p.bodyHash,
    p.commandNonce ?? '-',
  ].join('\n');
}

/**
 * Which endpoints need a single-use command nonce and a biometric assertion.
 *
 * The client's copy of this list is a *convenience*, not a control: the desk
 * enforces it independently and will refuse a command that arrives without one.
 * If the two lists ever disagree, the desk wins, which is the safe direction.
 *
 * Mission routes are intentionally included here. The Desk has classified them
 * as mutating since ADR-0018 was wired, so omitting them on Android made the
 * phone send a normally signed request without a command nonce. The Desk then
 * rejected the request before Mission logic ever ran. Keeping these paths in
 * the client is therefore required for the Mission-bound execution path to be
 * reachable from Android.
 */
const COMMAND_PATHS = [
  /^\/orders$/,
  /^\/orders\/[^/]+\/cancel$/,
  /^\/scans$/,
  /^\/missions\/[^/]+\/plan$/,
  /^\/missions\/[^/]+\/orders$/,
  /^\/positions\/[^/]+\/(modify|close)$/,
  /^\/panic$/,
  /^\/policy$/,
  /^\/guard\/(lockout|release)$/,
];

export function isCommandPath(path: string): boolean {
  return COMMAND_PATHS.some((re) => re.test(path));
}

/**
 * A short, human-readable description of what the operator is about to
 * authorise, shown in the biometric prompt.
 *
 * Face ID's own prompt is the last thing between a tap and a position, so it
 * carries the actual consequence rather than "Authenticate".
 */
export function biometricReason(path: string, summary?: string): string {
  if (summary !== undefined && summary.length > 0) return summary;
  if (/^\/orders$/.test(path)) return 'Send this order to the broker';
  if (/^\/scans$/.test(path)) return 'Record this scan on your trading desk';
  if (/^\/missions\/[^/]+\/plan$/.test(path)) return 'Seal this mission plan';
  if (/^\/missions\/[^/]+\/orders$/.test(path)) return 'Send this mission order to the broker';
  if (/cancel$/.test(path)) return 'Cancel this order';
  if (/close$/.test(path)) return 'Close this position';
  if (/^\/panic$/.test(path)) return 'Close everything and stop trading';
  if (/^\/policy$/.test(path)) return 'Change your risk limits';
  return 'Authorise this action on your trading desk';
}
