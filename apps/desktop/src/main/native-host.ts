/**
 * F02 signed native helper supervisor.
 *
 * The helper is a separate process that speaks newline-delimited JSON over stdout. Every message
 * must echo the per-launch token issued by `createShell`; anything malformed or unauthenticated is
 * rejected by the shell without touching widget state. A helper exit moves the widget into the
 * recoverable disconnected state and schedules a bounded restart.
 *
 * TypeScript developers without Xcode: point `ECHOPILOT_NATIVE_HOST` at
 * `apps/desktop/src/main/fake-native-host.ts` (spawned through tsx), or let the supervisor fall
 * back to the in-process simulator when no signed helper binary is on disk.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Shell, WidgetStatus } from './shell';

export type NativeHostMode = 'helper' | 'simulator';

export type NativeHostOptions = Readonly<{
  shell: Shell;
  token: string;
  env?: NodeJS.ProcessEnv;
  log?(message: string): void;
  restartDelayMs?: number;
  /** Latency floor for restarts; bounded exponential backoff. */
  maxRestartDelayMs?: number;
}>;

export type NativeHost = Readonly<{
  mode: NativeHostMode;
  describe(): string;
  start(): void;
  stop(): void;
  dispose(): void;
  isRunning(): boolean;
  /** Test/dev hook: drive the recoverable disconnect → reconnect path without killing a process. */
  simulateDisconnect(): WidgetStatus;
}>;

type HelperCommand = Readonly<{ command: string; args: ReadonlyArray<string>; description: string }>;

function resolveHelperCommand(token: string, env: NodeJS.ProcessEnv): HelperCommand | null {
  // The packaged app is bundled as CJS (where __dirname exists); tsx-driven dev checks are ESM.
  const moduleDir = typeof __dirname === 'string' ? __dirname : process.cwd();
  const candidates: string[] = [];
  if (env.ECHOPILOT_NATIVE_HOST) candidates.push(env.ECHOPILOT_NATIVE_HOST);
  candidates.push(resolve(moduleDir, '../native/PlatformHost'));
  candidates.push(resolve(process.cwd(), 'dist/native/PlatformHost'));

  for (const candidate of candidates) {
    if (!candidate) continue;
    const isTypeScript = /\.(ts|tsx|mts)$/.test(candidate);
    if (!isTypeScript && !existsSync(candidate)) continue;
    if (isTypeScript) {
      // TypeScript developers without Xcode: run the fake host through tsx.
      return {
        command: process.execPath,
        args: ['--import', 'tsx', candidate, `--token=${token}`],
        description: candidate,
      };
    }
    // A signed binary helper is launched directly; the token travels on argv only.
    return { command: candidate, args: [`--token=${token}`], description: candidate };
  }
  return null;
}

function simulatorHello(token: string): string {
  return JSON.stringify({
    type: 'hello',
    protocolVersion: 1,
    token,
    status: {
      microphone: 'granted',
      capture: 'denied',
      output: 'ready',
      targetSession: 'simulated-session',
      provider: 'local',
    },
  });
}

export function createNativeHost(options: NativeHostOptions): NativeHost {
  const { shell, token } = options;
  const env = options.env ?? process.env;
  const baseDelay = options.restartDelayMs ?? 500;
  const maxDelay = options.maxRestartDelayMs ?? 5_000;
  const log = options.log ?? (() => {});
  const helper = resolveHelperCommand(token, env);
  const mode: NativeHostMode = helper ? 'helper' : 'simulator';

  let child: ChildProcess | null = null;
  let buffer = '';
  let restartDelay = baseDelay;
  let restartTimer: NodeJS.Timeout | null = null;
  let simulatorTimer: NodeJS.Timeout | null = null;
  let disposed = false;
  let stopping = false;

  function ingest(raw: string): void {
    let kind: unknown;
    try {
      kind = (JSON.parse(raw) as { type?: unknown }).type;
    } catch {
      kind = undefined;
    }
    if (kind === 'log') {
      log(`helper: ${raw}`);
      return;
    }
    const result = shell.ingestNativeMessage(raw);
    if (!result.ok) log(`rejected helper message: ${result.reason}`);
  }

  function scheduleRestart(): void {
    if (disposed || restartTimer) return;
    const delay = restartDelay;
    restartDelay = Math.min(restartDelay * 2, maxDelay);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (!disposed) start();
    }, delay);
    restartTimer.unref?.();
  }

  function handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    child = null;
    if (stopping || disposed) return;
    shell.nativeHostDisconnected(
      `Native helper exited (${signal ?? `code ${String(code)}`}); reconnecting.`,
    );
    scheduleRestart();
  }

  function start(): void {
    if (disposed || child) return;
    if (!helper) {
      simulatorTimer = setTimeout(() => {
        simulatorTimer = null;
        if (!disposed) ingest(simulatorHello(token));
      }, 0);
      simulatorTimer.unref?.();
      return;
    }
    stopping = false;
    buffer = '';
    const spawned = spawn(helper.command, [...helper.args], { stdio: ['pipe', 'pipe', 'pipe'], env });
    child = spawned;
    spawned.stdout?.setEncoding('utf8');
    spawned.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) ingest(line);
        newline = buffer.indexOf('\n');
      }
    });
    spawned.stderr?.setEncoding('utf8');
    spawned.stderr?.on('data', (chunk: string) => log(`helper stderr: ${chunk.trim()}`));
    spawned.on('error', (error: Error) => {
      log(`helper spawn failed: ${error.message}`);
      handleExit(null, null);
    });
    spawned.on('exit', handleExit);
    restartDelay = baseDelay;
    log(`native helper started: ${helper.description}`);
  }

  function stop(): void {
    stopping = true;
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    const running = child;
    child = null;
    running?.kill('SIGTERM');
  }

  return Object.freeze({
    mode,
    describe: () => (helper ? `signed helper (${helper.description})` : 'in-process simulator (no signed helper found)'),
    start,
    stop,
    isRunning: () => child !== null,
    simulateDisconnect: () => {
      const status = shell.nativeHostDisconnected('Native helper disconnected; reconnecting.');
      if (mode === 'simulator' && !disposed) {
        simulatorTimer = setTimeout(() => {
          simulatorTimer = null;
          if (!disposed) ingest(simulatorHello(token));
        }, baseDelay);
        simulatorTimer.unref?.();
      }
      return status;
    },
    dispose: () => {
      disposed = true;
      if (simulatorTimer) clearTimeout(simulatorTimer);
      stop();
    },
  });
}
