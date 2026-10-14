/**
 * Managed Work sessions: one supervised, isolated Codex app-server child per session.
 *
 * Reliability rules this module enforces on top of the harness adapter:
 *   - Session capacity is reserved synchronously before any awaited connection, so concurrent
 *     start() calls can never exceed the limit, and the reservation is released on every failure,
 *     close, stream end and dispose.
 *   - Every failure after an adapter exists closes it best-effort, so no child outlives a failed
 *     launch, handshake, login, send, interrupt, respond or close.
 *   - Reported state stays truthful: receipts are recorded only for acknowledged wire actions,
 *     approvals answer only the exact pending request of the live turn, completed turns clear the
 *     running turn, and one session never runs two overlapping sends.
 *   - Error and diagnostic strings are bounded before the UI sees them, and a memory-ingestion
 *     warning is a diagnostic, never an agent failure.
 *   - Sends require this session's own authenticated, compatible, active child; nothing here reads
 *     or copies ambient user Codex credentials, and each session has its own codex home directory
 *     (two live children for the same project still never share state).
 */
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, realpathSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createCodexHarnessAdapter, type CodexHarnessAdapter, type CodexHarnessOptions } from '../../../../packages/harness-codex/src/index';
import { createSessionRegistry } from '../../../../packages/core/src/session-registry/index';
import type { EventEnvelope } from '../../../../packages/contracts/src/index';

const EVENT_LIMIT = 80;
/** Per-event text kept for the activity feed; the adapter keeps its own bounded store of full text. */
const EVENT_TEXT_LIMIT = 2_000;
/** Error and diagnostic strings exposed through WorkSession. */
const DIAGNOSTIC_LIMIT = 500;
const SESSION_LIMIT = 4;
const INSTRUCTION_LIMIT = 16_000;

export type WorkEvent = Readonly<{
  id: string;
  kind: string;
  at: string;
  turnId: string | null;
  requestId: string | null;
  text: string | null;
}>;
export type WorkSession = Readonly<{
  id: string;
  projectId: string;
  label: string;
  cwd: string;
  active: boolean;
  compatible: boolean;
  authenticated: boolean;
  authMode: string | null;
  serverVersion: string;
  capabilities: readonly string[];
  events: readonly WorkEvent[];
  currentTurnId: string | null;
  pendingApproval: string | null;
  lastReceipt: string | null;
  error: string | null;
  /** Memory-ingestion warnings only; `error` stays reserved for the managed agent/session itself. */
  diagnostic: string | null;
}>;

type PendingApproval = Readonly<{ requestId: string; turnId: string | null }>;

type InternalSession = {
  adapter: CodexHarnessAdapter;
  compatible: boolean;
  authenticated: boolean;
  authMode: string | null;
  serverVersion: string;
  capabilities: string[];
  events: WorkEvent[];
  currentTurnId: string | null;
  pendingApproval: PendingApproval | null;
  lastReceipt: string | null;
  error: string | null;
  diagnostic: string | null;
  sending: boolean;
  closing: boolean;
};

/**
 * Optional test seam for deterministic unit tests. The desktop host never passes this, so
 * production always spawns the real pinned app-server through `createCodexHarnessAdapter`.
 */
export type ManagedWorkHooks = Readonly<{
  createAdapter?: (options: CodexHarnessOptions) => CodexHarnessAdapter;
}>;

