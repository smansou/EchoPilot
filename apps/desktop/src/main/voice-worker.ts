/**
 * V05 conversation-model residency.
 *
 * In the product, the process that holds the conversation models is the local voice worker
 * (`echopilot-voice`): it loads the pinned ASR pack, owns the microphone graph for the
 * conversation, and streams transcript updates while the user talks. The activation lifecycle's
 * `loadConversationModels` / `unloadConversationModels` are therefore *process residency*
 * operations:
 *
 *   load    → the worker starts and completes its authenticated hello (models resident)
 *   open    → `{"type":"start"}` (microphone capture begins; the worker reports `listening`)
 *   close   → `{"type":"close"}` (capture released, weights freed, process exits)
 *   unload  → the process is gone, so nothing is left resident
 *
 * That mapping is what makes "default idle closes the mic and unloads models" a real teardown
 * instead of a bookkeeping flag: the memory and the capture device are released by process exit.
 * Transcript frames are the conversation's activity source, so a 20-minute exchange keeps the
 * session alive without any UI interaction.
 *
 * This module has no electron imports: the deterministic tests drive a real child process through
 * the same supervisor shape (see `voice-activation.test.ts`).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export type VoiceWorkerCommand = Readonly<{
  command: string;
  args: ReadonlyArray<string>;
  description: string;
}>;

/**
 * Where the conversation worker binary lives. `ECHOPILOT_VOICE_WORKER` wins so a developer can
 * point at a debug build; otherwise the bundled helper locations are tried.
 */
export function resolveVoiceWorkerCommand(
  env: NodeJS.ProcessEnv = process.env,
  moduleDir: string = typeof __dirname === 'string' ? __dirname : process.cwd(),
): VoiceWorkerCommand | null {
  const candidates = [
    env.ECHOPILOT_VOICE_WORKER,
    resolve(moduleDir, '../native/echopilot-voice'),
    resolve(process.cwd(), 'native/macos/.build/debug/echopilot-voice'),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (!existsSync(candidate)) continue;
    // A TypeScript stand-in (the deterministic test's fake worker) is spawned through tsx, exactly
    // like the native host's TypeScript fake; real builds point at the signed binary.
    if (/\.(ts|tsx|mts)$/.test(candidate)) {
      return { command: process.execPath, args: ['--import', 'tsx', candidate], description: candidate };
    }
    return { command: candidate, args: [], description: candidate };
  }
  return null;
}

export type VoiceWorkerHost = Readonly<{
  describe(): string;
  loaded(): boolean;
  load(): Promise<void>;
  openMicrophone(): Promise<void>;
  closeMicrophone(): Promise<void>;
  unload(): Promise<void>;
  /** Transcript activity: the conversation's speech, never a UI keepalive. */
  onActivity(listener: () => void): () => void;
  onFailure(listener: (message: string) => void): () => void;
  dispose(): void;
}>;

export type VoiceWorkerOptions = Readonly<{
  command: VoiceWorkerCommand | null;
  env?: NodeJS.ProcessEnv;
  /** Model pack locations handed to the worker; unset means "whatever the bundle exported". */
  modelDir?: string;
  sileroModelDir?: string;
  helloTimeoutMs?: number;
  startTimeoutMs?: number;
  closeTimeoutMs?: number;
  log?(message: string): void;
}>;

type Waiter = Readonly<{
  kind: 'hello' | 'listening';
  resolve(): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}>;

