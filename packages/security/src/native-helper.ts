import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { CaptureOperation, CaptureRequest } from './types';

/** Capabilities the macOS helper advertises to its parent at handshake time. */
export type NativeHelperCapability = 'keychain.put' | 'keychain.get' | 'keychain.delete' | 'capture.screen';

export type NativeHelperBridge = {
  readonly capabilities: ReadonlyArray<string>;
  request<T>(capability: string, params?: Record<string, unknown>): Promise<T>;
  dispose(): void;
};

export type NativeHelperOptions = {
  helperPath: string;
  /** Per-request timeout; the helper is a local child process, not a network service. */
  timeoutMs?: number;
  startupTimeoutMs?: number;
};

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Spawns the macOS helper and speaks one JSON object per line over its stdio pipes. The helper is
 * reachable from this parent process only — it listens on no port and accepts no other client — so
 * native capabilities (`keychain.*`, `capture.screen`) are registered through the private parent
 * channel and every secret stays on the stdin pipe rather than in argv or the environment.
 */
export function createNativeHelperBridge(options: NativeHelperOptions): NativeHelperBridge {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const startupTimeoutMs = options.startupTimeoutMs ?? 5_000;
  const pending = new Map<string, PendingRequest>();
  let child: ChildProcessWithoutNullStreams | null = null;
  let ready: Promise<void> | null = null;
  let resolveReady: (() => void) | null = null;
  let rejectReady: ((error: Error) => void) | null = null;
  let capabilities: ReadonlyArray<string> = [];
  let disposed = false;
  let nextId = 0;

  const settleReady = (error?: Error): void => {
    if (error) rejectReady?.(error);
    else resolveReady?.();
    resolveReady = null;
    rejectReady = null;
  };

  const failAll = (error: Error): void => {
    settleReady(error);
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      pending.delete(id);
      entry.reject(error);
    }
  };

  const handleLine = (line: string): void => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let message: unknown;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return; // Stray helper diagnostics must never corrupt the protocol.
    }
    if (typeof message !== 'object' || message === null) return;
    const record = message as Record<string, unknown>;
    if (record.event === 'ready') {
      capabilities = Array.isArray(record.capabilities)
        ? record.capabilities.filter((capability): capability is string => typeof capability === 'string')
        : [];
      settleReady();
      return;
    }
    const id = typeof record.id === 'string' ? record.id : null;
    if (id === null) return;
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    if (record.ok === true) entry.resolve(record.result);
    else entry.reject(new Error(errorMessage(record.error)));
  };

  const start = (): Promise<void> => {
    if (ready) return ready;
    ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
      let spawned: ChildProcessWithoutNullStreams;
      try {
        spawned = spawn(options.helperPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (error) {
        failAll(new Error(`native helper could not be started (${options.helperPath}): ${errorMessage(error)}`));
        return;
      }
      child = spawned;
      spawned.stdin.on('error', () => undefined);
      spawned.on('error', (error) => failAll(new Error(`native helper failed (${options.helperPath}): ${error.message}`)));
      spawned.on('exit', (code, signal) => failAll(new Error(`native helper exited (code ${code ?? 'null'}, signal ${signal ?? 'none'})`)));
      spawned.stdout.setEncoding('utf8');
      let buffer = '';
      spawned.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        let index = buffer.indexOf('\n');
        while (index >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          handleLine(line);
          index = buffer.indexOf('\n');
        }
      });
      spawned.stderr.setEncoding('utf8');
      spawned.stderr.on('data', () => undefined); // Diagnostics stay in the child; never echoed or logged here.
      const startupTimer = setTimeout(() => {
        if (resolveReady !== null) failAll(new Error(`native helper did not complete its handshake within ${startupTimeoutMs}ms`));
      }, startupTimeoutMs);
      startupTimer.unref?.();
    });
    return ready;
  };

  return {
    get capabilities(): ReadonlyArray<string> {
      return capabilities;
    },
    async request<T>(capability: string, params: Record<string, unknown> = {}): Promise<T> {
      if (disposed) throw new Error('native helper bridge is disposed');
      await start();
      if (!capabilities.includes(capability)) {
        throw new Error(`native helper does not advertise capability '${capability}'`);
      }
      const process = child;
      if (!process) throw new Error('native helper is not running');
      const id = `req-${++nextId}`;
      return await new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`native helper call '${capability}' timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref?.();
        pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
        process.stdin.write(`${JSON.stringify({ id, capability, params })}\n`, (error) => {
          if (error) {
            const entry = pending.get(id);
            if (!entry) return;
            pending.delete(id);
            clearTimeout(entry.timer);
            entry.reject(new Error(`native helper write failed: ${error.message}`));
          }
        });
      });
    },
    dispose(): void {
      disposed = true;
      failAll(new Error('native helper bridge was disposed'));
      child?.kill();
      child = null;
    },
  };
}

/** The fake/native capture capability used as the local executor of authorized operations. */
export function createNativeCaptureOperation(bridge: NativeHelperBridge): CaptureOperation {
  return {
    async invoke(request: CaptureRequest): Promise<{ artifactRef: string }> {
      const result = await bridge.request<{ artifactRef?: unknown }>('capture.screen', {
        requestId: request.requestId,
        capability: request.capability,
        resource: request.resource,
        dataCategory: request.dataCategory,
      });
      const artifactRef = typeof result?.artifactRef === 'string' ? result.artifactRef : '';
      if (artifactRef.length === 0) throw new Error('native capture returned no artifact reference');
      return { artifactRef };
    },
  };
}

function errorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }
  return 'native helper call failed';
}
