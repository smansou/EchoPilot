import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createClaudeManagedSession, createClaudeHookObserver, installClaudeObservationHooks, removeClaudeObservationHooks, type ClaudeStreamTransport } from '../../../../packages/harness-claude/src/index';
import type { EventEnvelope } from '../../../../packages/contracts/src/index';
const exec = promisify(execFile);
const LIMIT = 80;
const safeText = (value: unknown) => typeof value === 'string' ? value.slice(0, 2_000) : '';
export type Attachment = { id: string; projectId: string; cwd: string; label: string; active: boolean; authenticated: boolean; mode: 'managed' | 'observe'; currentTurnId: string | null; pendingApproval: string | null; approvalText: string | null; events: { id: string; kind: string; text: string }[]; error: string | null; receipt: string | null; loginCommand: string | null };

/** Bounded, shell-free stdio transport shared by production CLI and a deterministic fake child. */
export function createClaudeChildTransport(options: { command: string; args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv; onFrame?(frame: Record<string, unknown>, raw: string): void }): ClaudeStreamTransport {
  let child: ChildProcessWithoutNullStreams | null = null; let ended = false; let buffer = ''; let bytes = 0;
  const queue: string[] = []; let wake: (() => void) | null = null;
  function end() { ended = true; wake?.(); wake = null; }
  async function close() { end(); if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
  return {
    async start() {
      if (child) throw Error('Claude child is already started.');
      child = spawn(options.command, [...options.args], { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdout.setEncoding('utf8'); child.stderr.resume();
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > 256_000) { void close(); return; }
        for (;;) {
          const newline = buffer.indexOf('\n'); if (newline < 0) break;
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          bytes += Buffer.byteLength(line);
          if (queue.length >= 256 || bytes > 1_048_576) { void close(); return; }
          try { const frame = JSON.parse(line); if (frame && typeof frame === 'object' && !Array.isArray(frame)) options.onFrame?.(frame, line); } catch { /* malformed output has no authority */ }
          queue.push(line); wake?.(); wake = null;
        }
      });
      child.on('exit', end); child.on('error', end);
      await new Promise<void>((resolve, reject) => { child!.once('spawn', resolve); child!.once('error', reject); });
    },
    async writeLine(line) {
      if (!child || ended || Buffer.byteLength(line) > 64_000) throw Error('Claude child is not writable.');
      await new Promise<void>((resolve, reject) => child!.stdin.write(`${line}\n`, error => error ? reject(error) : resolve()));
    },
    async *lines() {
      while (!ended || queue.length) {
        const line = queue.shift(); if (line !== undefined) { bytes -= Buffer.byteLength(line); yield line; }
        else await new Promise<void>(resolve => { wake = resolve; });
      }
    }, close,
  };
}