export function createVoiceWorkerHost(options: VoiceWorkerOptions): VoiceWorkerHost {
  const { command } = options;
  const env = options.env ?? process.env;
  const helloTimeoutMs = options.helloTimeoutMs ?? 20_000;
  const startTimeoutMs = options.startTimeoutMs ?? 10_000;
  const closeTimeoutMs = options.closeTimeoutMs ?? 3_000;
  const log = options.log ?? (() => {});

  let child: ChildProcess | null = null;
  let buffer = '';
  let waiter: Waiter | null = null;
  let closing = false;
  let disposed = false;
  const activityListeners = new Set<() => void>();
  const failureListeners = new Set<(message: string) => void>();

  function reportFailure(message: string): void {
    for (const listener of failureListeners) {
      try { listener(message); } catch { /* a consumer must not break the worker supervisor */ }
    }
  }

  function settle(waiter_: Waiter, error?: Error): void {
    if (waiter !== waiter_) return;
    waiter = null;
    clearTimeout(waiter_.timer);
    if (error) waiter_.reject(error);
    else waiter_.resolve();
  }

  function handleFrames(raw: string, handler: (message: Record<string, unknown>) => void): void {
    buffer += raw;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        let parsed: unknown;
        try { parsed = JSON.parse(line); } catch { parsed = undefined; }
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          handler(parsed as Record<string, unknown>);
        } else {
          log('voice worker sent an unparseable frame');
        }
      }
      newline = buffer.indexOf('\n');
    }
  }

  function onMessage(message: Record<string, unknown>): void {
    const type = message.type;
    if (type === 'hello' || type === 'status') {
      const status = typeof message.status === 'object' && message.status !== null
        ? message.status as Record<string, unknown>
        : {};
      const ready = type === 'hello' || status.input === 'listening';
      if (waiter && (waiter.kind === 'hello' || (waiter.kind === 'listening' && ready))) settle(waiter);
      return;
    }
    if (type === 'transcript') {
      // Any partial or final transcript means the user is talking: that renews the session.
      for (const listener of activityListeners) {
        try { listener(); } catch { /* activity consumers are best-effort */ }
      }
      return;
    }
    if (type === 'error') {
      const error = typeof message.error === 'object' && message.error !== null
        ? message.error as Record<string, unknown>
        : {};
      const detail = typeof error.message === 'string' ? error.message : 'voice worker reported an error';
      reportFailure(detail);
      if (waiter) settle(waiter, new Error(detail));
    }
  }

  function waitFor(kind: Waiter['kind'], timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve_, reject_) => {
      if (waiter) {
        reject_(new Error('voice worker is already handling another lifecycle step'));
        return;
      }
      const next: Waiter = {
        kind,
        resolve: resolve_,
        reject: reject_,
        timer: setTimeout(() => {
          if (waiter === next) {
            waiter = null;
            reject_(new Error(kind === 'hello'
              ? 'Conversation models did not load in time.'
              : 'The microphone did not open in time.'));
          }
        }, timeoutMs),
      };
      next.timer.unref?.();
      waiter = next;
    });
  }

  function handleExit(reason: string): void {
    child = null;
    buffer = '';
    if (waiter) settle(waiter, new Error(reason));
    if (!closing && !disposed) reportFailure(reason);
  }

  async function closeMicrophone(): Promise<void> {
    const running = child;
    if (!running) return;
    closing = true;
    const exited = new Promise<void>((resolve_) => { running.once('exit', () => resolve_()); });
    running.stdin?.write('{"type":"close"}\n');
    const timer = setTimeout(() => { running.kill('SIGTERM'); }, closeTimeoutMs);
    timer.unref?.();
    await exited;
    clearTimeout(timer);
    closing = false;
  }

  async function unload(): Promise<void> {
    await closeMicrophone();
    child = null;
  }

  return Object.freeze({
    describe: () => (command ? `local voice worker (${command.description})` : 'no local voice worker found'),
    loaded: () => child !== null,
    async load() {
      if (child) return;
      if (!command) {
        throw new Error('Conversation models are not installed: no local voice worker binary was found.');
      }
      buffer = '';
      closing = false;
      const spawned = spawn(command.command, [...command.args], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...env,
          ...(options.modelDir ? { ECHOPILOT_ASR_MODEL_DIR: options.modelDir } : {}),
          ...(options.sileroModelDir ? { ECHOPILOT_SILERO_MODEL_DIR: options.sileroModelDir } : {}),
        },
      });
      child = spawned;
      const hello = waitFor('hello', helloTimeoutMs);
      spawned.stdout?.setEncoding('utf8');
      spawned.stdout?.on('data', (chunk: string) => handleFrames(chunk, onMessage));
      spawned.stderr?.setEncoding('utf8');
      spawned.stderr?.on('data', (chunk: string) => log(`voice worker stderr: ${chunk.trim()}`));
      spawned.on('error', (error: Error) => {
        log(`voice worker spawn failed: ${error.message}`);
        handleExit(`Voice worker could not start: ${error.message}`);
      });
      spawned.on('exit', (code, signal) => {
        handleExit(`Voice worker exited (${signal ?? `code ${String(code)}`}).`);
      });
      log(`voice worker started: ${command.description}`);
      await hello;
    },
    async openMicrophone() {
      if (!child?.stdin) throw new Error('Conversation models are not resident.');
      const ready = waitFor('listening', startTimeoutMs);
      child.stdin.write('{"type":"start"}\n');
      await ready;
    },
    closeMicrophone,
    unload,
    onActivity(listener) {
      activityListeners.add(listener);
      return () => { activityListeners.delete(listener); };
    },
    onFailure(listener) {
      failureListeners.add(listener);
      return () => { failureListeners.delete(listener); };
    },
    dispose() {
      disposed = true;
      closing = true;
      const running = child;
      child = null;
      running?.kill('SIGTERM');
    },
  });
}
