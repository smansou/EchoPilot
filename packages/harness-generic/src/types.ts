/**
 * H03 — generic/import tracer bullet.
 *
 * Shared contract for the read-only JSONL / plain-text import adapters and the opt-in managed PTY
 * wrapper. Imported content is always data: every event carries trust 'imported', an imported log
 * can never create an approval or an executable instruction, and only a managed child the user
 * selected can be written to — never because of something its own output said.
 */

export type GenericSensitivity = 'normal' | 'private' | 'secret';

export type GenericScope = {
  profileId: string;
  sensitivity: GenericSensitivity;
  projectId?: string;
  sessionId?: string;
};

export type GenericFormat = 'jsonl' | 'text';

/** Display-only gaps. They never carry semantic content and never carry authority. */
export type GenericDiagnostic = 'malformed_json' | 'incomplete_line' | 'source_rotated';

/**
 * Commit point of a preview: the byte offset after the last parsed event of a source generation.
 * `generation` starts at 1 and advances when the source identity changes (rotation).
 */
export type GenericCursor = {
  sourceId: string;
  generation: number;
  offset: number;
};

export type GenericCapabilityDescriptor = {
  observe: boolean;
  send: boolean;
  interrupt: boolean;
  resume: boolean;
  approvalResponse: boolean;
  toolResults: boolean;
  artifactDiffs: boolean;
  format: GenericFormat;
  formatVersion: number;
};

/** §5.3 EventEnvelope-shaped record as produced for imported sources. */
export type GenericEnvelope = {
  schemaVersion: number;
  eventId: string;
  sourceId: string;
  sourceEventId: string;
  sourceSequence: number;
  ingestSequence: number;
  occurredAt: string;
  observedAt: string;
  scope: GenericScope;
  kind: string;
  unsupportedKind?: string;
  payloadRef: string;
  contentHash: string;
  trust: 'imported';
};

export type GenericPreviewEvent = {
  event: GenericEnvelope;
  /** ANSI-normalized, redraw-collapsed display text. */
  text: string;
  /** 'low' for every unstructured (plain-text / PTY) line. */
  confidence: 'low' | 'high';
  diagnostic?: GenericDiagnostic;
  /** Commit point after this event. */
  cursor: GenericCursor;
};

export type GenericPreview = {
  events: GenericPreviewEvent[];
  cursor: GenericCursor;
};

/** One generation of one file. Read-only: the adapter never writes to it. */
export type GenericLogSource = {
  identity(): Promise<string>;
  size(): Promise<number>;
  read(offset: number, maxBytes: number): Promise<Uint8Array>;
};

export type GenericPreviewOptions = {
  from?: GenericCursor;
  limit?: number;
};

export type GenericDeliveryReceipt = {
  deliveryId: string;
  status: 'acknowledged' | 'unsupported';
};

export type GenericLogAdapter = {
  capabilities(): Promise<GenericCapabilityDescriptor>;
  preview(options?: GenericPreviewOptions): Promise<GenericPreview>;
  send(instruction: string, deliveryId: string): Promise<GenericDeliveryReceipt>;
};

export type GenericLogAdapterOptions = {
  format: GenericFormat;
  source: GenericLogSource;
  scope: GenericScope;
  sessionId: string;
};

/** PTY handle of a child this application started because the user selected it. */
export type ManagedPtyChild = {
  write(data: string): void;
  onData(listener: (chunk: Uint8Array) => void): () => void;
};

export type ManagedPtyAdapterOptions = {
  child: ManagedPtyChild;
  scope: GenericScope;
  sessionId: string;
};
