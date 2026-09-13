/**
 * H03 — generic/import tracer bullet.
 *
 * Existing JSONL or plain-text log → bounded parser → normalized timeline preview.
 *
 * createGenericLogAdapter imports a file generation read-only: bounded streaming reads, source
 * identity/offset tracking, ANSI normalization, rotation detection, and a capability descriptor that
 * never claims send or approval handling.
 *
 * createManagedPtyAdapter is the opt-in escape hatch for tools without structured output. Sending is
 * available only to a user-selected managed child; nothing observed in its output is ever
 * auto-approved, and existing arbitrary terminals stay observation-only.
 *
 * createFileLogSource opens an existing JSONL / plain-text log as a bounded, read-only source:
 * positional reads capped at 64 KiB, a (device, inode) identity so rotation advances the
 * generation, and no write path at all.
 */
export type {
  GenericCapabilityDescriptor,
  GenericCursor,
  GenericDeliveryReceipt,
  GenericDiagnostic,
  GenericEnvelope,
  GenericFormat,
  GenericLogAdapter,
  GenericLogAdapterOptions,
  GenericLogSource,
  GenericPreview,
  GenericPreviewEvent,
  GenericPreviewOptions,
  GenericScope,
  GenericSensitivity,
  ManagedPtyAdapterOptions,
  ManagedPtyChild,
} from './types.js';

export { normalizeDisplayText } from './ansi.js';
export { GENERIC_FORMAT_VERSION, GENERIC_SCHEMA_VERSION } from './envelope.js';
export {
  DEFAULT_FILE_READ_CAP_BYTES,
  FileLogSource,
  createFileLogSource,
  type FileLogSourceOptions,
} from './file-source.js';
export { DEFAULT_PREVIEW_LIMIT } from './limits.js';
export { MAX_LINE_BYTES, READ_CHUNK_BYTES } from './scanner.js';

import { ImportLogAdapter } from './import-adapter.js';
import { ManagedPtyAdapter } from './pty-adapter.js';
import type { GenericLogAdapter, GenericLogAdapterOptions, ManagedPtyAdapterOptions } from './types.js';

export function createGenericLogAdapter(options: GenericLogAdapterOptions): GenericLogAdapter {
  return new ImportLogAdapter(options);
}

export function createManagedPtyAdapter(options: ManagedPtyAdapterOptions): GenericLogAdapter {
  return new ManagedPtyAdapter(options);
}
