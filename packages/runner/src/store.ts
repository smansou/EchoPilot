import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ACTIVE_STATUSES, type Snapshot, type Ticket, type TicketRecord, type TicketStatus, type RunnerEvent } from './types.js';
import { validateTickets } from './scheduler.js';

type Patch = Partial<Omit<TicketRecord, 'id' | 'status' | 'updatedAt'>>;
const EDGES: Record<TicketStatus, readonly TicketStatus[]> = {
  pending: ['running', 'needs_attention'], running: ['checking', 'needs_attention'],
  checking: ['reviewing', 'needs_attention'], reviewing: ['integrating', 'needs_attention'],
  integrating: ['done', 'needs_attention'], done: [], needs_attention: ['pending'],
};

/** One server process owns this store. Its caller also owns the process lock. */
export class RunnerStore {
  private snapshot: Snapshot | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private listeners = new Set<(snapshot: Snapshot) => void>();
  private directory: string;
  constructor(root: string, private readonly tickets: Ticket[]) { this.directory = join(root, '.runner'); }

  async load(): Promise<Snapshot> {
    validateTickets(this.tickets);
    await mkdir(this.directory, { recursive: true });
    let saved: Snapshot | undefined;
    try { saved = JSON.parse(await readFile(join(this.directory, 'state.json'), 'utf8')) as Snapshot; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (saved && (saved.version !== 1 || !saved.tickets || !Array.isArray(saved.events))) throw new Error('Unsupported or corrupt runner state; preserve the file for recovery.');
    const now = new Date().toISOString();
    const records: Record<string, TicketRecord> = {};
    const recoveryEvents: RunnerEvent[] = [];
    for (const ticket of this.tickets) {
      const previous = saved?.tickets[ticket.id];
      if (previous && (previous.id !== ticket.id || !Object.hasOwn(EDGES, previous.status) || !Number.isInteger(previous.attempts) || previous.attempts < 0)) throw new Error(`Corrupt state for ${ticket.id}.`);
      records[ticket.id] = previous ? { ...previous } : { id: ticket.id, status: 'pending', attempts: 0, updatedAt: now, ...(ticket.id === 'F01' ? { reason: 'Bootstrap exists; remaining acceptance requirements still need verification.' } : {}) };
      if (previous && ACTIVE_STATUSES.includes(previous.status)) {
        records[ticket.id] = { ...previous, status: 'needs_attention', updatedAt: now, reason: 'Runner restarted during execution. Inspect retained worktree and process state before retrying.' };
        recoveryEvents.push({ id: randomUUID(), at: now, ticketId: ticket.id, type: 'transition', from: previous.status, to: 'needs_attention', message: records[ticket.id]!.reason! });
      }
    }
    this.snapshot = { version: 1, paused: true, tickets: records, events: [...(saved?.events ?? []), ...recoveryEvents].slice(-1000), updatedAt: now };
    await this.persist(recoveryEvents);
    return this.getSnapshot();
  }

  getSnapshot(): Snapshot {
    if (!this.snapshot) throw new Error('RunnerStore.load() must be called first.');
    return structuredClone(this.snapshot);
  }
  subscribe(listener: (snapshot: Snapshot) => void): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation); this.queue = next.catch(() => undefined); return next;
  }
  private record(id: string): TicketRecord {
    if (!this.snapshot) throw new Error('RunnerStore.load() must be called first.');
    const record = this.snapshot.tickets[id];
    if (!record) throw new Error(`Unknown ticket ${id}`);
    return record;
  }
  async transition(id: string, status: TicketStatus, patch: Patch = {}): Promise<Snapshot> {
    return this.serial(async () => {
      const previous = this.record(id);
      if (!EDGES[previous.status].includes(status)) throw new Error(`Invalid transition ${id}: ${previous.status} -> ${status}`);
      const at = new Date().toISOString();
      const event: RunnerEvent = { id: randomUUID(), ticketId: id, at, type: 'transition', from: previous.status, to: status, message: (patch.reason ?? `${id}: ${previous.status} → ${status}`).slice(0, 2000) };
      this.snapshot!.tickets[id] = { ...previous, ...patch, id, status, updatedAt: at, attempts: status === 'running' ? previous.attempts + 1 : previous.attempts };
      this.snapshot!.events = [...this.snapshot!.events, event].slice(-1000);
      await this.persist([event]); return this.getSnapshot();
    });
  }
  async update(id: string, patch: Patch): Promise<Snapshot> {
    return this.serial(async () => {
      const previous = this.record(id);
      this.snapshot!.tickets[id] = { ...previous, ...patch, id, status: previous.status, attempts: previous.attempts, updatedAt: new Date().toISOString() };
      await this.persist([]); return this.getSnapshot();
    });
  }
  async setPaused(paused: boolean): Promise<Snapshot> {
    return this.serial(async () => {
      if (!this.snapshot) throw new Error('RunnerStore.load() must be called first.');
      if (this.snapshot.paused === paused) return this.getSnapshot();
      const event: RunnerEvent = { id: randomUUID(), at: new Date().toISOString(), type: paused ? 'pause' : 'resume', message: paused ? 'Scheduling paused; active workers may finish.' : 'Scheduling resumed.' };
      this.snapshot.paused = paused; this.snapshot.events = [...this.snapshot.events, event].slice(-1000);
      await this.persist([event]); return this.getSnapshot();
    });
  }
  private async persist(events: RunnerEvent[]): Promise<void> {
    this.snapshot!.updatedAt = new Date().toISOString();
    const temporary = join(this.directory, `state.${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(this.snapshot, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, join(this.directory, 'state.json'));
    if (events.length) await appendFile(join(this.directory, 'events.jsonl'), events.map(event => JSON.stringify(event)).join('\n') + '\n', { mode: 0o600 });
    for (const listener of this.listeners) { try { listener(this.getSnapshot()); } catch { /* UI subscribers cannot roll back durable state. */ } }
  }
}