// Hooks retain event identity/categories only. Raw prompts, tool arguments and results are never spooled.
const metadataHook = `const fs=require('node:fs');const crypto=require('node:crypto');try{let raw='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>{raw+=c;if(raw.length>262144)process.exit(0)});process.stdin.on('end',()=>{const input=JSON.parse(raw);const hook={session_id:String(input.session_id||'').slice(0,256),hook_event_name:String(input.hook_event_name||'').slice(0,80),tool_use_id:String(input.tool_use_id||'').slice(0,256)};const installationId=process.env.ECHOPILOT_HOOK_INSTALLATION_ID;const key=crypto.createHash('sha256').update(JSON.stringify([installationId,hook])).digest('hex');const dir=process.env.ECHOPILOT_HOOK_SPOOL_DIR+'/incoming';fs.mkdirSync(dir,{recursive:true,mode:448});const target=dir+'/'+key+'.json';fs.writeFileSync(target,JSON.stringify({installationId,key,receivedAt:new Date().toISOString(),hook}),{mode:384});});}catch{process.exit(0)};`;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function createManagedAttachments(options: {
  directory: string;
  activeProject(): { projectId: string; cwd: string } | null;
  onEvent(event: EventEnvelope, payload: Record<string, unknown>): Promise<void>;
  isPrivate?(): boolean;
  command?: string;
  transport?: (input: { cwd: string; env: NodeJS.ProcessEnv; onFrame(frame: Record<string, unknown>, raw: string): void }) => ClaudeStreamTransport;
  authStatus?: (env: NodeJS.ProcessEnv, cwd: string) => Promise<boolean>;
}) {
  type Runtime = { view: Attachment; adapter: ReturnType<typeof createClaudeManagedSession> | null; observer: ReturnType<typeof createClaudeHookObserver> | null; env: NodeJS.ProcessEnv; config: string; installationId: string; spool: string; sending: boolean; collecting: boolean; frames: Map<string, Record<string, unknown>> };
  const sessions = new Map<string, Runtime>(); let disposed = false; let starting = 0;
  function project(projectId: string) { const selected = options.activeProject(); if (disposed || !selected || selected.projectId !== projectId) throw Error('Choose this active Work project first.'); return selected; }
  function session(projectId: string, id: string) { project(projectId); const runtime = sessions.get(id); if (!runtime?.view.active || runtime.view.projectId !== projectId) throw Error('That Claude attachment is not active in this project.'); return runtime; }
  const command = options.command ?? 'claude';
  async function authenticated(runtime: Runtime) {
    try {
      const value = options.authStatus ? await options.authStatus(runtime.env, runtime.view.cwd) : JSON.parse((await exec(command, ['auth', 'status'], { cwd: runtime.config, env: runtime.env, maxBuffer: 32_000, timeout: 8_000 })).stdout).loggedIn === true;
      runtime.view.authenticated = value === true; return runtime.view.authenticated;
    } catch { runtime.view.authenticated = false; return false; }
  }
  async function add(projectId: string, mode: 'managed' | 'observe') {
    const selected = project(projectId);
    if ([...sessions.values()].filter(s => s.view.active).length + starting >= 4) throw Error('At most four Claude attachments may be active.');
    starting++;
    try {
    const cwd = await realpath(selected.cwd); if (!(await stat(cwd)).isDirectory()) throw Error('Project is unavailable.');
    project(projectId);
    const id = randomUUID(); const config = join(options.directory, id, 'config'); const spool = join(options.directory, 'observation', projectId);
    await mkdir(config, { recursive: true, mode: 0o700 });
    // Explicitly remove every ambient provider authentication and cloud-provider switch.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_USE_|AWS_|GOOGLE_|AZURE_)/.test(key))) as NodeJS.ProcessEnv;
    env.CLAUDE_CONFIG_DIR = config;
    const view: Attachment = { id, projectId, cwd, label: `Claude: ${basename(cwd)}`, active: true, authenticated: false, mode, currentTurnId: null, pendingApproval: null, approvalText: null, events: [], error: null, receipt: null, loginCommand: mode === 'managed' ? `CLAUDE_CONFIG_DIR=${quote(config)} claude auth login` : null };
    const runtime: Runtime = { view, adapter: null, observer: null, env, config, installationId: `echopilot-observe-${projectId}`, spool, sending: false, collecting: false, frames: new Map() };
    if (mode === 'managed') await authenticated(runtime);
    else runtime.observer = createClaudeHookObserver({ scope: { profileId: 'local', projectId, sensitivity: 'normal' }, installationId: runtime.installationId, spoolDir: spool });
    project(projectId);
    sessions.set(id, runtime); return { ...view };
    } finally { starting--; }
  }
  async function ingest(runtime: Runtime, event: EventEnvelope) {
    const frame = runtime.frames.get(event.contentHash); runtime.frames.delete(event.contentHash);
    const blocks = frame?.message && typeof frame.message === 'object' ? (frame.message as { content?: unknown }).content : null;
    const text = Array.isArray(blocks) ? blocks.filter(block => block && block.type === 'text').map(block => safeText(block.text)).join('\n').slice(0, 2_000) : '';
    if (event.kind === 'approval_requested' && typeof frame?.request_id === 'string') {
      runtime.view.pendingApproval = frame.request_id;
      const request = frame.request && typeof frame.request === 'object' ? frame.request as Record<string, unknown> : {};
      runtime.view.approvalText = `${safeText(request.tool_name) || 'Tool'}: ${JSON.stringify(request.input ?? {}).slice(0, 1_000)}`;
    }
    if (event.turnId) runtime.view.currentTurnId = event.turnId;
    if (event.kind === 'session_state' && frame?.type === 'result') { runtime.view.currentTurnId = null; runtime.view.pendingApproval = null; runtime.view.approvalText = null; runtime.view.receipt = frame.is_error === true ? 'failed' : 'completed'; }
    runtime.view.events.push({ id: event.eventId, kind: event.kind, text }); if (runtime.view.events.length > LIMIT) runtime.view.events.shift();
    try { await options.onEvent({ ...event, scope: { ...event.scope, projectId: runtime.view.projectId, sessionId: runtime.view.id } }, { kind: event.kind, text }); }
    catch { runtime.view.error = 'Memory could not save this Claude event.'; }
  }
  async function send(projectId: string, id: string, instruction: string) {
    if (options.isPrivate?.()) throw Error('Claude sending is unavailable during private mode: this installed CLI cannot disable session history.');
    const runtime = session(projectId, id);
    if (runtime.view.mode !== 'managed') throw Error('Hook observation cannot send instructions.');
    if (typeof instruction !== 'string' || !instruction.trim() || instruction.length > 16_000) throw Error('Enter a request under 16,000 characters.');
    if (runtime.sending || runtime.view.currentTurnId) throw Error('That Claude session is already working.'); runtime.sending = true;
    try {
      if (!await authenticated(runtime)) throw Error('Sign in to this isolated Claude configuration first.'); session(projectId, id);
      if (options.isPrivate?.()) throw Error('Claude sending is unavailable during private mode: this installed CLI cannot disable session history.');
      if (!runtime.adapter) {
        const input = { cwd: runtime.view.cwd, env: runtime.env, onFrame: (frame: Record<string, unknown>, raw: string) => {
          runtime.frames.set(createHash('sha256').update(raw).digest('hex'), frame); if (runtime.frames.size > LIMIT) runtime.frames.delete(runtime.frames.keys().next().value!);
        } };
        const transport = options.transport?.(input) ?? createClaudeChildTransport({ ...input, command, args: ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'default', '--permission-prompt-tool', 'stdio', '--setting-sources', ''] });
        runtime.adapter = createClaudeManagedSession({ scope: { profileId: 'local', projectId, sensitivity: 'normal' }, sessionRoot: runtime.config, transport });
        await runtime.adapter.start();
        void (async () => { for await (const event of runtime.adapter!.observe()) await ingest(runtime, event); runtime.view.active = false; runtime.view.currentTurnId = null; runtime.view.pendingApproval = null; runtime.view.error ??= 'Claude child ended; reconnect explicitly to avoid duplicate delivery.'; })();
      }
      const delivery = randomUUID(); runtime.view.currentTurnId = `turn-${delivery}`;
      runtime.view.receipt = 'queued'; runtime.view.error = null;
      if (options.isPrivate?.()) throw Error('Claude sending is unavailable during private mode: this installed CLI cannot disable session history.');
      await runtime.adapter.send(instruction, delivery);
      return { ...runtime.view };
    } catch (error) { runtime.view.error = error instanceof Error ? error.message.slice(0, 500) : 'Claude delivery failed.'; runtime.view.currentTurnId = null; throw error; }
    finally { runtime.sending = false; }
  }
  async function hooks(projectId: string, id: string, install: boolean) {
    const runtime = session(projectId, id); if (runtime.view.mode !== 'observe') throw Error('Choose an observation attachment.');
    const settingsDirectory = join(runtime.view.cwd, '.claude'); await mkdir(settingsDirectory, { recursive: true });
    if (await realpath(settingsDirectory) !== settingsDirectory) throw Error('Symlinked Claude settings are not writable from this project scope.');
    const settingsPath = join(settingsDirectory, 'settings.local.json');
    try { if ((await lstat(settingsPath)).isSymbolicLink()) throw Error('Symlinked Claude settings are not writable from this project scope.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const hookScriptPath = join(options.directory, 'metadata-hook.cjs');
    await writeFile(hookScriptPath, metadataHook, { mode: 0o600 }); project(projectId);
    if (install) return installClaudeObservationHooks({ settingsPath, hookScriptPath, spoolDir: runtime.spool, installationId: runtime.installationId });
    return removeClaudeObservationHooks({ settingsPath, installationId: runtime.installationId });
  }
  async function collect(projectId: string, id: string) {
    const runtime = session(projectId, id); if (!runtime.observer || runtime.collecting) return { ...runtime.view };
    runtime.collecting = true;
    try { for (const event of await runtime.observer.collect()) await ingest(runtime, event); return { ...runtime.view }; }
    finally { runtime.collecting = false; }
  }
  return {
    clearContent() { for (const runtime of sessions.values()) { runtime.frames.clear(); runtime.view.events = []; runtime.view.error = null; runtime.view.approvalText = null; runtime.view.pendingApproval = null; } },
    list: () => [...sessions.values()].map(s => ({ ...s.view, events: s.view.events.map(e => ({ ...e })) })), add, send, hooks, collect,
    async refresh(projectId: string, id: string) { const runtime = session(projectId, id); if (runtime.view.mode === 'managed') await authenticated(runtime); return { ...runtime.view }; },
    async interrupt(projectId: string, id: string) { const runtime = session(projectId, id); if (!runtime.adapter || !runtime.view.currentTurnId) throw Error('No managed Claude turn is running.'); await runtime.adapter.interrupt(runtime.view.currentTurnId); runtime.view.receipt = 'interrupt-requested'; return { ...runtime.view }; },
    async respond(projectId: string, id: string, requestId: string, decision: 'approve' | 'deny') { const runtime = session(projectId, id); if (!runtime.adapter || !runtime.view.currentTurnId || requestId !== runtime.view.pendingApproval) throw Error('That Claude approval is no longer pending.'); runtime.view.pendingApproval = null; runtime.view.approvalText = null; await runtime.adapter.respondApproval(requestId, decision); return { ...runtime.view }; },
    async close(projectId: string, id: string) { const runtime = session(projectId, id); runtime.view.active = false; await runtime.adapter?.close(); return { ...runtime.view }; },
    async dispose() { disposed = true; await Promise.allSettled([...sessions.values()].map(s => s.adapter?.close())); sessions.clear(); },
  };
}
