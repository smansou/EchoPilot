import { spawn } from 'node:child_process';

export interface ProcessOptions {
  command: string; args: string[]; cwd: string; input?: string;
  timeoutMs?: number; signal?: AbortSignal; maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
  onSpawn?: (pid: number) => void;
  onStdoutLine?: (line: string) => void;
}
export interface ProcessResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; aborted: boolean }

/** No shell, bounded retained output, and process-group cancellation on macOS/Linux. */
export async function runProcess(options: ProcessOptions): Promise<ProcessResult> {
  if (options.signal?.aborted) return { code: null, stdout: '', stderr: '', timedOut: false, aborted: true };
  return new Promise((resolve) => {
    const child = spawn(options.command, options.args, { cwd: options.cwd, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...options.env } });
    const limit = options.maxOutputBytes ?? 128 * 1024;
    let stdout: Buffer = Buffer.alloc(0), stderr: Buffer = Buffer.alloc(0);
    let lineBuffer = '', timedOut = false, aborted = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const append = (old: Buffer, chunk: Buffer): Buffer => Buffer.concat([old, chunk]).subarray(-limit);
    const kill = (signal: NodeJS.Signals) => {
      try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, signal); else child.kill(signal); } catch { /* already exited */ }
    };
    const stop = () => { kill('SIGTERM'); killTimer ??= setTimeout(() => kill('SIGKILL'), 1500); };
    const abort = () => { aborted = true; stop(); };
    options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs ?? 20 * 60_000);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk);
      if (options.onStdoutLine) {
        lineBuffer += chunk.toString('utf8');
        let newline: number;
        while ((newline = lineBuffer.indexOf('\n')) !== -1) {
          const line = lineBuffer.slice(0, newline); lineBuffer = lineBuffer.slice(newline + 1);
          try { options.onStdoutLine(line); } catch { /* observer cannot break lifecycle */ }
        }
        if (lineBuffer.length > limit) lineBuffer = '';
      }
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.stdin.on('error', () => { /* child may exit before consuming input */ });
    child.on('error', (error) => { stderr = append(stderr, Buffer.from(error.message)); });
    child.on('spawn', () => { if (child.pid) { try { options.onSpawn?.(child.pid); } catch { /* diagnostics cannot break lifecycle */ } } });
    child.on('close', (code) => {
      if (timedOut || aborted) kill('SIGKILL');
      clearTimeout(timer); if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', abort);
      if (lineBuffer && options.onStdoutLine) { try { options.onStdoutLine(lineBuffer); } catch { /* observer */ } }
      resolve({ code, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), timedOut, aborted });
    });
    child.stdin.end(options.input ?? '');
  });
}
