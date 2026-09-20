/**
 * M05 acceptance oracle — "Expired raw sources, capsules, quotas, and summary-worker failure"
 * (ticket M05 acceptance criteria 2 and 3; IMPLEMENTATION_PLAN.md §5.8 "Retention and deletion"
 * and §6 error handling).
 *
 * Test-role owned: the implementer never edits this file; it is the frozen oracle the M05 retention
 * implementation must satisfy. packages/memory/src/retention/index.ts does not exist yet, so the red
 * baseline reports the missing behavior as a named assertion instead of a module-resolution crash.
 * No model, network, or hardware call is made: the artifact/derived inventory is a deterministic
 * synthetic stand-in for the encrypted store, and the summary-worker failure is injected through the
 * documented fault seam.
 *
 * Frozen contract
 * ---------------
 * packages/memory/src/retention/index.ts
 *
 *   createMemoryRetention(options) -> Promise<MemoryRetention>
 *     options = {
 *       projectId: string,
 *       directory: string,                 durable retention-owned state (ids already retained)
 *       source: {
 *         artifacts()   -> Promise<readonly RawArtifact[]>,
 *         decisions()   -> Promise<readonly RetainedDecision[]>,
 *         derived()     -> Promise<DerivedInventory>,
 *         summaryJobs() -> Promise<readonly SummaryJob[]>,
 *       },
 *       now?: () => Date,                  defaults to the real clock
 *       limits?: Partial<{ rawRetentionDays: 30, rawQuotaBytes: 2 GiB, derivedSoftQuotaBytes: 1 GiB,
 *                          derivedHardQuotaBytes: 5 GiB, capsuleBytes: 4096 }>
 *     }
 *
 *   RawArtifact  = { id, kind: 'transcript'|'tool_output'|'screenshot'|'audio'|'other', bytes,
 *                    occurredAt, pinned?: boolean }
 *   RetainedDecision = { id, text, sourceArtifactIds, capsuleText }
 *   DerivedInventory = { facts: { id, bytes, current }[],
 *                        observations: { id, bytes, occurredAt, duplicateOf? }[],
 *                        summaryVersions: { id, bytes, occurredAt, current }[] }
 *   SummaryJob   = { id, kind: 'daily_card'|'summary', input }
 *
 *   MemoryRetention:
 *     run({ now?, summarize? }) -> Promise<RetentionReport>
 *         Expires raw artifacts past the retention deadline and, when the retained raw bytes still
 *         exceed rawQuotaBytes, the oldest unpinned artifacts first — each recorded individually with
 *         its byte count and reason, so nothing disappears without an accounting entry. Pinned
 *         artifacts are never expired. Then bounds derived growth, then runs the pending summary jobs
 *         with `summarize` (a deterministic local summarizer when omitted).
 *     capsule(decisionId) -> Promise<CapsuleRef | undefined>
 *         The retained supporting capsule for a decision: bounded to `capsuleBytes`, kept after its
 *         raw sources expire, labeled rawAvailability 'expired' in that case, and never silently
 *         truncated (oversized text sets truncated: true and raises a 'capsule_truncated' gap).
 *     pressure() -> Promise<RetentionPressure>
 *         level grades the demand the source asks to keep (facts + observations + summary versions +
 *         capsules): 'soft' when it exceeds derivedSoftQuotaBytes, 'hard' when it exceeds
 *         derivedHardQuotaBytes. derivedRequestedBytes is that demand and derivedBytes is what is
 *         actually retained after compaction/deferral — the retained bytes must stay within the hard
 *         quota even while the demand is over it, and hard pressure exposes the storage action.
 *     coverage() -> Promise<RetentionCoverage>
 *     close() -> Promise<void>
 *
 * Frozen behavior (each assertion below names the clause it enforces):
 *   1. §5.8 deadline: raw transcripts/tool artifacts expire 30 days after they occurred, oldest
 *      first, and every expiry is reported with its exact bytes and reason ('retention_deadline').
 *   2. §5.8 raw quota: when the retained raw bytes exceed the 2 GiB raw quota, the oldest unpinned
 *      artifacts are expired ('raw_quota') until the quota holds. Pinned records are never deleted to
 *      silence disk exhaustion; a leftover overage is reported as a visible gap plus a storage
 *      action instead of deleting more.
 *   3. Criteria 2: a retained decision keeps its text and a small capsule (default <= 4096 bytes);
 *      after its raw sources expire the capsule is still returned and labeled rawAvailability
 *      'expired', so the answer path can say "the raw source is gone" instead of inventing one.
 *   4. §5.8 derived quotas: at the 1 GiB soft quota compact redundant observations and old summary
 *      versions while preserving current facts, decisions, and capsules; at the 5 GiB hard quota
 *      preserve existing knowledge, stop adding low-value history, and expose a storage action.
 *   5. Criterion 3: a summary worker that throws is reported in jobs.failed with its reason and a
 *      'summary_failed' gap, coverage is 'partial' with that job id, the run itself still completes
 *      and the other jobs still complete. Completeness is never fabricated: a later run retries the
 *      failed job, and only then does coverage return to 'complete'.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

type ArtifactKind = 'transcript' | 'tool_output' | 'screenshot' | 'audio' | 'other';
type JobKind = 'daily_card' | 'summary';
type PressureLevel = 'ok' | 'soft' | 'hard';

interface RawArtifact {
  id: string;
  kind: ArtifactKind;
  bytes: number;
  occurredAt: string;
  pinned?: boolean;
}

interface RetainedDecision {
  id: string;
  text: string;
  sourceArtifactIds: readonly string[];
  capsuleText: string;
}

interface DerivedFact {
  id: string;
  bytes: number;
  current: boolean;
}

interface DerivedObservation {
  id: string;
  bytes: number;
  occurredAt: string;
  duplicateOf?: string;
}

interface DerivedSummaryVersion {
  id: string;
  bytes: number;
  occurredAt: string;
  current: boolean;
}

interface DerivedInventory {
  facts: readonly DerivedFact[];
  observations: readonly DerivedObservation[];
  summaryVersions: readonly DerivedSummaryVersion[];
}

interface SummaryJob {
  id: string;
  kind: JobKind;
  input: string;
}

interface RetentionSource {
  artifacts(): Promise<readonly RawArtifact[]>;
  decisions(): Promise<readonly RetainedDecision[]>;
  derived(): Promise<DerivedInventory>;
  summaryJobs(): Promise<readonly SummaryJob[]>;
}

interface RetentionLimits {
  rawRetentionDays: number;
  rawQuotaBytes: number;
  derivedSoftQuotaBytes: number;
  derivedHardQuotaBytes: number;
  capsuleBytes: number;
}

interface RetentionGap {
  kind: string;
  detail: string;
  artifactIds?: readonly string[];
  decisionIds?: readonly string[];
  jobIds?: readonly string[];
}

interface RetentionCoverage {
  semantic: 'complete' | 'partial';
  failedJobs: readonly string[];
  gaps: readonly RetentionGap[];
}

interface CapsuleRef {
  id: string;
  decisionId: string;
  bytes: number;
  text: string;
  truncated: boolean;
  sourceArtifactIds: readonly string[];
  rawAvailability: 'available' | 'expired';
}

interface ExpiredArtifact {
  id: string;
  kind: ArtifactKind;
  bytes: number;
  occurredAt: string;
  reason: 'retention_deadline' | 'raw_quota';
}

interface StorageAction {
  kind: string;
  options: readonly string[];
}

interface ExpiryReport {
  expired: readonly ExpiredArtifact[];
  expiredArtifactIds: readonly string[];
  expiredBytes: number;
  freedBytes: number;
  rawBytesBefore: number;
  rawBytesAfter: number;
  retainedArtifactIds: readonly string[];
}

interface DecisionRetentionReport {
  decisionId: string;
  capsuleId: string;
  capsuleBytes: number;
  truncated: boolean;
  rawAvailability: 'available' | 'expired';
}

interface CompactionReport {
  compactedObservationIds: readonly string[];
  droppedSummaryVersionIds: readonly string[];
  preservedFactIds: readonly string[];
  preservedDecisionIds: readonly string[];
  deferredHistoryIds: readonly string[];
  actions: readonly StorageAction[];
}

interface SummaryRunReport {
  completed: readonly { id: string; bytes: number }[];
  failed: readonly { id: string; reason: string }[];
}

interface RetentionReport {
  ranAt: string;
  expiry: ExpiryReport;
  decisions: readonly DecisionRetentionReport[];
  compaction: CompactionReport;
  jobs: SummaryRunReport;
  pressure: { level: PressureLevel };
  coverage: RetentionCoverage;
  gaps: readonly RetentionGap[];
}

interface RetentionPressure {
  level: PressureLevel;
  rawBytes: number;
  rawQuotaBytes: number;
  derivedBytes: number;
  derivedRequestedBytes: number;
  derivedSoftQuotaBytes: number;
  derivedHardQuotaBytes: number;
  actions: readonly StorageAction[];
}

interface MemoryRetention {
  run(options?: { now?: Date; summarize?: (job: SummaryJob) => Promise<string> }): Promise<RetentionReport>;
  capsule(decisionId: string): Promise<CapsuleRef | undefined>;
  pressure(): Promise<RetentionPressure>;
  coverage(): Promise<RetentionCoverage>;
  close(): Promise<void>;
}

interface RetentionOptions {
  projectId: string;
  directory: string;
  source: RetentionSource;
  now?: () => Date;
  limits?: Partial<RetentionLimits>;
}

interface RetentionModule {
  createMemoryRetention(options: RetentionOptions): Promise<MemoryRetention>;
}

const PROJECT_ID = 'project-atlas';
const NOW = new Date('2026-09-21T12:00:00.000Z');
const RETENTION_DAYS = 30;
const CAPSULE_LIMIT = 4096;
const MEBIBYTE = 1024 * 1024;
const GIBIBYTE = 1024 * MEBIBYTE;

const clock = (): Date => new Date(NOW.getTime());

function daysBefore(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

function isModuleNotFound(error: unknown): boolean {
  const code = (error as { code?: string } | undefined)?.code;
  const message = String((error as Error | undefined)?.message ?? '');
  return code === 'ERR_MODULE_NOT_FOUND' || /Cannot find (module|package)/.test(message);
}

const MISSING_MODULE_MESSAGE = 'Missing required behavior: packages/memory/src/retention/index.ts must export '
  + 'createMemoryRetention({ projectId, directory, source, now?, limits? }) returning run({ now?, summarize? }), '
  + 'capsule(decisionId), pressure(), coverage() and close().';

async function loadRetentionModule(): Promise<RetentionModule> {
  const specifier = './index.js';
  let loaded: Record<string, unknown>;
  try {
    loaded = (await import(specifier)) as unknown as Record<string, unknown>;
  } catch (error) {
    if (isModuleNotFound(error)) assert.fail(MISSING_MODULE_MESSAGE);
    throw error;
  }
  assert.equal(typeof loaded.createMemoryRetention, 'function', MISSING_MODULE_MESSAGE);
  return loaded as unknown as RetentionModule;
}

const temporaryDirectories: string[] = [];

async function makeDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

after(async () => {
  for (const directory of temporaryDirectories) {
    await rm(directory, { recursive: true, force: true });
  }
});

function artifact(input: {
  id: string;
  kind?: ArtifactKind;
  bytes: number;
  daysAgo: number;
  pinned?: boolean;
}): RawArtifact {
  const record: RawArtifact = {
    id: input.id,
    kind: input.kind ?? 'transcript',
    bytes: input.bytes,
    occurredAt: daysBefore(input.daysAgo),
  };
  if (input.pinned === true) record.pinned = true;
  return record;
}

function observation(input: { id: string; bytes: number; daysAgo: number; duplicateOf?: string }): DerivedObservation {
  const record: DerivedObservation = {
    id: input.id,
    bytes: input.bytes,
    occurredAt: daysBefore(input.daysAgo),
  };
  if (input.duplicateOf !== undefined) record.duplicateOf = input.duplicateOf;
  return record;
}

interface MutableInventory {
  artifacts: RawArtifact[];
  decisions: RetainedDecision[];
  facts: DerivedFact[];
  observations: DerivedObservation[];
  summaryVersions: DerivedSummaryVersion[];
  jobs: SummaryJob[];
}

/** A source whose inventory the test can grow between runs, standing in for days of new activity. */
function mutableSource(state: MutableInventory): RetentionSource {
  return {
    async artifacts() {
      return state.artifacts.map((entry) => ({ ...entry }));
    },
    async decisions() {
      return state.decisions.map((entry) => ({ ...entry, sourceArtifactIds: [...entry.sourceArtifactIds] }));
    },
    async derived() {
      return {
        facts: state.facts.map((entry) => ({ ...entry })),
        observations: state.observations.map((entry) => ({ ...entry })),
        summaryVersions: state.summaryVersions.map((entry) => ({ ...entry })),
      };
    },
    async summaryJobs() {
      return state.jobs.map((entry) => ({ ...entry }));
    },
  };
}

