/**
 * C05 desktop observation seam (main-process half).
 *
 * One user-initiated observation is one short-lived `echopilot-desktop` helper process: a single
 * validated `{operation:"observe",scope:{projectId}}` line on private stdio, a single bounded
 * response line, and then the child is terminated. Nothing about the helper's raw stdio or
 * unbounded AX text leaves this module — an unusable answer collapses to a category, and the only
 * evidence handed back is the strictly validated, byte-bounded `ForegroundEvidence` the native
 * observer already caps. There is no polling, no retry, no socket, and no network call.
 *
 * The helper is looked up relative to the running main bundle (`dist/main`), never the process
 * working directory, so a binary planted in a writable cwd can never be spawned.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** Hard wall-clock budget for one observation, including helper startup. */
export const DESKTOP_OBSERVE_TIMEOUT_MS = 6_000;
/** Ceiling for the one response line; the native snapshot itself is capped at 32 KiB encoded. */
export const DESKTOP_OBSERVE_MAX_RESPONSE_BYTES = 192 * 1024;
/** Ceiling for evidence nodes; the native observer emits at most 200 by default. */
export const DESKTOP_OBSERVE_MAX_EVIDENCE_NODES = 256;

const MAX_PROJECT_ID_BYTES = 256;
const MAX_ERROR_BYTES = 512;
const MAX_DETAIL_BYTES = 256;
const MAX_APPLICATION_FIELD_BYTES = 1_024;
const MAX_ROLE_BYTES = 256;
const MAX_WINDOW_TITLE_BYTES = 2_048;
const MAX_NODE_STRING_BYTES = 4_096;
const MAX_TRUNCATION_NAMES = 16;
const KILL_ESCALATION_MS = 500;

const TRUNCATION_NAMES: ReadonlySet<string> = new Set(['depth', 'nodes', 'children', 'strings', 'bytes', 'response', 'time']);

export type ForegroundEvidenceApplication = Readonly<{
  pid: number;
  bundleId: string;
  name: string;
  bundleIdTruncated: boolean;
  nameTruncated: boolean;
}>;

export type ObservationFrame=Readonly<{x:number;y:number;width:number;height:number}>;
export type ObservationTextRegion=Readonly<{kind:'sentence'|'paragraph';text:string;frame:ObservationFrame;rangeStart:number;rangeLength:number}>;

export type ForegroundEvidenceWindow = Readonly<{
  id?:string;
  frame?:ObservationFrame;
  role: string;
  roleTruncated: boolean;
  title: string;
  titleTruncated: boolean;
}>;

export type ForegroundEvidenceNode = Readonly<{
  frame?:ObservationFrame;
  textRegions?:readonly ObservationTextRegion[];
  depth: number;
  role: string;
  subrole: string | null;
  label: string | null;
  value: string | null;
  labelTruncated: boolean;
  valueTruncated: boolean;
  redacted: boolean;
  roleTruncated: boolean;
  subroleTruncated: boolean;
}>;

export type ForegroundEvidenceStats = Readonly<{
  visitedNodes: number;
  emittedNodes: number;
  maxDepthReached: number;
  estimatedBytes: number;
}>;

export type ForegroundEvidence = Readonly<{
  kind: 'desktop_observe';
  observedAtMs: number;
  projectId: string;
  application: ForegroundEvidenceApplication;
  window: ForegroundEvidenceWindow;
  nodes: readonly ForegroundEvidenceNode[];
  quality: 'full' | 'partial';
  truncated: boolean;
  truncations: readonly string[];
  stats: ForegroundEvidenceStats;
}>;

export type DesktopObserveDenialCode = 'accessibility_denied' | 'excluded_application' | 'no_window' | 'empty_evidence';

export type DesktopObserveResult =
  | Readonly<{ outcome: 'observed'; evidence: ForegroundEvidence }>
  | Readonly<{ outcome: 'denied'; code: DesktopObserveDenialCode; detail: string | null }>
  | Readonly<{ outcome: 'invalid_scope' }>
  | Readonly<{ outcome: 'helper_missing'; searched: readonly string[] }>
  | Readonly<{ outcome: 'timeout' }>
  | Readonly<{ outcome: 'crashed' }>
  | Readonly<{ outcome: 'malformed_response' }>
  | Readonly<{ outcome: 'response_too_large' }>
  | Readonly<{ outcome: 'native_error' }>;

