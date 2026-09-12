/**
 * IPC channels and payload guards for provider key entry (IMPLEMENTATION_PLAN.md §5.9).
 *
 * This module intentionally avoids Node built-ins so the sandboxed Electron preload bundle can
 * import it: the renderer hands a secret to the dedicated key-entry channel and only ever gets a
 * redacted reference back.
 */

/** Dedicated key-entry channel. Provider keys must never travel over `echo:command`. */
export const KEY_ENTRY_CHANNEL = 'echo:key-entry';

export type KeyEntryRequest = { provider: string; secret: string };
export type KeyEntryResult = { provider: string; keyRef: string; maskedSuffix: string };

const MAX_PROVIDER_ID = 64;
const MAX_SECRET_LENGTH = 8192;
const PROVIDER_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;

function fail(detail: string): never {
  throw new Error(`Invalid key entry: ${detail}`);
}

/** Validates the renderer → main payload before it is forwarded over `echo:key-entry`. */
export function parseKeyEntryRequest(value: unknown): KeyEntryRequest {
  if (typeof value !== 'object' || value === null) fail('expected a { provider, secret } object');
  const record = value as Record<string, unknown>;
  const provider = record.provider;
  const secret = record.secret;
  if (typeof provider !== 'string' || provider.length === 0) fail('provider must be a non-empty string');
  if (provider.length > MAX_PROVIDER_ID || !PROVIDER_ID_PATTERN.test(provider)) fail('provider id contains unsupported characters');
  if (typeof secret !== 'string' || secret.length === 0) fail('secret must be a non-empty string');
  if (secret.length > MAX_SECRET_LENGTH) fail('secret is too large');
  return { provider, secret };
}

/**
 * Validates the main → renderer result. It returns a redacted reference only: the raw secret is
 * never echoed back, not even as part of `keyRef` or `maskedSuffix`.
 */
export function parseKeyEntryResult(value: unknown, submittedSecret?: string): KeyEntryResult {
  if (typeof value !== 'object' || value === null) fail('expected a key-entry result object');
  const record = value as Record<string, unknown>;
  const provider = record.provider;
  const keyRef = record.keyRef;
  const maskedSuffix = record.maskedSuffix;
  if (typeof provider !== 'string' || provider.length === 0) fail('result provider must be a non-empty string');
  if (typeof keyRef !== 'string' || keyRef.length === 0) fail('result keyRef must be a non-empty string');
  if (typeof maskedSuffix !== 'string') fail('result maskedSuffix must be a string');
  if (typeof submittedSecret === 'string' && submittedSecret.length > 8) {
    if (keyRef.includes(submittedSecret) || maskedSuffix === submittedSecret) {
      fail('the key-entry result must not contain the submitted secret');
    }
  }
  return Object.freeze({ provider, keyRef, maskedSuffix });
}

/** The only part of a secret that may ever be shown back to the user. */
export function maskSecretSuffix(secret: string): string {
  return secret.length >= 4 ? secret.slice(-4) : '';
}