interface RetentionHarness {
  retention: MemoryRetention;
  directory: string;
}

async function openRetention(input: {
  source: RetentionSource;
  limits?: Partial<RetentionLimits>;
}): Promise<RetentionHarness> {
  const module = await loadRetentionModule();
  const directory = await makeDirectory('m05-retention-');
  const options: RetentionOptions = { projectId: PROJECT_ID, directory, source: input.source, now: clock };
  if (input.limits !== undefined) options.limits = input.limits;
  const retention = await module.createMemoryRetention(options);
  return { retention, directory };
}

async function requireCapsule(retention: MemoryRetention, decisionId: string): Promise<CapsuleRef> {
  const capsule = await retention.capsule(decisionId);
  if (capsule === undefined) assert.fail(`the retained decision ${decisionId} must keep a supporting capsule`);
  return capsule;
}

function sumBytes(entries: readonly { bytes: number }[]): number {
  return entries.reduce((total, entry) => total + entry.bytes, 0);
}

function gapOfKinds(gaps: readonly RetentionGap[], kind: string): RetentionGap[] {
  return gaps.filter((gap) => gap.kind === kind);
}

function failedJobIds(report: RetentionReport): string[] {
  return report.jobs.failed.map((job) => job.id);
}

function completedJobIds(report: RetentionReport): string[] {
  return report.jobs.completed.map((job) => job.id);
}

