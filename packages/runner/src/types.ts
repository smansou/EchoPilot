export interface Ticket {
  id: string; epic: string; block: string; deps: string[]; kind: string;
  path: string; files: string[]; scope: string; accept: string[];
  judgment: string; days: number; blocks: string[];
}
export type TicketStatus = 'pending' | 'running' | 'checking' | 'reviewing' | 'integrating' | 'done' | 'needs_attention';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh';
export interface ModelChoice { model: string; effort: Effort }
export interface ModelDecision extends ModelChoice { reason: string }
export interface RunnerConfig {
  maxWorkers: number;
  maxAttempts: number;
  repairPaths: string[];
  models: { simple: ModelChoice; standard: ModelChoice; complex: ModelChoice; review: ModelChoice };
  ticketOverrides: Record<string, ModelChoice>;
}
export interface RunnerEvent {
  id: string; at: string; ticketId?: string; type: 'transition' | 'pause' | 'resume';
  from?: TicketStatus; to?: TicketStatus; message: string;
}
export interface TicketRecord {
  id: string; status: TicketStatus; attempts: number; infrastructureFailures?:number; failureKind?:string; updatedAt: string;
  model?: string; effort?: string; reason?: string; branch?: string;
  worktree?: string; commit?: string;
  usage?: { input: number; cached: number; output: number };
}
export interface Snapshot {
  version: 1; paused: boolean; tickets: Record<string, TicketRecord>;
  events: RunnerEvent[]; updatedAt: string;
}
export const ACTIVE_STATUSES: readonly TicketStatus[] = ['running', 'checking', 'reviewing', 'integrating'];
