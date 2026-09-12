import type { NativeHelperBridge } from './native-helper';
import type { SecretStore } from './types';

export type KeychainOptions = {
  /** Keychain service name; the provider id is the account. */
  service?: string;
};

/**
 * Keychain-backed SecretStore.
 *
 * The secret is base64-encoded and sent over the helper's stdin pipe: it never appears in argv,
 * the environment, a log line, or any file the security kernel serializes.
 */
export function createKeychainSecretStore(bridge: NativeHelperBridge, options: KeychainOptions = {}): SecretStore {
  const service = options.service ?? 'com.echopilot.secrets';
  return {
    async put(provider: string, secret: string): Promise<void> {
      await bridge.request('keychain.put', { service, account: provider, secretBase64: encodeBase64(secret) });
    },
    async get(provider: string): Promise<string | null> {
      const result = await bridge.request<{ secretBase64?: unknown }>('keychain.get', { service, account: provider });
      const encoded = result?.secretBase64;
      return typeof encoded === 'string' && encoded.length > 0 ? decodeBase64(encoded) : null;
    },
    async delete(provider: string): Promise<void> {
      await bridge.request('keychain.delete', { service, account: provider });
    },
  };
}

function encodeBase64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

function decodeBase64(value: string): string {
  return Buffer.from(value, 'base64').toString('utf8');
}