function storageActionOptions(actions: readonly StorageAction[]): string[] {
  return actions.filter((action) => action.kind === 'storage_action').flatMap((action) => [...action.options]);
}

const LONG_CAPSULE_TEXT = `${'the retention decision excerpt. '.repeat(400)}end-of-capsule`;

const DEADLINE_ARTIFACTS: readonly RawArtifact[] = [
  artifact({ id: 'artifact-old-transcript', bytes: 4 * MEBIBYTE, daysAgo: 45 }),
  artifact({ id: 'artifact-old-tool-output', kind: 'tool_output', bytes: MEBIBYTE, daysAgo: 31 }),
  artifact({ id: 'artifact-old-noise', kind: 'screenshot', bytes: 512 * 1024, daysAgo: 40 }),
  artifact({ id: 'artifact-recent-transcript', bytes: 2 * MEBIBYTE, daysAgo: 2 }),
  artifact({ id: 'artifact-pinned-transcript', bytes: 8 * MEBIBYTE, daysAgo: 60, pinned: true }),
];

const DEADLINE_DECISIONS: readonly RetainedDecision[] = [
  {
    id: 'decision-retention-window',
    text: 'Decision: raw transcripts expire after thirty days while the decision itself is retained.',
    sourceArtifactIds: ['artifact-old-transcript', 'artifact-old-tool-output'],
    capsuleText: 'Retention decision excerpt: raw transcripts expire after thirty days; structured state survives.',
  },
  {
    id: 'decision-oversized-capsule',
    text: 'Decision: the nightly export keeps its checkpoint in the sealed journal.',
    sourceArtifactIds: ['artifact-recent-transcript'],
    capsuleText: LONG_CAPSULE_TEXT,
  },
  {
    id: 'decision-pinned-source',
    text: 'Decision: the pinned incident review must never be deleted to free disk space.',
    sourceArtifactIds: ['artifact-pinned-transcript'],
    capsuleText: 'Pinned decision excerpt: the incident review stays until the user unpins it.',
  },
];