export type ManagedWork = Readonly<{
  list(): readonly WorkSession[];
  refreshAuth(): Promise<readonly WorkSession[]>;
  start(cwd: string): Promise<WorkSession>;
  beginLogin(id: string): Promise<Readonly<{ authUrl: string; session: WorkSession }>>;
  send(id: string, instruction: string): Promise<WorkSession>;
  interrupt(id: string): Promise<WorkSession>;
  respond(id: string, requestId: string, decision: 'approve' | 'deny'): Promise<WorkSession>;
  close(id: string): Promise<WorkSession>;
  clearContent(): void;
  dispose(): Promise<void>;
}>;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Every string that reaches the UI is bounded first; a pathological child cannot flood it. */
function bounded(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

export function createManagedWork(
  userData: string,
  command = 'codex',
  onEvent?: (event: EventEnvelope, payload: Record<string, unknown>) => Promise<void>,
  hooks: ManagedWorkHooks = {},
): ManagedWork {
  const registry = createSessionRegistry();
  const sessions = new Map<string, InternalSession>();
  /** Session ids whose capacity is reserved by an in-flight start() before the child is adopted. */
  const reservedStarts = new Set<string>();
  let disposed = false;

  function assertLive(): void {
    if (disposed) throw new TypeError('This managed Work service has been shut down.');
  }

  function requireSession(id: string): InternalSession {
    assertLive();
    const session = sessions.get(id);
    if (!session || session.closing || !registry.get(id)?.active) {
      throw new TypeError('That managed session is not active.');
    }
    return session;
  }

  function activeCount(): number {
    return registry.list().filter((record) => record.active).length + reservedStarts.size;
  }

  function setError(runtime: InternalSession, detail: string): void {
    runtime.error = bounded(detail, DIAGNOSTIC_LIMIT);
  }

  /** Close an adapter without letting a cleanup failure hide the failure being reported. */
  async function closeQuietly(adapter: CodexHarnessAdapter | undefined): Promise<void> {
    if (adapter === undefined) return;
    try {
      await adapter.close();
    } catch {
      // Best-effort: the original failure is the report; cleanup must not replace it.
    }
  }

  function project(sessionId: string): WorkSession {
    const record = registry.get(sessionId);
    const runtime = sessions.get(sessionId);
    if (!record || !runtime) throw new TypeError('Unknown managed session.');
    return {
      id: record.sessionId,
      projectId: record.projectId,
      label: record.label,
      cwd: record.cwd,
      active: record.active,
      compatible: runtime.compatible,
      authenticated: runtime.authenticated,
      authMode: runtime.authMode,
      serverVersion: runtime.serverVersion,
      capabilities: [...runtime.capabilities],
      events: runtime.events.map((event) => ({ ...event })),
      currentTurnId: runtime.currentTurnId,
      pendingApproval: runtime.pendingApproval?.requestId ?? null,
      lastReceipt: runtime.lastReceipt,
      error: runtime.error,
      diagnostic: runtime.diagnostic,
    };
  }

  /** Mark a session over and release its slot. Never lets a registry hiccup mask the real cause. */
  function finishSession(sessionId: string, runtime: InternalSession, unexpected: boolean, failure?: unknown): void {
    runtime.currentTurnId = null;
    runtime.pendingApproval = null;
    runtime.sending = false;
    if (unexpected && runtime.error === null) {
      setError(runtime, failure === undefined ? 'The managed Codex session ended unexpectedly.' : errorText(failure));
    }
    try {
      if (registry.get(sessionId)?.active) registry.end(sessionId);
    } catch {
      // Best-effort: the registry record may already be inactive or gone.
    }
  }

  async function recordEvent(sessionId: string, event: EventEnvelope): Promise<void> {
    const runtime = sessions.get(sessionId);
    if (!runtime || runtime.closing) return;
    const agentText = event.kind === 'agent_message' ? runtime.adapter.readAgentMessage(event.payloadRef) : null;
    const diagnosticText = runtime.adapter.readDiagnosticMessage(event.payloadRef);
    const readback = bounded(agentText ?? diagnosticText ?? '', EVENT_TEXT_LIMIT);
    runtime.events.push({
      id: event.eventId,
      kind: event.kind,
      at: event.observedAt,
      turnId: event.turnId ?? null,
      requestId: event.kind === 'approval_requested' ? event.sourceEventId : null,
      text: readback === '' ? null : readback,
    });
    if (runtime.events.length > EVENT_LIMIT) runtime.events.splice(0, runtime.events.length - EVENT_LIMIT);
    if (event.kind === 'session_state') {
      const turnEnded = event.payloadRef.endsWith('/completed');
      if (turnEnded) {
        if (event.turnId === undefined || runtime.currentTurnId === event.turnId) runtime.currentTurnId = null;
        // An approval request belongs to the turn that produced it; a finished turn can no longer answer.
        if (runtime.pendingApproval !== null
          && (event.turnId === undefined || runtime.pendingApproval.turnId === event.turnId)) {
          runtime.pendingApproval = null;
        }
      } else if (event.turnId !== undefined) {
        if (runtime.pendingApproval !== null && runtime.pendingApproval.turnId !== event.turnId) {
          runtime.pendingApproval = null;
        }
        runtime.currentTurnId = event.turnId;
        registry.recordTurn(sessionId, event.turnId);
      }
    } else if (event.turnId !== undefined && runtime.currentTurnId === null) {
      runtime.currentTurnId = event.turnId;
      registry.recordTurn(sessionId, event.turnId);
    }
    if (event.kind === 'approval_requested') {
      runtime.pendingApproval = { requestId: event.sourceEventId, turnId: event.turnId ?? runtime.currentTurnId };
    }
    if (event.unsupportedKind === 'error' && diagnosticText !== null) setError(runtime, diagnosticText);
    if (onEvent && ['agent_message', 'tool_started', 'tool_completed', 'session_state', 'approval_requested'].includes(event.kind)) {
      const payload = event.kind === 'agent_message'
        ? { text: agentText ?? '' }
        : event.kind === 'session_state'
          ? { kind: event.kind, phase: event.payloadRef.endsWith('/completed') ? 'completed' : 'started' }
          : { kind: event.kind };
      try { await onEvent(event, payload); }
      catch (error) {
        // Memory persistence is a diagnostic concern; it must never read as the agent failing.
        runtime.diagnostic = bounded(`Memory could not save this event: ${errorText(error)}`, DIAGNOSTIC_LIMIT);
      }
    }
  }

  return {
    list: () => {
      assertLive();
      return registry.list().map((record) => project(record.sessionId));
    },
    async refreshAuth() {
      assertLive();
      await Promise.allSettled([...sessions.entries()]
        .filter(([id, runtime]) => !runtime.closing && registry.get(id)?.active)
        .map(async ([, runtime]) => {
          try {
            const account = await runtime.adapter.accountStatus();
            runtime.authenticated = account.authenticated;
            runtime.authMode = account.mode;
          } catch (error) {
            // A failed refresh is unknown authority, never permission to keep sending on stale login.
            runtime.authenticated = false;
            runtime.authMode = null;
            runtime.diagnostic = bounded(`Sign-in status could not be refreshed: ${errorText(error)}`, DIAGNOSTIC_LIMIT);
          }
        }));
      return registry.list().map((record) => project(record.sessionId));
    },
    async start(cwd) {
      assertLive();
      if (typeof cwd !== 'string' || cwd.trim().length === 0) {
        throw new TypeError('Choose a project directory for the managed session.');
      }
      let canonical: string;
      try {
        canonical = realpathSync(cwd);
      } catch {
        throw new TypeError(`That project directory is not available: ${bounded(cwd, 200)}.`);
      }
      let isDirectory = false;
      try { isDirectory = statSync(canonical).isDirectory(); } catch { isDirectory = false; }
      if (!isDirectory) throw new TypeError(`That project directory is not available: ${bounded(canonical, 200)}.`);
      if (activeCount() >= SESSION_LIMIT) {
        throw new Error(`At most ${SESSION_LIMIT} managed sessions can run at once.`);
      }
      const id = randomUUID();
      // Reserve the slot synchronously, before the awaited connect below: concurrent starts must
      // never both pass the limit check. Every exit path releases it exactly once.
      reservedStarts.add(id);
      const projectId = createHash('sha256').update(canonical).digest('hex').slice(0, 16);
      // One home directory per session: two live children — even for the same project — never share
      // a managed codex home (or its credentials/config) and cannot corrupt each other.
      const codexHome = join(userData, 'managed-codex', projectId, id);
      let adapter: CodexHarnessAdapter | undefined;
      let adopted = false;
      try {
        mkdirSync(codexHome, { recursive: true, mode: 0o700 });
        const options: CodexHarnessOptions = {
          command,
          args: ['app-server'],
          cwd: canonical,
          codexHome,
          scope: { profileId: 'local', projectId, sessionId: id, sensitivity: 'normal' },
        };
        const startedAdapter: CodexHarnessAdapter = hooks.createAdapter
          ? hooks.createAdapter(options)
          : createCodexHarnessAdapter(options);
        adapter = startedAdapter;
        await startedAdapter.start();
        const info = await startedAdapter.info();
        const account = await startedAdapter.accountStatus();
        if (disposed) throw new TypeError('This managed Work service has been shut down.');
        const runtime: InternalSession = {
          adapter: startedAdapter,
          compatible: info.compatible,
          authenticated: account.authenticated,
          authMode: account.mode,
          serverVersion: info.serverVersion,
          capabilities: [...info.capabilities],
          events: [],
          currentTurnId: null,
          pendingApproval: null,
          lastReceipt: null,
          error: null,
          diagnostic: null,
          sending: false,
          closing: false,
        };
        sessions.set(id, runtime);
        registry.adopt({ sessionId: id, harness: 'codex', projectId, label: basename(canonical), cwd: canonical, adapter: startedAdapter });
        adopted = true;
        reservedStarts.delete(id);
        void (async () => {
          try {
            for await (const event of startedAdapter.observe()) await recordEvent(id, event);
            finishSession(id, runtime, !runtime.closing);
          } catch (error) {
            finishSession(id, runtime, true, error);
            // The stream died with the session; do not let a half-live child linger unobserved.
            await closeQuietly(startedAdapter);
          }
        })();
        return project(id);
      } catch (error) {
        reservedStarts.delete(id);
        sessions.delete(id);
        if (adopted) {
          try { if (registry.get(id)?.active) registry.end(id); } catch { /* already inactive */ }
        }
        await closeQuietly(adapter);
        throw error;
      }
    },
    async beginLogin(id) {
      const runtime = requireSession(id);
      try {
        const login = await runtime.adapter.beginChatGPTLogin();
        return { authUrl: login.authUrl, session: project(id) };
      } catch (error) {
        setError(runtime, `Sign-in could not start: ${errorText(error)}`);
        throw error;
      }
    },
    async send(id, instruction) {
      const runtime = requireSession(id);
      if (!runtime.compatible) {
        throw new Error('This Codex build is not compatible with the app; the session is observe-only.');
      }
      if (!runtime.authenticated) throw new Error('Connect your Codex account before sending a request.');
      if (typeof instruction !== 'string' || instruction.trim().length === 0 || instruction.length > INSTRUCTION_LIMIT) {
        throw new TypeError('Enter a request under 16,000 characters.');
      }
      if (runtime.sending || runtime.currentTurnId !== null) throw new Error('That session is already working on a request.');
      runtime.sending = true;
      try {
        const receipt = await runtime.adapter.send(instruction, randomUUID());
        if (receipt.status !== 'acknowledged') {
          // Never claim a receipt the wire did not acknowledge.
          throw new Error('Codex did not acknowledge that request.');
        }
        runtime.lastReceipt = receipt.status;
        runtime.error = null;
      } catch (error) {
        setError(runtime, errorText(error));
        throw error;
      } finally {
        runtime.sending = false;
      }
      return project(id);
    },
    async interrupt(id) {
      const runtime = requireSession(id);
      if (!runtime.compatible) {
        throw new Error('This Codex build is not compatible with the app; the session is observe-only.');
      }
      const turnId = runtime.currentTurnId;
      if (turnId === null) throw new TypeError('No running turn is available to interrupt.');
      try {
        await runtime.adapter.interrupt(turnId);
      } catch (error) {
        setError(runtime, errorText(error));
        throw error;
      }
      runtime.lastReceipt = 'interrupted';
      return project(id);
    },
    async respond(id, requestId, decision) {
      const runtime = requireSession(id);
      const pending = runtime.pendingApproval;
      if (pending === null || typeof requestId !== 'string' || pending.requestId !== requestId) {
        throw new TypeError('That approval is no longer pending.');
      }
      // Answer only while the approval still belongs to the live turn; a finished turn never answers.
      if (pending.turnId !== null && runtime.currentTurnId !== pending.turnId) {
        runtime.pendingApproval = null;
        throw new TypeError('That approval is no longer pending.');
      }
      try {
        await runtime.adapter.respondApproval(pending.requestId, decision);
      } catch (error) {
        // The adapter no longer holds this request; never keep offering a receipt for it.
        runtime.pendingApproval = null;
        setError(runtime, errorText(error));
        throw error;
      }
      runtime.pendingApproval = null;
      runtime.lastReceipt = decision === 'approve' ? 'approved' : 'denied';
      return project(id);
    },
    async close(id) {
      const runtime = requireSession(id);
      runtime.closing = true;
      let failure: unknown;
      try {
        await runtime.adapter.close();
      } catch (error) {
        failure = error;
      }
      finishSession(id, runtime, false);
      if (failure !== undefined) {
        setError(runtime, `The session could not close cleanly: ${errorText(failure)}`);
        throw failure;
      }
      return project(id);
    },
    clearContent() {
      for (const runtime of sessions.values()) {
        runtime.events = []; runtime.error = null; runtime.diagnostic = null; runtime.pendingApproval = null;
      }
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      // Best-effort: one uncooperative child must not skip the others.
      const closing = [...sessions.values()].map((runtime) => {
        runtime.closing = true;
        return closeQuietly(runtime.adapter);
      });
      await Promise.allSettled(closing);
      for (const [id, runtime] of sessions) {
        runtime.currentTurnId = null;
        runtime.pendingApproval = null;
        try { if (registry.get(id)?.active) registry.end(id); } catch { /* already inactive */ }
      }
      reservedStarts.clear();
      sessions.clear();
    },
  };
}
