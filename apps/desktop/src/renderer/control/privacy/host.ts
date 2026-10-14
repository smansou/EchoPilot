/**
 * How a window resolves the privacy operations its desktop host bound to it.
 *
 * The renderer is sandboxed: it holds no store, no directory and no key, so the profile service it
 * drives lives in the host process (`profile-host.ts` is the reference binding) and is installed on
 * the window as `window.echoPrivacy`. This module is the boundary between the two, and it is strict
 * on purpose: a host message that does not match the contract is refused rather than half-read, and
 * when no host bound a profile at all the returned operations fail with the reason instead of
 * pretending a choice was stored.
 *
 * It is the renderer half of production wiring: `main.tsx` resolves its control through here, so an
 * unbound window renders an explicit "no profile" state and a bound window drives the real service.
 */
import type { PrivacyForgetSelection, PrivacyOperations, PrivacySessionEntry } from './index.js';

export const UNBOUND_HOST_REASON = 'No memory profile is bound to this window: the desktop host has not connected one, so nothing can be forgotten, exported, restored or kept private yet.';

export type PrivacyHostResolution = Readonly<{
  operations: PrivacyOperations;
  /** True when a host binding was accepted; false makes every operation fail with `reason`. */
  bound: boolean;
  /** Why no profile is bound, for the UI to show; null when the binding was accepted. */
  reason: string | null;
}>;

type Binding = Readonly<{
  forget: (request: PrivacyForgetSelection) => Promise<unknown>;
  exportProfile: (request: Readonly<{ passphrase: string }>) => Promise<unknown>;
  importProfile: (request: Readonly<{ archive: string; passphrase: string }>) => Promise<unknown>;
  beginPrivateSession?: (request: Readonly<{ sessionId: string }>) => Promise<unknown> | unknown;
  endPrivateSession?: (request: Readonly<{ sessionId: string }>) => Promise<unknown> | unknown;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFunction(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === 'function';
}

/** A receipt is only trusted once its shape is: the renderer never prints counts it did not check. */
function countOf(value: unknown, field: string): number {
  if (!isRecord(value)) throw new TypeError(`privacy host returned no ${field} in its receipt`);
  const count = value[field];
  if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) {
    throw new TypeError(`privacy host returned an invalid ${field} in its receipt`);
  }
  return count;
}

function filesOf(value: unknown): readonly string[] {
  if (!isRecord(value) || !Array.isArray(value.files)) throw new TypeError('privacy host returned no file list');
  const files: string[] = [];
  for (const file of value.files) {
    if (typeof file !== 'string' || file.length === 0) throw new TypeError('privacy host returned an invalid file list');
    files.push(file);
  }
  return files;
}

function transcriptOf(value: unknown): readonly PrivacySessionEntry[] {
  if (!Array.isArray(value)) throw new TypeError('privacy host returned no private transcript');
  return value.map((entry) => {
    if (!isRecord(entry) || typeof entry.sequence !== 'number' || typeof entry.text !== 'string') {
      throw new TypeError('privacy host returned an invalid private transcript');
    }
    return {
      sequence: entry.sequence,
      kind: typeof entry.kind === 'string' ? entry.kind : 'event',
      text: entry.text,
      at: typeof entry.at === 'string' ? entry.at : '',
    };
  });
}

function parseBinding(value: unknown): Binding | null {
  if (!isRecord(value)) return null;
  if (!isFunction(value.forget) || !isFunction(value.exportProfile) || !isFunction(value.importProfile)) return null;
  return value as unknown as Binding;
}

function operationsOf(binding: Binding): PrivacyOperations {
  return {
    bound: true,
    forget: async (selection) => {
      const receipt = await binding.forget(selection);
      return { deleted: countOf(receipt, 'deleted'), condensed: countOf(receipt, 'condensed') };
    },
    exportProfile: async ({ passphrase }) => {
      const receipt = await binding.exportProfile({ passphrase });
      return {
        files: filesOf(receipt),
        ...(isRecord(receipt) && typeof receipt.destination === 'string' ? { destination: receipt.destination } : {}),
      };
    },
    importProfile: async ({ archive, passphrase }) => ({ files: filesOf(await binding.importProfile({ archive, passphrase })) }),
    ...(binding.beginPrivateSession === undefined
      ? {}
      : { beginPrivateSession: async ({ sessionId }: Readonly<{ sessionId: string }>) => { await binding.beginPrivateSession?.({ sessionId }); } }),
    ...(binding.endPrivateSession === undefined
      ? {}
      : { endPrivateSession: async ({ sessionId }: Readonly<{ sessionId: string }>) => transcriptOf(await binding.endPrivateSession?.({ sessionId })) }),
  };
}

function unboundOperations(): PrivacyOperations {
  const unavailable = async (): Promise<never> => {
    throw new Error(UNBOUND_HOST_REASON);
  };
  return { bound: false, forget: unavailable, exportProfile: unavailable, importProfile: unavailable };
}

/**
 * Resolves the profile service the host bound to this window as `window.echoPrivacy`. Callers that
 * inject their own source (tests, or a host-provided object) get the same strict parsing.
 */
export function resolvePrivacyOperations(source?: unknown): PrivacyHostResolution {
  const candidate = source === undefined ? (globalThis as { echoPrivacy?: unknown }).echoPrivacy : source;
  const binding = parseBinding(candidate);
  if (binding === null) return { operations: unboundOperations(), bound: false, reason: UNBOUND_HOST_REASON };
  return { operations: operationsOf(binding), bound: true, reason: null };
}