test('raw expiry follows the retention deadline, keeps decisions with bounded capsules, and accounts for every artifact', async () => {
  const state: MutableInventory = {
    artifacts: [...DEADLINE_ARTIFACTS],
    decisions: [...DEADLINE_DECISIONS],
    facts: [{ id: 'fact-retention', bytes: 2_000, current: true }],
    observations: [],
    summaryVersions: [],
    jobs: [],
  };
  const harness = await openRetention({
    source: mutableSource(state),
    limits: { rawRetentionDays: RETENTION_DAYS, rawQuotaBytes: 2 * GIBIBYTE, capsuleBytes: CAPSULE_LIMIT },
  });
  const report = await harness.retention.run({ now: NOW });

  const expiredIds = [...report.expiry.expiredArtifactIds].sort();
  assert.deepEqual(expiredIds, ['artifact-old-noise', 'artifact-old-tool-output', 'artifact-old-transcript'],
    'artifacts older than the 30-day retention deadline must expire, oldest first, and nothing else');
  assert.ok(report.expiry.expired.every((entry) => entry.reason === 'retention_deadline'),
    'deadline expiries must be labeled with their reason');
  assert.equal(report.expiry.expiredBytes, 5.5 * MEBIBYTE,
    `expired bytes must be the exact sum of the expired artifacts, saw ${report.expiry.expiredBytes}`);
  assert.equal(report.expiry.freedBytes, report.expiry.expiredBytes, 'freed bytes must equal expired bytes');
  assert.equal(report.expiry.rawBytesBefore, 15.5 * MEBIBYTE);
  assert.equal(report.expiry.rawBytesAfter, 10 * MEBIBYTE,
    'only the recent and pinned artifacts may remain in raw storage');
  assert.deepEqual([...report.expiry.retainedArtifactIds].sort(), ['artifact-pinned-transcript', 'artifact-recent-transcript']);
  assert.equal(report.expiry.expiredArtifactIds.length + report.expiry.retainedArtifactIds.length,
    DEADLINE_ARTIFACTS.length,
    'every artifact must be accounted for as retained or expired — never dropped silently');
  assert.equal(report.expiry.rawBytesAfter + report.expiry.expiredBytes, report.expiry.rawBytesBefore,
    'the byte accounting must balance');

  const expiryGaps = gapOfKinds(report.gaps, 'raw_source_expired');
  assert.equal(expiryGaps.length >= 1, true, 'expiring raw sources must raise a visible raw_source_expired gap');
  const namedArtifacts = new Set(expiryGaps.flatMap((gap) => [...(gap.artifactIds ?? [])]));
  for (const id of expiredIds) {
    assert.ok(namedArtifacts.has(id), `the raw_source_expired gap must name the expired artifact ${id}`);
  }

  const retainedDecision = report.decisions.find((entry) => entry.decisionId === 'decision-retention-window');
  assert.ok(retainedDecision !== undefined, 'a decision whose sources expired must still be reported as retained');
  assert.equal(retainedDecision.rawAvailability, 'expired',
    'a decision whose raw sources expired must be labeled unavailable, not presented as complete');
  const capsule = await requireCapsule(harness.retention, 'decision-retention-window');
  assert.equal(capsule.rawAvailability, 'expired');
  assert.ok(capsule.bytes > 0 && capsule.bytes <= CAPSULE_LIMIT,
    `the retained decision keeps a small supporting capsule, saw ${capsule.bytes} bytes`);
  assert.equal(capsule.truncated, false, 'a capsule that fits must not be reported as truncated');
  assert.ok(capsule.text.includes('thirty days'),
    'the capsule must preserve the supporting excerpt that substantiates the retained decision');
  assert.deepEqual([...capsule.sourceArtifactIds].sort(), ['artifact-old-tool-output', 'artifact-old-transcript'],
    'the capsule must keep the ids of the raw sources it came from');

  const oversized = await requireCapsule(harness.retention, 'decision-oversized-capsule');
  assert.ok(oversized.bytes <= CAPSULE_LIMIT,
    `an oversized capsule must be bounded to ${CAPSULE_LIMIT} bytes, saw ${oversized.bytes}`);
  assert.equal(oversized.truncated, true, 'truncating a capsule must be reported, never silent');
  assert.ok(oversized.text.length > 0, 'a truncated capsule keeps the leading excerpt');
  const truncationGaps = gapOfKinds(report.gaps, 'capsule_truncated');
  assert.equal(truncationGaps.length, 1, 'a truncated capsule must raise exactly one visible gap');
  assert.deepEqual([...(truncationGaps[0]?.decisionIds ?? [])], ['decision-oversized-capsule']);

  const pinned = await requireCapsule(harness.retention, 'decision-pinned-source');
  assert.equal(pinned.rawAvailability, 'available', 'a pinned artifact keeps its raw source available');

  const pressure = await harness.retention.pressure();
  assert.equal(pressure.level, 'ok', 'a corpus inside every quota is not under pressure');
  assert.equal(pressure.rawBytes, 10 * MEBIBYTE);
  assert.equal(pressure.rawQuotaBytes, 2 * GIBIBYTE);
  assert.deepEqual([...pressure.actions], [], 'no storage action is needed while quotas hold');

  const coverage = await harness.retention.coverage();
  assert.equal(coverage.semantic, 'complete', 'a run with no failed jobs keeps complete coverage');
  assert.deepEqual([...coverage.failedJobs], []);

  const second = await harness.retention.run({ now: NOW });
  assert.deepEqual([...second.expiry.expiredArtifactIds], [],
    're-running expiry at the same instant must not expire anything twice');
  assert.equal(second.expiry.rawBytesAfter, report.expiry.rawBytesAfter);

  await harness.retention.close();
});

