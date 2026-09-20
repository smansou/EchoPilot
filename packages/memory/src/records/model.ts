/**
 * M04 temporal records — the inspection model behind "inspect or correct a memory".
 *
 * The M01 store owns the encrypted raw log and the M02 consolidator owns the derived facts and
 * decisions; this module owns the *temporal* layer between them and every surface that displays a
 * memory: which claim is current, which one a user correction superseded, which derivation is
 * disputed because it collides with stronger evidence, which raw events back each claim, and what an
 * answer may say at a given instant.
 *
 * Evidence hierarchy (§5.8): user_explicit > tool_observed > agent_reported > imported. A claim that
 * collides with a stronger record is displayed as `disputed`, is never cited as evidence, and can
 * therefore never overwrite a user-confirmed fact or an observed tool receipt. An unavailable
 * source is labeled `expired`/`imported` instead of being hidden, so coverage is visible rather
 * than fabricated.
 */
import type { MemoryStore } from '../store/index.js';

export type EvidenceTrust = 'user_explicit' | 'tool_observed' | 'agent_reported' | 'imported';
export type SummaryKind = 'fact' | 'decision' | 'task';
export type SummaryStatus = 'active' | 'disputed' | 'superseded';
export type TaskStatus = 'running' | 'passed' | 'failed' | 'unknown';

export interface MemoryCoverage {
  semantic: 'complete' | 'partial';
  failedJobs: readonly string[];
}

export interface MemorySourceRef {
  eventId: string;
  kind: string;
  trust: EvidenceTrust;
  occurredAt: string;
  rawAvailability: 'available' | 'expired';
}

export interface MemorySummary {
  id: string;
  kind: SummaryKind;
  text: string;
  status: SummaryStatus;
  trust: EvidenceTrust;
  question?: string;
  choice?: string;
  subject?: string;
  predicate?: string;
  object?: string;
  taskStatus?: TaskStatus;
  /** Raw event ids; never empty for a displayed summary, and one provenance entry per source. */
  sources: readonly string[];
  provenance: readonly MemorySourceRef[];
  extractionVersion: string;
  coverage: MemoryCoverage;
  validFrom: string;
  validTo?: string;
  supersedesId?: string;
}

export interface TemporalAnswer {
  question: string;
  asOf: string;
  text: string;
  supported: boolean;
  evidenceIds: readonly string[];
  conflicts: readonly string[];
  coverage: MemoryCoverage;
  extractionVersion: string;
}

export interface DerivedFactClaim {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  status?: string;
  sourceEventIds: readonly string[];
}

export interface DerivedDecisionClaim {
  id: string;
  question: string;
  choice: string;
  status?: string;
  sourceEventIds: readonly string[];
}

/**
 * The derived-record seam. The M02 MemoryConsolidator is structurally compatible; tests pass a
 * deterministic stand-in so no model call is needed to display or answer from derived records.
 */
export interface DerivedMemorySource {
  facts(): Promise<readonly DerivedFactClaim[]>;
  decisions(): Promise<readonly DerivedDecisionClaim[]>;
  coverage(): Promise<MemoryCoverage>;
}

export interface ReviseDecisionRequest {
  decisionId: string;
  choice: string;
  rationale?: string;
  /** Only an explicit user edit may reverse a decision; agent text can never take this path. */
  actor: 'user';
  occurredAt?: string;
}

export interface MemoryRecords {
  summaries(): Promise<readonly MemorySummary[]>;
  summary(id: string): Promise<MemorySummary | undefined>;
  answer(request: { question: string; asOf?: string }): Promise<TemporalAnswer>;
  reviseDecision(request: ReviseDecisionRequest): Promise<MemorySummary>;
  coverage(): Promise<MemoryCoverage>;
  close(): Promise<void>;
}

export interface CreateMemoryRecordsOptions {
  projectId: string;
  directory: string;
  store: MemoryStore;
  source: DerivedMemorySource;
  /** Label of the extractor/model+prompt version that produced the derived records. */
  extractionVersion: string;
}

const TRUST_RANK: Readonly<Record<EvidenceTrust, number>> = {
  user_explicit: 3,
  tool_observed: 2,
  agent_reported: 1,
  imported: 0,
};

/** Strongest first: a weaker claim that collides with a stronger one is disputed, never merged. */
export const TRUST_HIERARCHY: readonly EvidenceTrust[] = ['user_explicit', 'tool_observed', 'agent_reported', 'imported'];

export function trustRank(trust: EvidenceTrust): number {
  return TRUST_RANK[trust];
}

/**
 * Unrecognized trust labels are treated as the weakest evidence: an import whose provenance cannot
 * be classified must never outrank a claim that names its evidence.
 */
export function asEvidenceTrust(value: string | undefined): EvidenceTrust {
  if (value === 'user_explicit' || value === 'tool_observed' || value === 'agent_reported') return value;
  return 'imported';
}

export function strongestTrust(trusts: readonly EvidenceTrust[]): EvidenceTrust {
  let strongest: EvidenceTrust = 'imported';
  for (const trust of trusts) {
    if (trustRank(trust) > trustRank(strongest)) strongest = trust;
  }
  return strongest;
}

export function isTaskStatus(value: string | undefined): value is TaskStatus {
  return value === 'running' || value === 'passed' || value === 'failed' || value === 'unknown';
}

export function copyCoverage(coverage: MemoryCoverage): MemoryCoverage {
  return {
    semantic: coverage?.semantic === 'partial' ? 'partial' : 'complete',
    failedJobs: Array.isArray(coverage?.failedJobs) ? coverage.failedJobs.map((job) => String(job)) : [],
  };
}
