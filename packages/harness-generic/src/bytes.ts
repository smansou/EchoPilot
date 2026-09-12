/** Byte-level helpers shared by the adapters. All of them are allocation-bounded. */

export const EMPTY_BYTES = new Uint8Array(0);

const utf8 = new TextDecoder('utf-8');

/**
 * Decodes one complete line. Callers only ever decode whole lines, so a UTF-8 sequence split across
 * two source reads has already been reassembled here (H03: partial UTF-8 must not surface
 * replacement characters or corrupt adjacent events).
 */
export function decodeUtf8(bytes: Uint8Array): string {
  return utf8.decode(bytes);
}

export function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.byteLength === 0) return b;
  if (b.byteLength === 0) return a;
  const merged = new Uint8Array(a.byteLength + b.byteLength);
  merged.set(a, 0);
  merged.set(b, a.byteLength);
  return merged;
}

export function concatChunks(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/** '\r\n' is a line ending: the '\r' never reaches display text. */
export function stripTrailingCr(bytes: Uint8Array): Uint8Array {
  const last = bytes.byteLength - 1;
  return last >= 0 && bytes[last] === 0x0d ? bytes.subarray(0, last) : bytes;
}
