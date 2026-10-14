import { setTimeout, clearTimeout } from 'node:timers';
/** Main-owned explicit authority. Expiry revokes in-flight work; exhaustion only closes admission. */
export function createCompanionSession(options: {
  projectId(): string | null; privateActive(): boolean; muted(): boolean; revoke(): void;
  now?(): number; setTimer?(callback: () => void, delay: number): ReturnType<typeof setTimeout>; clearTimer?(timer: ReturnType<typeof setTimeout>): void;
}) {
  const now = options.now ?? Date.now;
  const setTimer: (callback: () => void, delay: number) => NodeJS.Timeout = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
  const clearTimer = options.clearTimer ?? clearTimeout;
  let generation = 0;
  let session: { projectId: string; expiresAt: number; remainingRequests: number } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  function disable() {
    generation++;
    if (timer) clearTimer(timer); timer = null;
    const active = session !== null; session = null;
    if (active) options.revoke();
  }
  function status() {
    if (session && (now() >= session.expiresAt || options.projectId() !== session.projectId || options.privateActive() || options.muted())) disable();
    return session && session.remainingRequests > 0 ? { enabled: true, ...session } : { enabled: false, projectId: null, expiresAt: null, remainingRequests: 0 };
  }
  function allowed(projectId: string) { const current = status(); return current.enabled && current.projectId === projectId; }
  return {
    status, disable, dispose: disable, allowed,
    enable(projectId: string, consent: boolean) {
      if (consent !== true || !projectId || options.projectId() !== projectId || options.privateActive() || options.muted()) throw Error('Explicit consent for the associated project is required.');
      disable(); const token = generation;
      session = { projectId, expiresAt: now() + 300_000, remainingRequests: 10 };
      timer = setTimer(() => { if (token === generation) disable(); }, 300_000); timer.unref?.();
      return status();
    },
    consume(projectId: string) { if (!allowed(projectId) || !session) return false; session.remainingRequests--; return true; },
  };
}