const QUOTA_ARTIFACTS: readonly RawArtifact[] = [
  artifact({ id: 'artifact-quota-1', bytes: 2 * MEBIBYTE, daysAgo: 9 }),
  artifact({ id: 'artifact-quota-2', bytes: 2 * MEBIBYTE, daysAgo: 8 }),
  artifact({ id: 'artifact-quota-3', bytes: 1.5 * MEBIBYTE, daysAgo: 7 }),
  artifact({ id: 'artifact-quota-4', bytes: 3 * MEBIBYTE, daysAgo: 6 }),
  artifact({ id: 'artifact-quota-pinned', bytes: 2.5 * MEBIBYTE, daysAgo: 5, pinned: true }),
];

const QUOTA_DECISIONS: readonly RetainedDecision[] = [
  {
    id: 'decision-quota-raw',
    text: 'Decision: raw tool output is evicted oldest first when the project exceeds its raw quota.',
    sourceArtifactIds: ['artifact-quota-1', 'artifact-quota-3'],
    capsuleText: 'Quota decision excerpt: raw tool output is evicted oldest first; the decision is retained.',
  },
  {
    id: 'decision-quota-pinned',
    text: 'Decision: the pinned incident review survives every quota pass.',
    sourceArtifactIds: ['artifact-quota-pinned'],
    capsuleText: 'Pinned decision excerpt: never delete the pinned incident review to free disk space.',
  },
];

test('raw quota pressure expires the oldest unpinned artifacts first and never deletes pinned knowledge or capsules', async () => {
  const state: MutableInventory = {
    artifacts: [...QUOTA_ARTIFACTS],
    decisions: [...QUOTA_DECISIONS],
    facts: [],
    observations: [],
    summaryVersions: [],
    jobs: [],
  };
  const harness = await openRetention({
    source: mutableSource(state),
    limits: { rawRetentionDays: RETENTION_DAYS, rawQuotaBytes: 6 * MEBIBYTE, capsuleBytes: CAPSULE_LIMIT },
  });
  const report = await harness.retention.run({ now: NOW });

  assert.deepEqual([...report.expiry.expiredArtifactIds],
    ['artifact-quota-1', 'artifact-quota-2', 'artifact-quota-3'],
    'quota eviction must expire the oldest unpinned artifacts first and stop as soon as the quota holds');
  assert.ok(report.expiry.expired.every((entry) => entry.reason === 'raw_quota'),
    'quota evictions must be labeled with their reason, distinct from the retention deadline');
  assert.equal(report.expiry.expiredBytes, 5.5 * MEBIBYTE,
    'the expired byte total must be the exact sum of the evicted artifacts');
  assert.ok(report.expiry.rawBytesAfter <= 6 * MEBIBYTE,
    `the raw store must come back under its quota, saw ${report.expiry.rawBytesAfter}`);
  assert.deepEqual([...report.expiry.retainedArtifactIds].sort(),
    ['artifact-quota-4', 'artifact-quota-pinned'],
    'the pinned artifact and the newest unpinned artifact must survive');
  assert.ok(!report.expiry.expiredArtifactIds.includes('artifact-quota-pinned'),
    'a pinned artifact must never be evicted to stay silent about disk exhaustion');

  const quotaGaps = gapOfKinds(report.gaps, 'raw_quota_exceeded');
  assert.equal(quotaGaps.length >= 1, true, 'quota eviction must raise a visible raw_quota_exceeded gap');
  const quotaArtifactIds = new Set(quotaGaps.flatMap((gap) => [...(gap.artifactIds ?? [])]));
  for (const id of ['artifact-quota-1', 'artifact-quota-2', 'artifact-quota-3']) {
    assert.ok(quotaArtifactIds.has(id), `the quota gap must name the evicted artifact ${id}`);
  }

  const evictedCapsule = await requireCapsule(harness.retention, 'decision-quota-raw');
  assert.equal(evictedCapsule.rawAvailability, 'expired',
    'a decision whose raw sources were evicted must be labeled unavailable');
  assert.ok(evictedCapsule.bytes > 0 && evictedCapsule.bytes <= CAPSULE_LIMIT,
    'quota eviction must not take the retained capsule with it');
  assert.ok(evictedCapsule.text.includes('oldest first'));
  const pinnedCapsule = await requireCapsule(harness.retention, 'decision-quota-pinned');
  assert.equal(pinnedCapsule.rawAvailability, 'available');

  const pressure = await harness.retention.pressure();
  assert.equal(pressure.level, 'ok', 'after eviction the project is back inside its raw quota');
  assert.ok(pressure.rawBytes <= pressure.rawQuotaBytes);

  const second = await harness.retention.run({ now: NOW });
  assert.deepEqual([...second.expiry.expiredArtifactIds], [],
    'a second run at the same instant must not evict the same artifacts again');
  assert.equal(second.expiry.rawBytesAfter, report.expiry.rawBytesAfter);

  await harness.retention.close();

  const overPinnedState: MutableInventory = {
    artifacts: [
      artifact({ id: 'artifact-quota-pinned', bytes: 2.5 * MEBIBYTE, daysAgo: 5, pinned: true }),
      artifact({ id: 'artifact-quota-unpinned', bytes: 2 * MEBIBYTE, daysAgo: 4 }),
    ],
    decisions: [...QUOTA_DECISIONS],
    facts: [],
    observations: [],
    summaryVersions: [],
    jobs: [],
  };
  const overPinned = await openRetention({
    source: mutableSource(overPinnedState),
    limits: { rawRetentionDays: RETENTION_DAYS, rawQuotaBytes: MEBIBYTE, capsuleBytes: CAPSULE_LIMIT },
  });
  const overPinnedReport = await overPinned.retention.run({ now: NOW });
  assert.deepEqual([...overPinnedReport.expiry.expiredArtifactIds], ['artifact-quota-unpinned'],
    'only the unpinned artifact may be evicted; a pinned artifact is never deleted to satisfy a quota');
  const overPinnedPressure = await overPinned.retention.pressure();
  assert.equal(overPinnedPressure.level, 'hard',
    'a raw store that is still over quota after eviction must report hard pressure');
  assert.ok(overPinnedPressure.rawBytes > overPinnedPressure.rawQuotaBytes);
  assert.ok(storageActionOptions(overPinnedPressure.actions).length > 0,
    'hard pressure must expose a storage action instead of silently deleting pinned knowledge');
  assert.equal(gapOfKinds(overPinnedReport.gaps, 'raw_quota_exceeded').length >= 1, true,
    'the unresolved overage must remain visible as a gap');
  const stillAvailable = await requireCapsule(overPinned.retention, 'decision-quota-pinned');
  assert.equal(stillAvailable.rawAvailability, 'available');
  await overPinned.retention.close();
});

