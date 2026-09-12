import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM envelope for every durable record body. The profile database and each project
 * database receive HKDF-derived, domain-separated subkeys, so project key material never opens
 * another project's records.
 */

const ENVELOPE_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const HEADER_BYTES = 1 + IV_BYTES + TAG_BYTES;
const HKDF_SALT = 'echopilot-memory-v1';

export function deriveStoreKey(masterKey: string, domain: string): Buffer {
  const derived = hkdfSync(
    'sha256',
    Buffer.from(masterKey, 'utf8'),
    Buffer.from(HKDF_SALT, 'utf8'),
    Buffer.from(domain, 'utf8'),
    KEY_BYTES,
  );
  return Buffer.from(derived);
}

export function profileDomain(profileId: string): string {
  return `profile:${profileId}`;
}

export function projectDomain(profileId: string, projectId: string): string {
  return `project:${profileId}:${projectId}`;
}

export function sealValue(key: Buffer, plaintext: string | Uint8Array): Uint8Array {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : Buffer.from(plaintext);
  const ciphertext = Buffer.concat([cipher.update(body), cipher.final()]);
  return new Uint8Array(Buffer.concat([Buffer.from([ENVELOPE_VERSION]), iv, cipher.getAuthTag(), ciphertext]));
}

export function openValue(key: Buffer, sealed: Uint8Array | Buffer): Buffer {
  const buffer = Buffer.from(sealed);
  if (buffer.length < HEADER_BYTES || buffer[0] !== ENVELOPE_VERSION) {
    throw new Error('memory store value has an unsupported encrypted envelope');
  }
  const iv = buffer.subarray(1, 1 + IV_BYTES);
  const tag = buffer.subarray(1 + IV_BYTES, HEADER_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(buffer.subarray(HEADER_BYTES)), decipher.final()]);
}

export function sealJson(key: Buffer, value: unknown): Uint8Array {
  return sealValue(key, JSON.stringify(value));
}

export function openText(key: Buffer, sealed: Uint8Array | Buffer): string {
  return openValue(key, sealed).toString('utf8');
}

export function openJson<T>(key: Buffer, sealed: Uint8Array | Buffer): T {
  return JSON.parse(openText(key, sealed)) as T;
}

/** Stable content fingerprint used for cursors and database file names. */
export function fingerprint(...parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex');
}