export type DesktopObserveReadable = Readonly<{
  setEncoding?(encoding: string): unknown;
  on(event: 'data', listener: (chunk: string | Buffer) => void): unknown;
}>;

/** The child surface this seam uses; the real `ChildProcess` satisfies it. */
export type DesktopObserveChild = Readonly<{
  stdin: Readonly<{ write(data: string): unknown }> | null;
  stdout: DesktopObserveReadable | null;
  kill(signal?: NodeJS.Signals): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}>;

export type DesktopObserveSpawn = (command: string, args: readonly string[]) => DesktopObserveChild;

export type DesktopObserveHelperOptions = Readonly<{
  /** Directory of the running main bundle: `__dirname` of `dist/main/index.cjs`. */
  bundleDir: string;
  /** Explicit helper executable; when omitted the packaged `dist/native` layout is searched. */
  helperPath?: string;
  env?: NodeJS.ProcessEnv;
  exists?(candidate: string): boolean;
}>;

export type DesktopObserveHostOptions = DesktopObserveHelperOptions & Readonly<{
  spawn?: DesktopObserveSpawn;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxEvidenceNodes?: number;
}>;

export type DesktopObserveHost = Readonly<{
  observe(request: Readonly<{ projectId: unknown; allowLocalOCR?:boolean }>): Promise<DesktopObserveResult>;
}>;

export type DesktopObserveDiagnostics = Readonly<{
  helperFound: boolean;
  helperPath: string | null;
  searched: readonly string[];
}>;

/**
 * Candidate locations for the packaged desktop helper, in priority order. Every candidate is
 * derived from the main bundle directory — never from the process cwd — so the helper cannot be
 * shadowed by a file next to wherever the app was launched. A relative `ECHOPILOT_DESKTOP_HELPER`
 * override is resolved against the bundle directory for the same reason.
 */
export function desktopHelperCandidates(bundleDir: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const candidates: string[] = [];
  const override = env.ECHOPILOT_DESKTOP_HELPER?.trim();
  if (override) candidates.push(resolve(bundleDir, override));
  candidates.push(resolve(bundleDir, '../native/echopilot-desktop'));
  return [...new Set(candidates)];
}

/** Reports whether the packaged helper exists; diagnostics never spawn it. */
export function desktopObserveDiagnostics(options: DesktopObserveHelperOptions): DesktopObserveDiagnostics {
  const bundleDir = resolve(options.bundleDir);
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const searched = options.helperPath ? [explicitHelperPath(bundleDir, options.helperPath)] : desktopHelperCandidates(bundleDir, env);
  const found = searched.find((candidate) => exists(candidate)) ?? null;
  return Object.freeze({ helperFound: found !== null, helperPath: found, searched });
}

/** An explicit helper path is resolved against the bundle directory, never the process cwd. */
function explicitHelperPath(bundleDir: string, helperPath: string): string {
  return resolve(bundleDir, helperPath);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedString(value: unknown, maxBytes: number): string | null {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maxBytes) return null;
  return value;
}

function optionalString(record: Record<string, unknown>, key: string, maxBytes: number): { ok: boolean; value: string | null } {
  const raw = record[key];
  if (raw === undefined || raw === null) return { ok: true, value: null };
  const value = boundedString(raw, maxBytes);
  return value === null ? { ok: false, value: null } : { ok: true, value };
}

function flag(record: Record<string, unknown>, key: string): boolean | null {
  return typeof record[key] === 'boolean' ? record[key] as boolean : null;
}

function count(record: Record<string, unknown>, key: string, min = 0): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isInteger(value) && value >= min ? value : null;
}

/** Normalizes the request identity: non-empty after trimming, at most 256 UTF-8 bytes. */
function normalizeProjectId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || Buffer.byteLength(trimmed, 'utf8') > MAX_PROJECT_ID_BYTES) return null;
  return trimmed;
}