const SOFT_FACTS: readonly DerivedFact[] = [
  { id: 'fact-derived-1', bytes: 4_000, current: true },
  { id: 'fact-derived-2', bytes: 4_000, current: true },
];

const SOFT_OBSERVATIONS: readonly DerivedObservation[] = [
  observation({ id: 'obs-derived-1', bytes: 6_000, daysAgo: 6 }),
  observation({ id: 'obs-derived-2', bytes: 6_000, daysAgo: 6, duplicateOf: 'obs-derived-1' }),
  observation({ id: 'obs-derived-3', bytes: 6_000, daysAgo: 4 }),
  observation({ id: 'obs-derived-4', bytes: 6_000, daysAgo: 4, duplicateOf: 'obs-derived-3' }),
];

const SOFT_SUMMARY_VERSIONS: readonly DerivedSummaryVersion[] = [
  { id: 'sv-derived-1', bytes: 8_000, occurredAt: daysBefore(9), current: false },
  { id: 'sv-derived-2', bytes: 8_000, occurredAt: daysBefore(6), current: false },
  { id: 'sv-derived-3', bytes: 8_000, occurredAt: daysBefore(3), current: true },
];

const DERIVED_DECISIONS: readonly RetainedDecision[] = [
  {
    id: 'decision-derived-quota',
    text: 'Decision: derived history is compacted before any current fact or capsule is discarded.',
    sourceArtifactIds: ['artifact-derived-source'],
    capsuleText: 'Derived quota excerpt: compact redundant observations and old summary versions first.',
  },
];

function derivedInventoryState(options: {
  facts: readonly DerivedFact[];
  observations: readonly DerivedObservation[];
  summaryVersions: readonly DerivedSummaryVersion[];
}): MutableInventory {
  return {
    artifacts: [artifact({ id: 'artifact-derived-source', bytes: MEBIBYTE, daysAgo: 1 })],
    decisions: [...DERIVED_DECISIONS],
    facts: [...options.facts],
    observations: [...options.observations],
    summaryVersions: [...options.summaryVersions],
    jobs: [],
  };
}

