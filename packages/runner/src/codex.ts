import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { classifyFailure, type FailureKind } from './failures.js';
import { join } from 'node:path';
import { runProcess, type ProcessResult } from './process.js';

export interface WorkerResult { outcome: 'completed' | 'needs_attention'; summary: string; acceptanceEvidence: string[]; tests: string[]; risks: string[] }
export interface ReviewResult { verdict: 'approve' | 'request_changes'; summary: string; issues: string[] }
export interface Usage { inputTokens: number; cachedInputTokens: number; outputTokens: number }
export interface CodexOptions {
  cwd: string; prompt: string; model: string; effort: string; role: 'worker' | 'reviewer'; outputDirectory: string;
  command?: string; timeoutMs?: number; idleTimeoutMs?: number; signal?: AbortSignal;
  onSpawn?: (pid: number) => void;
  onQuiet?: () => void;
  onFailure?: (message:string, kind:FailureKind) => void;
  onEvent?: (event: { type: string; usage?: Usage }) => void;
}
export interface CodexResult { process: ProcessResult; result: WorkerResult | ReviewResult | null; usage: Usage; error?: string; failureKind?:FailureKind }
const stringArray = { type: 'array', items: { type: 'string' } };
export function resultSchema(role: CodexOptions['role']): object {
  const properties = role === 'worker' ? {
    outcome: { type: 'string', enum: ['completed', 'needs_attention'] }, summary: { type: 'string' }, acceptanceEvidence: stringArray, tests: stringArray, risks: stringArray,
  } : { verdict: { type: 'string', enum: ['approve', 'request_changes'] }, summary: { type: 'string' }, issues: stringArray };
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
}
export function parseResult(value: unknown, role: CodexOptions['role']): WorkerResult | ReviewResult {
  if (!value || typeof value !== 'object') throw new Error('Result is not an object');
  const data = value as Record<string, unknown>;
  const arrays = role === 'worker' ? ['acceptanceEvidence', 'tests', 'risks'] : ['issues'];
  if (typeof data.summary !== 'string' || arrays.some(key => !Array.isArray(data[key]) || !(data[key] as unknown[]).every(item => typeof item === 'string'))) throw new Error('Invalid structured result');
  if (role === 'worker' ? !['completed', 'needs_attention'].includes(String(data.outcome)) : !['approve', 'request_changes'].includes(String(data.verdict))) throw new Error('Invalid result outcome');
  return data as unknown as WorkerResult | ReviewResult;
}
export async function runCodex(options: CodexOptions): Promise<CodexResult> {
  await mkdir(options.outputDirectory, { recursive: true, mode: 0o700 });
  const schemaPath = join(options.outputDirectory, `${options.role}-schema.json`);
  const outputPath = join(options.outputDirectory, `${options.role}-result.json`);
  await writeFile(schemaPath, JSON.stringify(resultSchema(options.role)), { mode: 0o600 });
  // Truncate any previous result so a failed invocation cannot reuse stale approval.
  await writeFile(outputPath, '', { mode: 0o600 });
  const usage: Usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  const args = ['exec', '--ignore-user-config', '-c', 'approval_policy="never"', '-s', options.role === 'worker' ? 'workspace-write' : 'read-only', '-C', options.cwd, '-m', options.model, '-c', `model_reasoning_effort=${JSON.stringify(options.effort)}`, '--ephemeral', '--json', '--output-schema', schemaPath, '-o', outputPath, '-'];
  let failureMessage = '';
  // Structured events are not a liveness signal: reasoning and tool calls can be quiet.
  // Report quiet periods without killing work; runProcess owns the hard deadline.
  const idleMs = options.idleTimeoutMs ?? 180000;
  let idle = setTimeout(() => options.onQuiet?.(), idleMs);
  const touch = () => {clearTimeout(idle);idle=setTimeout(()=>options.onQuiet?.(),idleMs);};
  const result = await runProcess({ command: options.command ?? 'codex', args, cwd: options.cwd, input: options.prompt,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }), ...(options.signal ? {signal:options.signal} : {}),
    ...(options.onSpawn ? { onSpawn: options.onSpawn } : {}),
    onStdoutLine(line) {
      try {
        const event = JSON.parse(line) as { type?: string; message?:string; error?:{message?:string}; usage?: Record<string, unknown> };
        if (event.type) touch();
        if (event.type === 'error' || event.type === 'turn.failed') {
          failureMessage = String(event.message ?? event.error?.message ?? 'Codex request failed').slice(0,1500);
          options.onFailure?.(failureMessage, classifyFailure(failureMessage));
        }
        if (event.type === 'turn.completed' && event.usage) {
          const number = (key: string) => typeof event.usage?.[key] === 'number' && Number.isFinite(event.usage[key]) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(event.usage[key] as number))) : 0;
          usage.inputTokens = Math.min(Number.MAX_SAFE_INTEGER, usage.inputTokens + number('input_tokens')); usage.cachedInputTokens = Math.min(Number.MAX_SAFE_INTEGER, usage.cachedInputTokens + number('cached_input_tokens')); usage.outputTokens = Math.min(Number.MAX_SAFE_INTEGER, usage.outputTokens + number('output_tokens'));
        }
        if (event.type && ['thread.started', 'turn.started', 'turn.completed', 'turn.failed', 'item.started', 'item.completed', 'error'].includes(event.type)) options.onEvent?.({ type: event.type, ...(event.type === 'turn.completed' ? { usage: { ...usage } } : {}) });
      } catch { /* ignore malformed non-JSON diagnostic output */ }
    },
  });
  clearTimeout(idle);
  if (result.code !== 0 || result.timedOut || result.aborted || failureMessage) {
    const message = failureMessage || (result.aborted ? 'Cancelled' : result.timedOut ? 'Execution timed out; work retained.' : result.stderr.slice(-1500) || 'Codex exited without a result');
    return {process:result,result:null,usage,error:message,failureKind:classifyFailure(message)};
  }
  try { return { process: result, result: parseResult(JSON.parse(await readFile(outputPath, 'utf8')), options.role), usage }; }
  catch { return { process: result, result: null, usage, error: 'Codex did not produce a valid structured result' }; }
}