function parseFrame(value:unknown):ObservationFrame|null {
  const r=asRecord(value);if(!r)return null;
  if(!['x','y','width','height'].every(key=>typeof r[key]==='number'&&Number.isFinite(r[key])&&Math.abs(r[key] as number)<=100000))return null;
  if((r.width as number)<=0||(r.height as number)<=0)return null;
  return {x:r.x as number,y:r.y as number,width:r.width as number,height:r.height as number};
}
function parseTextRegions(value:unknown):readonly ObservationTextRegion[]|null {
  if(!Array.isArray(value)||value.length>12)return null;
  const result:ObservationTextRegion[]=[];
  for(const item of value){const r=asRecord(item);if(!r||(r.kind!=='sentence'&&r.kind!=='paragraph'))return null;
    const text=boundedString(r.text,4096),frame=parseFrame(r.frame),rangeStart=count(r,'rangeStart'),rangeLength=count(r,'rangeLength',1);
    if(text===null||!frame||rangeStart===null||rangeLength===null||rangeStart>10000000||rangeLength>2048)return null;
    result.push({kind:r.kind,text,frame,rangeStart,rangeLength});}
  return result;
}

/** The evidence payload is revalidated field by field; anything unexpected is a malformed answer. */
function parseEvidence(payload: string, expectedProjectId: string, maxNodes: number): ForegroundEvidence | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  if (!record || record.kind !== 'desktop_observe') return null;
  if (typeof record.observedAtMs !== 'number' || !Number.isFinite(record.observedAtMs) || record.observedAtMs < 0) return null;
  if (record.projectId !== expectedProjectId) return null;

  const applicationRecord = asRecord(record.application);
  if (!applicationRecord) return null;
  const pid = count(applicationRecord, 'pid');
  const bundleId = boundedString(applicationRecord.bundleId, MAX_APPLICATION_FIELD_BYTES);
  const name = boundedString(applicationRecord.name, MAX_APPLICATION_FIELD_BYTES);
  const bundleIdTruncated = flag(applicationRecord, 'bundleIdTruncated');
  const nameTruncated = flag(applicationRecord, 'nameTruncated');
  if (pid === null || pid > 2_147_483_647 || bundleId === null || name === null
    || bundleIdTruncated === null || nameTruncated === null) return null;

  const windowRecord = asRecord(record.window);
  if (!windowRecord) return null;
  const windowRole = boundedString(windowRecord.role, MAX_ROLE_BYTES);
  const windowTitle = boundedString(windowRecord.title, MAX_WINDOW_TITLE_BYTES);
  const windowRoleTruncated = flag(windowRecord, 'roleTruncated');
  const windowTitleTruncated = flag(windowRecord, 'titleTruncated');
  if (windowRole === null || windowTitle === null || windowRoleTruncated === null || windowTitleTruncated === null) return null;

  const windowFrame=windowRecord.frame===undefined?null:parseFrame(windowRecord.frame);
  const windowId=windowRecord.id===undefined?null:boundedString(windowRecord.id,128);
  if(windowRecord.frame!==undefined&&!windowFrame||windowRecord.id!==undefined&&windowId===null)return null;

  if (!Array.isArray(record.nodes) || record.nodes.length > maxNodes) return null;
  const nodes: ForegroundEvidenceNode[] = [];
  for (const rawNode of record.nodes) {
    const nodeRecord = asRecord(rawNode);
    if (!nodeRecord) return null;
    const depth = count(nodeRecord, 'depth');
    const role = boundedString(nodeRecord.role, MAX_ROLE_BYTES);
    const subrole = optionalString(nodeRecord, 'subrole', MAX_ROLE_BYTES);
    const label = optionalString(nodeRecord, 'label', MAX_NODE_STRING_BYTES);
    const value = optionalString(nodeRecord, 'value', MAX_NODE_STRING_BYTES);
    const labelTruncated = flag(nodeRecord, 'labelTruncated');
    const valueTruncated = flag(nodeRecord, 'valueTruncated');
    const redacted = flag(nodeRecord, 'redacted');
    const roleTruncated = flag(nodeRecord, 'roleTruncated');
    const subroleTruncated = flag(nodeRecord, 'subroleTruncated');
    if (depth === null || depth > 64 || role === null || !subrole.ok || !label.ok || !value.ok
      || labelTruncated === null || valueTruncated === null || redacted === null
      || roleTruncated === null || subroleTruncated === null) return null;
    const frame=nodeRecord.frame===undefined?null:parseFrame(nodeRecord.frame);
    const textRegions=nodeRecord.textRegions===undefined?null:parseTextRegions(nodeRecord.textRegions);
    if(nodeRecord.frame!==undefined&&!frame||nodeRecord.textRegions!==undefined&&!textRegions)return null;
    nodes.push({
      ...(!redacted&&frame?{frame}:{}),...(!redacted&&textRegions?{textRegions}:{}),
      depth, role, subrole: subrole.value, label: redacted?null:label.value, value: redacted?null:value.value,
      labelTruncated, valueTruncated, redacted, roleTruncated, subroleTruncated,
    });
  }

  if (record.quality !== 'full' && record.quality !== 'partial') return null;
  const truncated = flag(record, 'truncated');
  if (truncated === null) return null;
  if (!Array.isArray(record.truncations) || record.truncations.length > MAX_TRUNCATION_NAMES) return null;
  const truncations: string[] = [];
  for (const entry of record.truncations) {
    if (typeof entry !== 'string' || !TRUNCATION_NAMES.has(entry) || truncations.includes(entry)) return null;
    truncations.push(entry);
  }

  const statsRecord = asRecord(record.stats);
  if (!statsRecord) return null;
  const visitedNodes = count(statsRecord, 'visitedNodes');
  const emittedNodes = count(statsRecord, 'emittedNodes');
  const maxDepthReached = count(statsRecord, 'maxDepthReached');
  const estimatedBytes = count(statsRecord, 'estimatedBytes');
  if (visitedNodes === null || emittedNodes === null || maxDepthReached === null || estimatedBytes === null) return null;
  if (emittedNodes !== nodes.length || visitedNodes < emittedNodes) return null;

  return {
    kind: 'desktop_observe',
    observedAtMs: record.observedAtMs,
    projectId: expectedProjectId,
    application: { pid, bundleId, name, bundleIdTruncated, nameTruncated },
    window: { ...(windowFrame?{frame:windowFrame}:{}),...(windowId?{id:windowId}:{}),role: windowRole, roleTruncated: windowRoleTruncated, title: windowTitle, titleTruncated: windowTitleTruncated },
    nodes,
    quality: record.quality,
    truncated,
    truncations,
    stats: { visitedNodes, emittedNodes, maxDepthReached, estimatedBytes },
  };
}