test('derived soft quota compacts redundant observations and old summary versions without dropping knowledge', async () => {
  const state = derivedInventoryState({
    facts: SOFT_FACTS,
    observations: SOFT_OBSERVATIONS,
    summaryVersions: SOFT_SUMMARY_VERSIONS,
  });
  assert.ok(sumBytes(state.facts) + sumBytes(state.observations) + sumBytes(state.summaryVersions) > 40_000,
    'the fixture must exceed the soft quota so compaction is exercised');
  const harness = await openRetention({
    source: mutableSource(state),
    limits: {
      rawRetentionDays: RETENTION_DAYS,
      rawQuotaBytes: 2 * GIBIBYTE,
      derivedSoftQuotaBytes: 40_000,
      derivedHardQuotaBytes: 60_000,
      capsuleBytes: CAPSULE_LIMIT,
    },
  });
  const report = await harness.retention.run({ now: NOW });

  assert.deepEqual([...report.compaction.compactedObservationIds].sort(), ['obs-derived-2', 'obs-derived-4'],
    'the redundant duplicate observations must be compacted, and only those');
  assert.deepEqual([...report.compaction.droppedSummaryVersionIds].sort(), ['sv-derived-1', 'sv-derived-2'],
    'old summary versions must be dropped while the current version is kept');
  assert.deepEqual([...report.compaction.preservedFactIds].sort(), ['fact-derived-1', 'fact-derived-2'],
    'current facts are preserved at the soft quota');
  assert.deepEqual([...report.compaction.preservedDecisionIds], ['decision-derived-quota']);
  assert.deepEqual([...report.compaction.deferredHistoryIds], [],
    'nothing needs to be deferred while the hard quota still holds');
  const capsule = await requireCapsule(harness.retention, 'decision-derived-quota');
  assert.equal(capsule.rawAvailability, 'available');
  assert.ok(capsule.bytes <= CAPSULE_LIMIT);

  const pressure = await harness.retention.pressure();
  assert.ok(pressure.derivedRequestedBytes > pressure.derivedSoftQuotaBytes,
    'the fixture demand must exceed the soft quota for this gate to mean anything');
  assert.ok(pressure.derivedBytes <= pressure.derivedHardQuotaBytes,
    'compaction must keep the retained derived store inside the hard quota');
  assert.ok(pressure.derivedBytes <= pressure.derivedSoftQuotaBytes,
    'soft-quota compaction must bring the retained derived store back inside the soft quota');
  assert.equal(report.pressure.level, 'soft',
    'demand above the soft quota but below the hard quota is soft pressure');
  assert.deepEqual([...report.compaction.actions], [],
    'soft pressure compacts first; the storage action is only owed at hard pressure');
  assert.equal((await harness.retention.coverage()).semantic, 'complete');
  await harness.retention.close();
});

test('derived hard quota preserves knowledge, defers low-value history, and exposes a storage action', async () => {
  const crowdedObservations: DerivedObservation[] = [];
  for (let index = 0; index < 20; index += 1) {
    crowdedObservations.push(observation({ id: `obs-crowded-${index}`, bytes: 6_000, daysAgo: 20 - index }));
  }
  const crowdedVersions: DerivedSummaryVersion[] = [];
  for (let index = 0; index < 12; index += 1) {
    crowdedVersions.push({
      id: `sv-crowded-${index}`,
      bytes: 8_000,
      occurredAt: daysBefore(12 - index),
      current: index === 11,
    });
  }
  const state = derivedInventoryState({
    facts: SOFT_FACTS,
    observations: crowdedObservations,
    summaryVersions: crowdedVersions,
  });
  const limits: Partial<RetentionLimits> = {
    rawRetentionDays: RETENTION_DAYS,
    rawQuotaBytes: 2 * GIBIBYTE,
    derivedSoftQuotaBytes: 40_000,
    derivedHardQuotaBytes: 60_000,
    capsuleBytes: CAPSULE_LIMIT,
  };
  const harness = await openRetention({ source: mutableSource(state), limits });
  const report = await harness.retention.run({ now: NOW });

  assert.equal(report.pressure.level, 'hard', 'an inventory far over the hard quota must report hard pressure');
  const hardPressure = await harness.retention.pressure();
  assert.ok(hardPressure.derivedRequestedBytes > hardPressure.derivedHardQuotaBytes,
    'hard pressure means the demand itself exceeds the hard quota');
  assert.ok(hardPressure.derivedBytes <= hardPressure.derivedHardQuotaBytes,
    'the retained bytes must stay inside the hard quota even while the demand exceeds it');
  assert.ok(report.compaction.deferredHistoryIds.length > 0,
    'the hard quota must stop adding low-value history instead of deleting knowledge');
  assert.ok(report.compaction.deferredHistoryIds.includes('sv-crowded-11'),
    'the newest low-value summary version is deferred while the hard quota binds');
  assert.deepEqual([...report.compaction.preservedFactIds].sort(), ['fact-derived-1', 'fact-derived-2']);
  assert.deepEqual([...report.compaction.preservedDecisionIds], ['decision-derived-quota']);
  const actions = storageActionOptions(report.compaction.actions);
  assert.ok(actions.length > 0,
    'hard pressure must expose a storage action so the user can raise the quota or export/archive');
  assert.ok(actions.includes('raise_quota') && actions.includes('export_archive'),
    `the storage action must name its options, saw ${actions.join(', ') || '(none)'}`);
  assert.equal(gapOfKinds(report.gaps, 'derived_quota_hard').length >= 1, true,
    'the hard quota must be visible as a gap, not as a silent drop');
  const capsule = await requireCapsule(harness.retention, 'decision-derived-quota');
  assert.equal(capsule.rawAvailability, 'available');
  assert.ok(capsule.bytes <= CAPSULE_LIMIT, 'the hard quota never discards an evidence capsule');

  let previousVersionId = 'sv-crowded-11';
  for (let cycle = 0; cycle < 24; cycle += 1) {
    const versionId = `sv-cycle-${cycle}`;
    for (const version of state.summaryVersions) version.current = false;
    state.summaryVersions.push({ id: versionId, bytes: 8_000, occurredAt: daysBefore(0), current: true });
    state.observations.push(observation({ id: `obs-cycle-${cycle}`, bytes: 6_000, daysAgo: 0 }));
    if (cycle % 4 === 0) {
      state.observations.push(
        observation({ id: `obs-cycle-${cycle}-dup`, bytes: 6_000, daysAgo: 0, duplicateOf: `obs-cycle-${cycle}` }),
      );
    }
    const cycleReport = await harness.retention.run({ now: NOW });
    const cyclePressure = await harness.retention.pressure();
    assert.ok(cyclePressure.derivedBytes <= cyclePressure.derivedHardQuotaBytes,
      `cycle ${cycle} must stay inside the hard quota, saw ${cyclePressure.derivedBytes}`);
    assert.ok(cyclePressure.derivedRequestedBytes > cyclePressure.derivedHardQuotaBytes,
      `cycle ${cycle} must keep exercising the over-quota demand`);
    assert.deepEqual([...cycleReport.compaction.preservedFactIds].sort(), ['fact-derived-1', 'fact-derived-2'],
      `cycle ${cycle} must preserve every current fact`);
    assert.deepEqual([...cycleReport.compaction.preservedDecisionIds], ['decision-derived-quota'],
      `cycle ${cycle} must preserve every decision`);
    const cycleCapsule = await requireCapsule(harness.retention, 'decision-derived-quota');
    assert.ok(cycleCapsule.bytes > 0 && cycleCapsule.bytes <= CAPSULE_LIMIT,
      `cycle ${cycle} must keep the evidence capsule bounded`);
    assert.ok(cycleReport.compaction.deferredHistoryIds.includes(versionId),
      `cycle ${cycle} must defer the low-value history it cannot add (${versionId})`);
    previousVersionId = versionId;
    assert.equal(cycleReport.pressure.level, 'hard');
  }
  assert.ok(previousVersionId === 'sv-cycle-23');
  const coverage = await harness.retention.coverage();
  assert.equal(coverage.semantic, 'complete', 'quota pressure alone does not fabricate a failed job');
  await harness.retention.close();
});

