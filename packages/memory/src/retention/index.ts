/**
 * M05 retention — raw expiry, capsules, derived quotas, and summary-worker failure, bounded and
 * visible.
 *
 * A run walks the source inventory and never lets anything disappear without an accounting entry:
 *
 *   - §5.8 deadline: unpinned raw artifacts older than `rawRetentionDays` expire oldest first, each
 *     one reported with its exact byte count and reason `retention_deadline`,
 *   - §5.8 quota: when the surviving raw bytes still exceed `rawQuotaBytes`, the oldest unpinned
 *     artifacts are evicted with reason `raw_quota` until the quota holds. Pinned artifacts are never
 *     deleted to silence disk exhaustion; a leftover overage stays visible as a `raw_quota_exceeded`
 *     gap plus a storage action instead of deleting more,
 *   - retained decisions keep their text and a bounded capsule (<= `capsuleBytes`); after the raw
 *     sources expire the capsule is still returned and labeled `rawAvailability: 'expired'`, so the
 *     answer path can say "the raw source is gone" instead of inventing one. An oversized capsule is
 *     truncated explicitly (`truncated: true`) and raises a `capsule_truncated` gap,
 *   - derived growth: above the soft quota redundant observations (duplicates) and old summary
 *     versions are compacted while current facts, decisions, and capsules are preserved; above the
 *     hard quota the retained bytes are kept inside the quota by deferring low-value history (and
 *     reporting what was deferred) and a storage action with `raise_quota`/`export_archive` options,
 *   - criterion 3: a summary worker that throws is reported in `jobs.failed` with its reason and a
 *     single `summary_failed` gap, coverage is `partial` with that job id, the run still completes
 *     and every other job still completes; a later run retries the failed job, and only a run where
 *     it succeeds reports `complete` coverage again.
 *
 * Expiry decisions are durable: the ids already expired in this `directory` are persisted, so
 * re-running at the same instant never expires (or double-counts) the same artifact.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type ArtifactKind = 'transcript' | 'tool_output' | 'screenshot' | 'audio' | 'other';
export type JobKind = 'daily_card' | 'summary';
export type PressureLevel = 'ok' | 'soft' | 'hard';

export interface RawArtifact {
  id: string;
  kind: ArtifactKind;
  bytes: number;
  occurredAt: string;
  pinned?: boolean;
}

export interface RetainedDecision {
  id: string;
  text: string;
  sourceArtifactIds: readonly string[];
  capsuleText: string;
}

export interface DerivedFact {
  id: string;
  bytes: number;
  current: boolean;
}

export interface DerivedObservation {
  id: string;
  bytes: number;
  occurredAt: string;
  duplicateOf?: string;
}

export interface DerivedSummaryVersion {
  id: string;
  bytes: number;
  occurredAt: string;
  current: boolean;
}

export interface DerivedInventory {
  facts: readonly DerivedFact[];
  observations: readonly DerivedObservation[];
  summaryVersions: readonly DerivedSummaryVersion[];
}

export interface SummaryJob {
  id: string;
  kind: JobKind;
  input: string;
}

export interface RetentionSource {
  artifacts(): Promise<readonly RawArtifact[]>;
  decisions(): Promise<readonly RetainedDecision[]>;
  derived(): Promise<DerivedInventory>;
  summaryJobs(): Promise<readonly SummaryJob[]>;
}

export interface RetentionLimits {
  rawRetentionDays: number;
  rawQuotaBytes: number;
  derivedSoftQuotaBytes: number;
  derivedHardQuotaBytes: number;
  capsuleBytes: number;
}

export interface RetentionGap {
  kind: string;
  detail: string;
  artifactIds?: readonly string[];
  decisionIds?: readonly string[];
  jobIds?: readonly string[];
}

export interface RetentionCoverage {
  semantic: 'complete' | 'partial';
  failedJobs: readonly string[];
  gaps: readonly RetentionGap[];
}

export interface CapsuleRef {
  id: string;
  decisionId: string;
  bytes: number;
  text: string;
  truncated: boolean;
  sourceArtifactIds: readonly string[];
  rawAvailability: 'available' | 'expired';
}

export interface ExpiredArtifact {
  id: string;
  kind: ArtifactKind;
  bytes: number;
  occurredAt: string;
  reason: 'retention_deadline' | 'raw_quota';
}

export interface StorageAction {
  kind: string;
  options: readonly string[];
}

export interface ExpiryReport {
  expired: readonly ExpiredArtifact[];
  expiredArtifactIds: readonly string[];
  expiredBytes: number;
  freedBytes: number;
  rawBytesBefore: number;
  rawBytesAfter: number;
  retainedArtifactIds: readonly string[];
}

export interface DecisionRetentionReport {
  decisionId: string;
  capsuleId: string;
  capsuleBytes: number;
  truncated: boolean;
  rawAvailability: 'available' | 'expired';
}

export interface CompactionReport {
  compactedObservationIds: readonly string[];
  droppedSummaryVersionIds: readonly string[];
  preservedFactIds: readonly string[];
  preservedDecisionIds: readonly string[];
  deferredHistoryIds: readonly string[];
  actions: readonly StorageAction[];
}

export interface SummaryRunReport {
  completed: readonly { id: string; bytes: number }[];
  failed: readonly { id: string; reason: string }[];
}

export interface RetentionReport {
  ranAt: string;
  expiry: ExpiryReport;
  decisions: readonly DecisionRetentionReport[];
  compaction: CompactionReport;
  jobs: SummaryRunReport;
  pressure: { level: PressureLevel };
  coverage: RetentionCoverage;
  gaps: readonly RetentionGap[];
}

export interface RetentionPressure {
  level: PressureLevel;
  rawBytes: number;
  rawQuotaBytes: number;
  derivedBytes: number;
  derivedRequestedBytes: number;
  derivedSoftQuotaBytes: number;
  derivedHardQuotaBytes: number;
  actions: readonly StorageAction[];
}

export interface MemoryRetention {
  run(options?: { now?: Date; summarize?: (job: SummaryJob) => Promise<string> }): Promise<RetentionReport>;
  capsule(decisionId: string): Promise<CapsuleRef | undefined>;
  pressure(): Promise<RetentionPressure>;
  coverage(): Promise<RetentionCoverage>;
  close(): Promise<void>;
}

export interface RetentionOptions {
  projectId: string;
  directory: string;
  source: RetentionSource;
  now?: () => Date;
  limits?: Partial<RetentionLimits>;
}

const DAY_MS = 86_400_000;
const DEFAULT_LIMITS: RetentionLimits = {
  rawRetentionDays: 30,
  rawQuotaBytes: 2 * 1024 * 1024 * 1024,
  derivedSoftQuotaBytes: 1024 * 1024 * 1024,
  derivedHardQuotaBytes: 5 * 1024 * 1024 * 1024,
  capsuleBytes: 4_096,
};
const STORAGE_ACTION_OPTIONS = ['raise_quota', 'export_archive'] as const;
const STATE_FILE = 'retention-state.json';

interface PersistedState {
  expiredArtifactIds: string[];
}

interface RawPlan {
  expiredByDeadline: RawArtifact[];
  expiredByQuota: RawArtifact[];
  retained: RawArtifact[];
  rawBytesBefore: number;
  rawBytesAfter: number;
  overQuotaBefore: boolean;
  overQuotaAfter: boolean;
}

interface DerivedPlan {
  compactedObservationIds: string[];
  droppedSummaryVersionIds: string[];
  preservedFactIds: string[];
  preservedDecisionIds: string[];
  deferredHistoryIds: string[];
  retainedBytes: number;
  requestedBytes: number;
  level: PressureLevel;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function sliceToBytes(text: string, limit: number): string {
  if (limit <= 0) return '';
  let used = 0;
  let out = '';
  for (const character of text) {
    const size = byteLength(character);
    if (used + size > limit) break;
    out += character;
    used += size;
  }
  return out;
}

function parseMs(value: string, fallback: number): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function oldestFirst(artifacts: readonly RawArtifact[]): RawArtifact[] {
  return [...artifacts].sort((left, right) => {
    const leftMs = parseMs(left.occurredAt, 0);
    const rightMs = parseMs(right.occurredAt, 0);
    if (leftMs !== rightMs) return leftMs - rightMs;
    return left.id.localeCompare(right.id);
  });
}

function sumBytes(entries: readonly { bytes: number }[]): number {
  return entries.reduce((total, entry) => total + entry.bytes, 0);
}

function levelOf(demand: number, soft: number, hard: number): PressureLevel {
  if (demand > hard) return 'hard';
  if (demand > soft) return 'soft';
  return 'ok';
}

function maxLevel(left: PressureLevel, right: PressureLevel): PressureLevel {
  const rank: Record<PressureLevel, number> = { ok: 0, soft: 1, hard: 2 };
  return rank[left] >= rank[right] ? left : right;
}

function storageAction(): StorageAction {
  return { kind: 'storage_action', options: [...STORAGE_ACTION_OPTIONS] };
}

export async function createMemoryRetention(options: RetentionOptions): Promise<MemoryRetention> {
  const directory = options.directory;
  const source = options.source;
  const now = options.now ?? (() => new Date());
  const limits: RetentionLimits = {
    rawRetentionDays: options.limits?.rawRetentionDays ?? DEFAULT_LIMITS.rawRetentionDays,
    rawQuotaBytes: options.limits?.rawQuotaBytes ?? DEFAULT_LIMITS.rawQuotaBytes,
    derivedSoftQuotaBytes: options.limits?.derivedSoftQuotaBytes ?? DEFAULT_LIMITS.derivedSoftQuotaBytes,
    derivedHardQuotaBytes: options.limits?.derivedHardQuotaBytes ?? DEFAULT_LIMITS.derivedHardQuotaBytes,
    capsuleBytes: options.limits?.capsuleBytes ?? DEFAULT_LIMITS.capsuleBytes,
  };

  const stateFile = join(directory, STATE_FILE);
  let expiredArtifactIds = new Set<string>();
  let coverage: RetentionCoverage = { semantic: 'complete', failedJobs: [], gaps: [] };
  let closed = false;

  try {
    const raw = await readFile(stateFile, 'utf8');
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    if (Array.isArray(parsed.expiredArtifactIds)) {
      expiredArtifactIds = new Set(parsed.expiredArtifactIds.filter((id): id is string => typeof id === 'string'));
    }
  } catch {
    expiredArtifactIds = new Set<string>();
  }

  async function persist(): Promise<void> {
    try {
      await mkdir(directory, { recursive: true });
      const state: PersistedState = { expiredArtifactIds: [...expiredArtifactIds].sort() };
      await writeFile(stateFile, JSON.stringify(state));
    } catch {
      // The durable note is best-effort; the in-memory set still keeps this process honest.
    }
  }

  function planRaw(artifacts: readonly RawArtifact[], atMs: number): RawPlan {
    const live = artifacts.filter((artifact) => !expiredArtifactIds.has(artifact.id));
    const rawBytesBefore = sumBytes(live);
    const deadlineMs = atMs - limits.rawRetentionDays * DAY_MS;
    const expiredByDeadline = oldestFirst(live.filter((artifact) => artifact.pinned !== true
      && parseMs(artifact.occurredAt, atMs) < deadlineMs));
    const expiredIds = new Set(expiredByDeadline.map((artifact) => artifact.id));
    const afterDeadline = live.filter((artifact) => !expiredIds.has(artifact.id));
    let remainingBytes = sumBytes(afterDeadline);
    const expiredByQuota: RawArtifact[] = [];
    if (remainingBytes > limits.rawQuotaBytes) {
      for (const artifact of oldestFirst(afterDeadline)) {
        if (remainingBytes <= limits.rawQuotaBytes) break;
        if (artifact.pinned === true) continue;
        expiredByQuota.push(artifact);
        remainingBytes -= artifact.bytes;
      }
    }
    const evictedIds = new Set(expiredByQuota.map((artifact) => artifact.id));
    const retained = afterDeadline.filter((artifact) => !evictedIds.has(artifact.id));
    return {
      expiredByDeadline,
      expiredByQuota,
      retained,
      rawBytesBefore,
      rawBytesAfter: sumBytes(retained),
      overQuotaBefore: rawBytesBefore > limits.rawQuotaBytes,
      overQuotaAfter: sumBytes(retained) > limits.rawQuotaBytes,
    };
  }

  function capsuleFor(decision: RetainedDecision): CapsuleRef {
    const limit = Math.max(0, limits.capsuleBytes);
    const total = byteLength(decision.capsuleText);
    const truncated = total > limit;
    const text = truncated ? sliceToBytes(decision.capsuleText, limit) : decision.capsuleText;
    const rawAvailability: 'available' | 'expired' = decision.sourceArtifactIds
      .every((artifact) => !expiredArtifactIds.has(artifact)) ? 'available' : 'expired';
    return {
      id: `capsule-${decision.id}`,
      decisionId: decision.id,
      bytes: byteLength(text),
      text,
      truncated,
      sourceArtifactIds: [...decision.sourceArtifactIds],
      rawAvailability,
    };
  }

  function planDerived(inventory: DerivedInventory, capsules: readonly CapsuleRef[]): DerivedPlan {
    const capsuleBytes = sumBytes(capsules);
    const requestedBytes = sumBytes(inventory.facts) + sumBytes(inventory.observations)
      + sumBytes(inventory.summaryVersions) + capsuleBytes;
    const level = levelOf(requestedBytes, limits.derivedSoftQuotaBytes, limits.derivedHardQuotaBytes);

    const compactedObservationIds = inventory.observations
      .filter((observation) => observation.duplicateOf !== undefined)
      .map((observation) => observation.id);
    const droppedSummaryVersionIds = inventory.summaryVersions
      .filter((version) => !version.current)
      .map((version) => version.id);
    const keptObservations = inventory.observations
      .filter((observation) => observation.duplicateOf === undefined)
      .sort((left, right) => {
        const leftMs = parseMs(left.occurredAt, 0);
        const rightMs = parseMs(right.occurredAt, 0);
        if (leftMs !== rightMs) return rightMs - leftMs;
        return left.id.localeCompare(right.id);
      });
    const keptVersions = inventory.summaryVersions
      .filter((version) => version.current)
      .sort((left, right) => {
        const leftMs = parseMs(left.occurredAt, 0);
        const rightMs = parseMs(right.occurredAt, 0);
        if (leftMs !== rightMs) return rightMs - leftMs;
        return left.id.localeCompare(right.id);
      });

    const preservedFactIds = inventory.facts.map((fact) => fact.id);
    const preservedDecisionIds = [...new Set(capsules.map((capsule) => capsule.decisionId))];
    const knowledgeBytes = sumBytes(inventory.facts) + capsuleBytes;
    const deferredHistoryIds: string[] = [];
    let retainedBytes = knowledgeBytes;

    if (level === 'hard') {
      const budget = Math.max(0, limits.derivedHardQuotaBytes - knowledgeBytes);
      let used = 0;
      for (const observation of keptObservations) {
        if (used + observation.bytes > budget) {
          deferredHistoryIds.push(observation.id);
          continue;
        }
        used += observation.bytes;
      }
      for (const version of keptVersions) {
        if (used + version.bytes > budget) {
          deferredHistoryIds.push(version.id);
          continue;
        }
        used += version.bytes;
      }
      retainedBytes = knowledgeBytes + used;
    } else {
      retainedBytes = knowledgeBytes + sumBytes(keptObservations) + sumBytes(keptVersions);
    }

    return {
      compactedObservationIds,
      droppedSummaryVersionIds,
      preservedFactIds,
      preservedDecisionIds,
      deferredHistoryIds,
      retainedBytes,
      requestedBytes,
      level,
    };
  }

  function failureReason(error: unknown): string {
    if (error instanceof Error && error.message.length > 0) return error.message;
    const text = String(error);
    return text.length > 0 ? text : 'summary worker failed without a reason';
  }

  function localSummary(job: SummaryJob): string {
    return `local ${job.kind} summary for ${job.id}: ${job.input}`;
  }

  async function run(runOptions?: { now?: Date; summarize?: (job: SummaryJob) => Promise<string> }): Promise<RetentionReport> {
    if (closed) throw new Error('memory retention is closed');
    const ranAt = runOptions?.now ?? now();
    const atMs = ranAt.getTime();
    const artifacts = await source.artifacts();
    const decisions = await source.decisions();
    const inventory = await source.derived();
    const jobs = await source.summaryJobs();

    const rawPlan = planRaw(artifacts, atMs);
    for (const artifact of [...rawPlan.expiredByDeadline, ...rawPlan.expiredByQuota]) {
      expiredArtifactIds.add(artifact.id);
    }
    await persist();

    const capsules = decisions.map((decision) => capsuleFor(decision));
    const derivedPlan = planDerived(inventory, capsules);

    const completed: { id: string; bytes: number }[] = [];
    const failed: { id: string; reason: string }[] = [];
    for (const job of jobs) {
      try {
        const summary = runOptions?.summarize === undefined
          ? localSummary(job)
          : await runOptions.summarize(job);
        completed.push({ id: job.id, bytes: Math.max(1, byteLength(summary)) });
      } catch (error) {
        failed.push({ id: job.id, reason: failureReason(error) });
      }
    }

    const gaps: RetentionGap[] = [];
    const deadlineIds = rawPlan.expiredByDeadline.map((artifact) => artifact.id);
    if (deadlineIds.length > 0) {
      gaps.push({
        kind: 'raw_source_expired',
        detail: `raw sources expired past the ${limits.rawRetentionDays}-day retention deadline`,
        artifactIds: deadlineIds,
      });
    }
    const quotaIds = rawPlan.expiredByQuota.map((artifact) => artifact.id);
    if (quotaIds.length > 0 || rawPlan.overQuotaAfter) {
      gaps.push({
        kind: 'raw_quota_exceeded',
        detail: rawPlan.overQuotaAfter
          ? 'raw storage is still over quota after evicting every unpinned artifact; raise the quota or export an archive'
          : 'raw storage exceeded its quota and the oldest unpinned artifacts were evicted',
        artifactIds: quotaIds.length > 0 ? quotaIds : rawPlan.retained.map((artifact) => artifact.id),
      });
    }
    const truncatedDecisions = capsules.filter((capsule) => capsule.truncated);
    if (truncatedDecisions.length > 0) {
      gaps.push({
        kind: 'capsule_truncated',
        detail: `capsule text was truncated to the ${limits.capsuleBytes}-byte bound`,
        decisionIds: truncatedDecisions.map((capsule) => capsule.decisionId),
      });
    }
    if (derivedPlan.level === 'hard') {
      gaps.push({
        kind: 'derived_quota_hard',
        detail: 'derived storage exceeds its hard quota; low-value history was deferred, not deleted',
      });
    } else if (derivedPlan.level === 'soft') {
      gaps.push({
        kind: 'derived_quota_soft',
        detail: 'derived storage exceeded its soft quota; redundant observations and old summary versions were compacted',
      });
    }
    if (failed.length > 0) {
      gaps.push({
        kind: 'summary_failed',
        detail: `summary worker(s) failed: ${failed.map((job) => job.id).join(', ')}`,
        jobIds: failed.map((job) => job.id),
      });
    }

    const rawLevel: PressureLevel = rawPlan.rawBytesAfter > limits.rawQuotaBytes ? 'hard' : 'ok';
    const overallLevel = maxLevel(rawLevel, derivedPlan.level);
    coverage = {
      semantic: failed.length > 0 ? 'partial' : 'complete',
      failedJobs: failed.map((job) => job.id),
      gaps,
    };

    const expired: ExpiredArtifact[] = [
      ...rawPlan.expiredByDeadline.map((artifact) => ({
        id: artifact.id,
        kind: artifact.kind,
        bytes: artifact.bytes,
        occurredAt: artifact.occurredAt,
        reason: 'retention_deadline' as const,
      })),
      ...rawPlan.expiredByQuota.map((artifact) => ({
        id: artifact.id,
        kind: artifact.kind,
        bytes: artifact.bytes,
        occurredAt: artifact.occurredAt,
        reason: 'raw_quota' as const,
      })),
    ];
    const expiredBytes = sumBytes(expired);

    return {
      ranAt: ranAt.toISOString(),
      expiry: {
        expired,
        expiredArtifactIds: expired.map((artifact) => artifact.id),
        expiredBytes,
        freedBytes: expiredBytes,
        rawBytesBefore: rawPlan.rawBytesBefore,
        rawBytesAfter: rawPlan.rawBytesAfter,
        retainedArtifactIds: rawPlan.retained.map((artifact) => artifact.id),
      },
      decisions: capsules.map((capsule) => ({
        decisionId: capsule.decisionId,
        capsuleId: capsule.id,
        capsuleBytes: capsule.bytes,
        truncated: capsule.truncated,
        rawAvailability: capsule.rawAvailability,
      })),
      compaction: {
        compactedObservationIds: derivedPlan.compactedObservationIds,
        droppedSummaryVersionIds: derivedPlan.droppedSummaryVersionIds,
        preservedFactIds: derivedPlan.preservedFactIds,
        preservedDecisionIds: derivedPlan.preservedDecisionIds,
        deferredHistoryIds: derivedPlan.deferredHistoryIds,
        actions: derivedPlan.level === 'hard' ? [storageAction()] : [],
      },
      jobs: { completed, failed },
      pressure: { level: overallLevel },
      coverage,
      gaps,
    };
  }

  async function pressure(): Promise<RetentionPressure> {
    const artifacts = await source.artifacts();
    const decisions = await source.decisions();
    const inventory = await source.derived();
    const retained = artifacts.filter((artifact) => !expiredArtifactIds.has(artifact.id));
    const rawBytes = sumBytes(retained);
    const capsules = decisions.map((decision) => capsuleFor(decision));
    const derivedPlan = planDerived(inventory, capsules);
    const rawLevel: PressureLevel = rawBytes > limits.rawQuotaBytes ? 'hard' : 'ok';
    const level = maxLevel(rawLevel, derivedPlan.level);
    const actions: StorageAction[] = level === 'hard' ? [storageAction()] : [];
    return {
      level,
      rawBytes,
      rawQuotaBytes: limits.rawQuotaBytes,
      derivedBytes: derivedPlan.retainedBytes,
      derivedRequestedBytes: derivedPlan.requestedBytes,
      derivedSoftQuotaBytes: limits.derivedSoftQuotaBytes,
      derivedHardQuotaBytes: limits.derivedHardQuotaBytes,
      actions,
    };
  }

  return {
    run,
    async capsule(decisionId: string): Promise<CapsuleRef | undefined> {
      const decisions = await source.decisions();
      const decision = decisions.find((candidate) => candidate.id === decisionId);
      return decision === undefined ? undefined : capsuleFor(decision);
    },
    pressure,
    async coverage(): Promise<RetentionCoverage> {
      return { semantic: coverage.semantic, failedJobs: [...coverage.failedJobs], gaps: coverage.gaps.map((gap) => ({ ...gap })) };
    },
    async close(): Promise<void> {
      closed = true;
    },
  };
}