/** A failure detail is category evidence, not data: control characters stripped and byte-bounded. */
function sanitizeDetail(value: string): string | null {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!cleaned) return null;
  let kept = '';
  let used = 0;
  for (const character of cleaned) {
    const width = Buffer.byteLength(character, 'utf8');
    if (used + width > MAX_DETAIL_BYTES) break;
    used += width;
    kept += character;
  }
  return kept;
}

/** One well-formed native line becomes either validated evidence or one of the stable failures. */
function parseResponseLine(line: string, projectId: string, maxNodes: number): DesktopObserveResult {
  const trimmed = line.trim();
  if (!trimmed) return { outcome: 'malformed_response' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { outcome: 'malformed_response' };
  }
  const record = asRecord(parsed);
  if (!record || typeof record.ok !== 'boolean') return { outcome: 'malformed_response' };
  if (record.ok) {
    const result = asRecord(record.result);
    if (!result || result.type !== 'json' || typeof result.payload !== 'string') return { outcome: 'malformed_response' };
    const evidence = parseEvidence(result.payload, projectId, maxNodes);
    return evidence ? { outcome: 'observed', evidence } : { outcome: 'malformed_response' };
  }
  if (typeof record.error !== 'string' || Buffer.byteLength(record.error, 'utf8') > MAX_ERROR_BYTES) {
    return { outcome: 'malformed_response' };
  }
  const match = /^observe:(accessibility_denied|excluded_application|no_window|empty_evidence)(?::(.*))?$/.exec(record.error);
  if (!match) return { outcome: 'native_error' };
  const detail = match[2] ? sanitizeDetail(match[2]) : null;
  return { outcome: 'denied', code: match[1] as DesktopObserveDenialCode, detail };
}