const SUMMARY_JOBS: readonly SummaryJob[] = [
  { id: 'job-daily-card-1', kind: 'daily_card', input: 'day one of the multi-day project' },
  { id: 'job-summary-2', kind: 'summary', input: 'week two of the multi-day project' },
  { id: 'job-summary-broken', kind: 'summary', input: 'week three of the multi-day project' },
];

function summaryJobState(): MutableInventory {
  return {
    artifacts: [artifact({ id: 'artifact-summary-source', bytes: MEBIBYTE, daysAgo: 1 })],
    decisions: [...DERIVED_DECISIONS],
    facts: [...SOFT_FACTS],
    observations: [],
    summaryVersions: [],
    jobs: [...SUMMARY_JOBS],
  };
}

function workingSummarizer(job: SummaryJob): Promise<string> {
  return Promise.resolve(`summary(${job.input})`);
}

test('a failing summary worker stays bounded and reports a visible gap instead of fabricated completeness', async () => {
  const harness = await openRetention({
    source: mutableSource(summaryJobState()),
    limits: { rawRetentionDays: RETENTION_DAYS, rawQuotaBytes: 2 * GIBIBYTE, capsuleBytes: CAPSULE_LIMIT },
  });

  const failedRun = await harness.retention.run({
    now: NOW,
    summarize: async (job) => {
      if (job.id === 'job-summary-broken') throw new Error('summary worker exited 137 while reading the transcript');
      return workingSummarizer(job);
    },
  });

  assert.deepEqual(failedJobIds(failedRun), ['job-summary-broken'],
    'only the worker that threw may be reported as failed');
  assert.equal(failedRun.jobs.failed[0]?.reason.includes('137'), true,
    'the failure report must carry the worker reason, not a generic placeholder');
  assert.deepEqual([...completedJobIds(failedRun)].sort(), ['job-daily-card-1', 'job-summary-2'],
    'the other summary jobs must still complete: one failed worker must not abort the run');
  assert.ok(!completedJobIds(failedRun).includes('job-summary-broken'),
    'a failed job must never be counted as completed');
  assert.ok(failedRun.jobs.completed.every((job) => job.bytes > 0),
    'completed summaries must report their retained size');
  assert.equal(failedRun.coverage.semantic, 'partial',
    'a failed summary worker makes coverage partial, never complete');
  assert.ok([...failedRun.coverage.failedJobs].includes('job-summary-broken'));
  const failedGaps = gapOfKinds(failedRun.gaps, 'summary_failed');
  assert.equal(failedGaps.length, 1, 'the failed worker must raise exactly one summary_failed gap');
  assert.deepEqual([...(failedGaps[0]?.jobIds ?? [])], ['job-summary-broken'],
    'the summary gap must name the failed job so the gap is traceable');
  assert.equal(failedRun.expiry.rawBytesAfter <= failedRun.expiry.rawBytesBefore, true,
    'a failed summary worker must not disturb the bounded raw accounting');

  const retry = await harness.retention.run({ now: NOW, summarize: workingSummarizer });
  assert.deepEqual([...completedJobIds(retry)].sort(),
    ['job-daily-card-1', 'job-summary-2', 'job-summary-broken'],
    'a later run must retry the failed job instead of treating the failure as permanently done');
  assert.deepEqual([...retry.jobs.failed], []);
  assert.equal(retry.coverage.semantic, 'complete',
    'coverage returns to complete only after the failed job actually completes');
  assert.deepEqual([...retry.coverage.failedJobs], []);
  assert.deepEqual(gapOfKinds(retry.gaps, 'summary_failed'), []);

  const defaultRun = await harness.retention.run({ now: NOW });
  assert.deepEqual([...defaultRun.jobs.failed], [],
    'the default local summarizer must complete every job without a model call');
  assert.equal(defaultRun.coverage.semantic, 'complete');

  const coverage = await harness.retention.coverage();
  assert.equal(coverage.semantic, 'complete');
  assert.deepEqual([...coverage.gaps], []);
  await harness.retention.close();
});
