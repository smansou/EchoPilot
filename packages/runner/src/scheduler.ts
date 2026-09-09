import { ACTIVE_STATUSES, type RunnerConfig, type Snapshot, type Ticket } from './types.js';
import { validateConfig } from './policy.js';

/** A glob reserves its whole static directory prefix, deliberately conservatively. */
export function normalizeReservation(path: string): string {
  if (!path || path.startsWith('/') || path.includes('\\') || /^[a-z]:/i.test(path) || path.includes('\0')) throw new Error(`Unsafe reservation path: ${path}`);
  const parts = path.split('/').filter(part => part !== '' && part !== '.');
  if (parts.some(part => part === '..' || part === '.git' || part === '.runner')) throw new Error(`Unsafe reservation path: ${path}`);
  const globIndex = parts.findIndex(part => /[*?\[\]{}]/.test(part));
  const prefix = (globIndex < 0 ? parts : parts.slice(0, globIndex)).join('/');
  if (!prefix) throw new Error(`Reservation must name a concrete subtree: ${path}`);
  return prefix;
}

export function pathsOverlap(left: string, right: string): boolean {
  const a = normalizeReservation(left).toLocaleLowerCase('en-US');
  const b = normalizeReservation(right).toLocaleLowerCase('en-US');
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export function ticketsConflict(left: Ticket, right: Ticket): boolean {
  return left.block === right.block || left.files.some(a => right.files.some(b => pathsOverlap(a, b)));
}

export function validateTickets(tickets: Ticket[]): void {
  const ids = new Set(tickets.map(ticket => ticket.id));
  if (ids.size !== tickets.length) throw new Error('Duplicate ticket IDs.');
  for (const ticket of tickets) {
    if (!/^[A-Z][A-Z0-9_-]*$/.test(ticket.id) || !ticket.block || !ticket.files.length) throw new Error(`Invalid ticket: ${ticket.id}`);
    ticket.files.forEach(normalizeReservation);
    if (ticket.deps.some(id => !ids.has(id) || id === ticket.id)) throw new Error(`Unknown or self dependency: ${ticket.id}`);
  }
  const visited = new Set<string>(); const visiting = new Set<string>();
  const byId = new Map(tickets.map(ticket => [ticket.id, ticket]));
  function visit(id: string): void {
    if (visiting.has(id)) throw new Error(`Dependency cycle at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id); byId.get(id)!.deps.forEach(visit); visiting.delete(id); visited.add(id);
  }
  tickets.forEach(ticket => visit(ticket.id));
}

export function selectReadyTickets(tickets: Ticket[], snapshot: Snapshot, config: RunnerConfig): Ticket[] {
  validateConfig(config); validateTickets(tickets);
  if (snapshot.paused) return [];
  const occupied = tickets.filter(ticket => ACTIVE_STATUSES.includes(snapshot.tickets[ticket.id]?.status ?? 'pending'));
  const selected: Ticket[] = [];
  for (const ticket of tickets) {
    if (occupied.length + selected.length >= config.maxWorkers) break;
    const record = snapshot.tickets[ticket.id];
    if (!record || record.status !== 'pending' || record.attempts >= config.maxAttempts) continue;
    if (!ticket.deps.every(id => snapshot.tickets[id]?.status === 'done')) continue;
    if ([...occupied, ...selected].some(other => ticketsConflict(ticket, other))) continue;
    selected.push(ticket);
  }
  return selected;
}