function isMissingExecutable(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function defaultSpawn(command: string, args: readonly string[]): DesktopObserveChild {
  return spawn(command, [...args], {
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
    // The helper needs none of this parent's environment (and in particular none of its secrets).
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      TMPDIR: process.env.TMPDIR ?? '',
      LANG: process.env.LANG ?? '',
    },
  }) as unknown as DesktopObserveChild;
}

export function createDesktopObserveHost(options: DesktopObserveHostOptions): DesktopObserveHost {
  const bundleDir = resolve(options.bundleDir);
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const runSpawn = options.spawn ?? defaultSpawn;
  const timeoutMs = normalizeLimit(options.timeoutMs, DESKTOP_OBSERVE_TIMEOUT_MS);
  const maxResponseBytes = normalizeLimit(options.maxResponseBytes, DESKTOP_OBSERVE_MAX_RESPONSE_BYTES);
  const maxEvidenceNodes = normalizeLimit(options.maxEvidenceNodes, DESKTOP_OBSERVE_MAX_EVIDENCE_NODES);
  const candidates = options.helperPath ? [explicitHelperPath(bundleDir, options.helperPath)] : desktopHelperCandidates(bundleDir, env);

  function runObservation(helper: string, projectId: string, allowLocalOCR:boolean): Promise<DesktopObserveResult> {
    return new Promise((resolveResult) => {
      let settled = false;
      let buffer = '';
      let timeout: NodeJS.Timeout | null = null;
      let escalation: NodeJS.Timeout | null = null;
      let child: DesktopObserveChild;

      function finish(result: DesktopObserveResult): void {
        if (settled) return;
        settled = true;
        if (timeout) {
          clearTimeout(timeout);
          timeout = null;
        }
        try {
          child.kill('SIGTERM');
        } catch {
          // The child may already be gone; the result is already decided.
        }
        escalation = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // Escalation is best effort: the child may have exited between the two signals.
          }
        }, KILL_ESCALATION_MS);
        escalation.unref?.();
        resolveResult(result);
      }

      try {
        child = runSpawn(helper, []);
      } catch (error) {
        resolveResult(isMissingExecutable(error) ? { outcome: 'helper_missing', searched: [helper] } : { outcome: 'crashed' });
        return;
      }

      if (!child.stdin || !child.stdout) {
        finish({ outcome: 'crashed' });
        return;
      }

      child.stdout.setEncoding?.('utf8');
      child.stdout.on('data', (chunk: string | Buffer) => {
        buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        const newline = buffer.indexOf('\n');
        if (newline < 0) {
          if (Buffer.byteLength(buffer, 'utf8') > maxResponseBytes) finish({ outcome: 'response_too_large' });
          return;
        }
        const line = buffer.slice(0, newline);
        finish(Buffer.byteLength(line, 'utf8') > maxResponseBytes
          ? { outcome: 'response_too_large' }
          : parseResponseLine(line, projectId, maxEvidenceNodes));
      });
      child.on('error', (error: Error) => {
        finish(isMissingExecutable(error) ? { outcome: 'helper_missing', searched: [helper] } : { outcome: 'crashed' });
      });
      child.on('exit', () => finish({ outcome: 'crashed' }));

      timeout = setTimeout(() => finish({ outcome: 'timeout' }), timeoutMs);
      try {
        child.stdin.write(`${JSON.stringify({
          operation: 'observe',
          ...(allowLocalOCR?{allowLocalOCR:true}:{}),
          scope: { profileId: 'local', projectId, sensitivity: 'normal' },
        })}\n`);
      } catch {
        finish({ outcome: 'crashed' });
      }
    });
  }

  return Object.freeze({
    async observe(request: Readonly<{ projectId: unknown; allowLocalOCR?:boolean }>): Promise<DesktopObserveResult> {
      const projectId = normalizeProjectId(request.projectId);
      if (projectId === null) return { outcome: 'invalid_scope' };
      const helper = candidates.find((candidate) => exists(candidate));
      if (!helper) return { outcome: 'helper_missing', searched: [...candidates] };
      return runObservation(helper, projectId,request.allowLocalOCR===true);
    },
  });
}
