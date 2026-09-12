/**
 * M01 acceptance test — normalized event → encrypted store → restart → source-backed timeline query.
 *
 * Red baseline: `packages/memory/src/store/index.ts` does not exist yet, so this file reports the
 * missing behavior as an explicit assertion that names it instead of failing as a bare
 * module-resolution crash. Every other assertion states behavior the implementation must satisfy.
 *
 * Frozen contract for this ticket (IMPLEMENTATION_PLAN.md section 5.8 schema, section 5.3 envelopes):
 *
 *   createMemoryStore({ directory, key, profileId }) -> MemoryStore
 *     directory — root directory holding the profile database and one encrypted database per
 *                 project; every durable byte the store needs lives inside it.
 *     key       — key material for the encrypted databases; never written to disk in plaintext.
 *     profileId — profile registry identity for the store.
 *     Must reject when an existing store cannot be decrypted with `key`: a wrong key must never
 *     open, reset, or silently re-initialize an existing store.
 *
 *   store.ingest({ events, payloads }, options?) -> { durableCursor, inserted, duplicates }
 *     events   — normalized section 5.3 EventEnvelope records (synthetic fixture input).
 *     payloads — payload JSON keyed by each event's payloadRef.
 *     Transactional: envelopes, payloads, deterministic derived records, source offsets, and the
 *     durable cursor commit together or not at all.
 *     Idempotent by (sourceId, sourceEventId): replaying a committed batch inserts nothing,
 *     reports every event as a duplicate, and leaves the durable cursor unchanged.
 *     options.onBeforeCommit — fault-injection seam invoked inside the transaction immediately
 *     before COMMIT; a throw simulates a crash before the transaction commits and must roll the
 *     whole ingest back: no partial records and no durable-cursor advance.
 *
 *   store.timeline({ projectId, text? }) -> TimelineItem[]
 *     Source capsules plus deterministic derived records from one project database only; a query
 *     never crosses project boundaries.
 *     TimelineItem = { id, kind, summary, sourceEventIds, occurredAt, trust?, status? }
 *       - source capsule: exactly one per stored event; kind = event kind, id = eventId,
 *         summary = concise payload text (for a 'decision' event, the question and selected
 *         choice), trust = section 5.3 trust, sourceEventIds = [eventId].
 *       - task record: kind 'task', id = the external task id from the tool payload, status
 *         derived from the latest tool receipt. A failed exit code stays 'failed' even when a
 *         later agent message claims success (section 5.8 evidence hierarchy).
 *     `text` is a lexical (FTS/structured) match. Items are ordered by occurredAt ascending and
 *     are a pure function of stored data: reopening a store returns identical bundles.
 *
 *   store.durableCursor() -> Promise<string> — durable ingestion cursor; advances only on commit
 *   store.close() -> Promise<void>
 */
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const FIXTURE_URL = new URL('../../../../fixtures/memory/basic/events.json', import.meta.url);

const PROFILE_ID = 'profile-basic';
const PROJECT_ALPHA = 'project-alpha';
const PROJECT_BETA = 'project-beta';
/** Synthetic key material; both keys are the same length so only the value can be wrong. */
const STORE_KEY = '6b1f0c9a4e7d2583b6a1c0f4d9e8b7023a5c1d6e8f0a2b4c6d8e0f2a4b6c8d0e';
const WRONG_KEY = '0f9e8d7c6b5a4938271605f4e3d2c1b0a9f8e7d6c5b4a39281706f5e4d3c2b1a0';
const ALPHA_CANARY = 'echopilotm01canaryalpha7c1f9a';
const BETA_CANARY = 'echopilotm01canarybeta3d2e8b';
const CRASH_CANARY = 'echopilotm01canarycrash9a4b0c';

type EventEnvelope = {
  schemaVersion: 1;
  eventId: string;
  sourceId: string;
  sourceEventId: string;
  sourceSequence: number;
  ingestSequence: number;
  occurredAt: string;
  observedAt: string;
  scope: {
    profileId: string;
    projectId?: string;
    worktreeId?: string;
    sessionId?: string;
    sensitivity: 'normal' | 'private' | 'secret';
  };
  kind: string;
  payloadRef: string;
  contentHash: string;
  trust: 'user_explicit' | 'tool_observed' | 'agent_reported' | 'imported';
};

type NormalizedBatch = {
  events: readonly EventEnvelope[];
  payloads: Readonly<Record<string, unknown>>;
};

type IngestResult = { durableCursor: string; inserted: number; duplicates: number };

type TimelineItem = {
  id: string;
  kind: string;
  summary: string;
  sourceEventIds: readonly string[];
  occurredAt: string;
  trust?: string;
  status?: string;
};

type MemoryStore = {
  ingest(batch: NormalizedBatch, options?: { onBeforeCommit?: () => void }): Promise<IngestResult>;
  timeline(query: { projectId: string; text?: string }): Promise<TimelineItem[]>;
  durableCursor(): Promise<string>;
  close(): Promise<void>;
};

type MemoryModule = {
  createMemoryStore(options: { directory: string; key: string; profileId: string }): Promise<MemoryStore>;
};

type BasicFixture = {
  contractVersion: number;
  profileId: string;
  events: EventEnvelope[];
  payloads: Record<string, unknown>;
};

/** Loads the yet-to-be-implemented store, turning "module missing" into a named failure. */
async function loadMemoryModule(): Promise<MemoryModule> {
  let loaded: Record<string, unknown>;
  try {
    loaded = (await import('./index.js')) as unknown as Record<string, unknown>;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ERR_MODULE_NOT_FOUND' || /Cannot find (module|package)/.test(String((error as Error).message))) {
      assert.fail(
        'Missing required behavior: packages/memory/src/store/index.ts must export '
        + 'createMemoryStore({ directory, key, profileId }) with ingest(), timeline(), durableCursor(), and close().',
      );
    }
    throw error;
  }
  assert.equal(
    typeof loaded.createMemoryStore,
    'function',
    'packages/memory/src/store must export createMemoryStore({ directory, key, profileId })',
  );
  return loaded as unknown as MemoryModule;
}

async function loadBasicFixture(): Promise<BasicFixture> {
  const raw = JSON.parse(await readFile(FIXTURE_URL, 'utf8')) as BasicFixture;
  assert.equal(raw.contractVersion, 1, 'the checked-in fixture uses the v1 normalized-event contract');
  assert.equal(raw.profileId, PROFILE_ID, 'the fixture profile must match the store profile under test');
  assert.ok(raw.events.length > 0, 'the fixture must contain normalized events');
  const serialized = JSON.stringify(raw);
  assert.ok(serialized.includes(ALPHA_CANARY) && serialized.includes(BETA_CANARY), 'the fixture must carry both canaries');
  const payloadRefs = raw.events.map((event) => event.payloadRef);
  assert.equal(new Set(payloadRefs).size, payloadRefs.length, 'every event needs a distinct payloadRef');
  for (const ref of payloadRefs) assert.ok(ref in raw.payloads, `fixture payload ${ref} is missing`);
  return raw;
}

async function openStore(memory: MemoryModule, directory: string, key = STORE_KEY): Promise<MemoryStore> {
  return memory.createMemoryStore({ directory, key, profileId: PROFILE_ID });
}

/** Reads every durable file the store keeps (database, WAL/SHM, any FTS or sidecar files). */
async function readStoreFiles(directory: string): Promise<Array<{ path: string; bytes: Buffer }>> {
  const files: Array<{ path: string; bytes: Buffer }> = [];
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) files.push({ path: full, bytes: await readFile(full) });
    }
  }
  await walk(directory);
  return files;
}

async function assertNoPlaintextCanary(directory: string, label: string): Promise<void> {
  const files = await readStoreFiles(directory);
  assert.ok(files.length > 0, `${label}: the store must keep durable files inside its directory`);
  assert.ok(files.some((file) => file.bytes.length > 0), `${label}: the store must write non-empty durable files`);
  for (const file of files) {
    for (const canary of [ALPHA_CANARY, BETA_CANARY]) {
      for (const encoding of ['utf8', 'utf16le'] as const) {
        assert.equal(
          file.bytes.includes(Buffer.from(canary, encoding)),
          false,
          `${label}: plaintext canary ${canary} (${encoding}) leaked into ${file.path}`,
        );
      }
    }
  }
}

/** Synthetic events that only exist to be lost to a simulated crash before COMMIT. */
function crashBatch(): NormalizedBatch {
  const base = {
    schemaVersion: 1 as const,
    sourceId: 'source-alpha',
    scope: {
      profileId: PROFILE_ID,
      projectId: PROJECT_ALPHA,
      worktreeId: 'worktree-alpha-main',
      sessionId: 'session-alpha-1',
      sensitivity: 'normal' as const,
    },
    observedAt: '2026-09-10T10:00:01.000Z',
  };
  return {
    events: [
      {
        ...base,
        eventId: 'evt-alpha-crash-100',
        sourceEventId: 'alpha-0100',
        sourceSequence: 100,
        ingestSequence: 100,
        occurredAt: '2026-09-10T10:00:00.000Z',
        kind: 'user_utterance',
        payloadRef: 'fixture://alpha/crash-0100',
        contentHash: 'sha256:alpha-0100',
        trust: 'user_explicit',
      },
      {
        ...base,
        eventId: 'evt-alpha-crash-101',
        sourceEventId: 'alpha-0101',
        sourceSequence: 101,
        ingestSequence: 101,
        occurredAt: '2026-09-10T10:00:30.000Z',
        kind: 'decision',
        payloadRef: 'fixture://alpha/crash-0101',
        contentHash: 'sha256:alpha-0101',
        trust: 'user_explicit',
      },
    ],
    payloads: {
      'fixture://alpha/crash-0100': {
        text: `A crash before commit must lose this user utterance; canary ${CRASH_CANARY} must not survive a rollback.`,
      },
      'fixture://alpha/crash-0101': {
        question: 'Does a crashed ingest leave partial records?',
        choice: 'No - rollback leaves no records behind.',
        decidingActor: 'user',
      },
    },
  };
}

test('events, task status, and a user decision survive restart with source links and project isolation', async () => {
  const memory = await loadMemoryModule();
  const fixture = await loadBasicFixture();
  const batch: NormalizedBatch = { events: fixture.events, payloads: fixture.payloads };
  const directory = await mkdtemp(join(tmpdir(), 'echopilot-m01-restart-'));
  try {
    const before = await openStore(memory, directory);
    const ingested = await before.ingest(batch);
    assert.equal(ingested.inserted, batch.events.length, 'every normalized event must be inserted once');
    assert.equal(ingested.duplicates, 0, 'a first ingest has no duplicates');
    const alphaBeforeRestart = await before.timeline({ projectId: PROJECT_ALPHA });
    await before.close();

    const after = await openStore(memory, directory);
    try {
      const alpha = await after.timeline({ projectId: PROJECT_ALPHA });
      assert.deepEqual(
        alpha,
        alphaBeforeRestart,
        'the timeline must be deterministic and survive a restart with identical ids and summaries',
      );
      assert.ok(alpha.length >= 5, 'the restarted timeline must return the ingested events plus derived records');
      for (let index = 1; index < alpha.length; index += 1) {
        assert.ok(
          Date.parse(alpha[index - 1]!.occurredAt) <= Date.parse(alpha[index]!.occurredAt),
          'timeline items must be ordered by occurredAt ascending',
        );
      }

      const decision = alpha.find((item) => item.kind === 'decision');
      assert.ok(decision, 'the user decision must survive the restart');
      assert.equal(decision.id, 'evt-alpha-decision-005', 'a source capsule is keyed by its event id');
      assert.deepEqual([...decision.sourceEventIds], ['evt-alpha-decision-005'], 'the decision must link its source event');
      assert.equal(decision.trust, 'user_explicit', 'a user decision stays user-explicit evidence');
      assert.ok(decision.summary.includes(ALPHA_CANARY), 'the decision text must be readable after the restart');

      const task = alpha.find((item) => item.kind === 'task');
      assert.ok(task, 'the deterministic task record must survive the restart');
      assert.equal(task.id, 'task-alpha-tests', 'task items are keyed by the external task id from the tool payload');
      assert.equal(task.status, 'failed', 'a failed tool receipt must never be upgraded by a later agent claim');
      assert.ok(
        task.sourceEventIds.includes('evt-alpha-tool-complete-003'),
        'the task status must link the tool receipt that produced it',
      );

      const agentClaim = alpha.find((item) => item.id === 'evt-alpha-agent-claim-004');
      assert.ok(agentClaim, 'the raw agent message must remain a source capsule');
      assert.match(agentClaim.summary, /passed/i, 'source capsules keep the original claim for provenance');

      const searchHits = await after.timeline({ projectId: PROJECT_ALPHA, text: ALPHA_CANARY });
      assert.ok(
        searchHits.some((item) => item.sourceEventIds.includes('evt-alpha-decision-005')),
        'a lexical timeline query must find the decision and link its source event',
      );

      const beta = await after.timeline({ projectId: PROJECT_BETA });
      assert.ok(beta.length > 0, 'project beta must expose its own records');
      assert.ok(
        alpha.every((item) => item.sourceEventIds.every((id) => !id.startsWith('evt-beta-'))),
        'project alpha must never return project beta records',
      );
      assert.ok(
        beta.every((item) => item.sourceEventIds.every((id) => !id.startsWith('evt-alpha-'))),
        'project beta must never return project alpha records',
      );
      assert.equal(JSON.stringify(alpha).includes(BETA_CANARY), false, 'beta content must not leak into alpha');
      assert.equal(JSON.stringify(beta).includes(ALPHA_CANARY), false, 'alpha content must not leak into beta');

      const betaTask = beta.find((item) => item.kind === 'task');
      assert.equal(betaTask?.status, 'passed', 'a zero exit code reduces to a passed task');
      const betaDecision = beta.find((item) => item.kind === 'decision');
      assert.ok(betaDecision?.summary.includes(BETA_CANARY), 'the beta decision must be readable after the restart');

      assert.deepEqual(
        await after.timeline({ projectId: PROJECT_BETA, text: ALPHA_CANARY }),
        [],
        'a project query must not match another project records',
      );
    } finally {
      await after.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('no durable store file exposes a plaintext canary and a wrong key cannot open the database', async () => {
  const memory = await loadMemoryModule();
  const fixture = await loadBasicFixture();
  const batch: NormalizedBatch = { events: fixture.events, payloads: fixture.payloads };
  const directory = await mkdtemp(join(tmpdir(), 'echopilot-m01-encryption-'));
  const clone = await mkdtemp(join(tmpdir(), 'echopilot-m01-clone-'));
  try {
    const store = await openStore(memory, directory);
    await store.ingest(batch);
    // While the store is open the database, WAL, and any index files are all present on disk.
    await assertNoPlaintextCanary(directory, 'live store');
    await store.close();

    // A byte copy of the directory is the complete durable store: it still answers the query.
    await cp(directory, clone, { recursive: true });
    const cloned = await openStore(memory, clone);
    const alphaHits = await cloned.timeline({ projectId: PROJECT_ALPHA, text: ALPHA_CANARY });
    assert.ok(
      alphaHits.some((item) => item.sourceEventIds.includes('evt-alpha-decision-005')),
      'the copied directory must contain the complete durable store',
    );
    const betaHits = await cloned.timeline({ projectId: PROJECT_BETA, text: BETA_CANARY });
    assert.ok(betaHits.length > 0, 'both canaries must be genuinely stored and searchable');
    await cloned.close();

    await assertNoPlaintextCanary(clone, 'closed store');

    await assert.rejects(
      openStore(memory, clone, WRONG_KEY),
      (error: unknown) => error instanceof Error,
      'a wrong key must not open an existing encrypted store',
    );

    const reopened = await openStore(memory, clone);
    const afterWrongKey = await reopened.timeline({ projectId: PROJECT_ALPHA, text: ALPHA_CANARY });
    assert.ok(afterWrongKey.length > 0, 'a wrong-key attempt must not destroy or reset the encrypted store');
    await reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(clone, { recursive: true, force: true });
  }
});

test('duplicate ingestion is idempotent and a crash before commit does not advance the durable cursor', async () => {
  const memory = await loadMemoryModule();
  const fixture = await loadBasicFixture();
  const batch: NormalizedBatch = { events: fixture.events, payloads: fixture.payloads };
  const directory = await mkdtemp(join(tmpdir(), 'echopilot-m01-idempotency-'));
  try {
    const store = await openStore(memory, directory);
    const first = await store.ingest(batch);
    assert.equal(first.inserted, batch.events.length);
    assert.equal(first.inserted + first.duplicates, batch.events.length, 'every ingested event is inserted or a duplicate');
    assert.ok(first.durableCursor.length > 0, 'ingestion must return a durable cursor');
    assert.equal(await store.durableCursor(), first.durableCursor, 'the durable cursor must be readable while open');

    const duplicate = await store.ingest(batch);
    assert.equal(duplicate.inserted, 0, 'replaying a committed batch must insert nothing');
    assert.equal(duplicate.duplicates, batch.events.length, 'every replayed event must be reported as a duplicate');
    assert.equal(duplicate.durableCursor, first.durableCursor, 'a duplicate batch must not advance the durable cursor');
    const replayedTimeline = await store.timeline({ projectId: PROJECT_ALPHA });
    assert.equal(replayedTimeline.filter((item) => item.kind === 'decision').length, 1, 'the decision must not be duplicated');
    assert.equal(replayedTimeline.filter((item) => item.kind === 'task').length, 1, 'the task must not be duplicated');

    const crashing = crashBatch();
    const cursorBeforeCrash = await store.durableCursor();
    await assert.rejects(
      store.ingest(crashing, {
        onBeforeCommit: () => {
          throw new Error('simulated crash before commit');
        },
      }),
      (error: unknown) => error instanceof Error,
      'a crash before COMMIT must abort the ingest',
    );
    assert.equal(
      await store.durableCursor(),
      cursorBeforeCrash,
      'a failed transaction must not advance the durable cursor',
    );
    assert.deepEqual(
      await store.timeline({ projectId: PROJECT_ALPHA, text: CRASH_CANARY }),
      [],
      'a failed transaction must leave no partial records behind',
    );
    await store.close();

    const reopened = await openStore(memory, directory);
    try {
      assert.equal(
        await reopened.durableCursor(),
        cursorBeforeCrash,
        'the durable cursor must survive the crash and restart unchanged',
      );
      const replayAfterRestart = await reopened.ingest(batch);
      assert.equal(replayAfterRestart.inserted, 0, 'idempotency must survive a restart');
      assert.equal(replayAfterRestart.duplicates, batch.events.length);
      assert.equal(replayAfterRestart.durableCursor, cursorBeforeCrash);
      assert.deepEqual(await reopened.timeline({ projectId: PROJECT_ALPHA, text: CRASH_CANARY }), []);

      const retry = await reopened.ingest(crashing);
      assert.equal(
        retry.inserted,
        crashing.events.length,
        'the crashed batch must ingest cleanly on retry, proving rollback left no partial rows',
      );
      assert.equal(retry.duplicates, 0, 'rolled-back events count as new on retry');
      assert.notEqual(retry.durableCursor, cursorBeforeCrash, 'a committed retry must advance the durable cursor');
      const recovered = await reopened.timeline({ projectId: PROJECT_ALPHA, text: CRASH_CANARY });
      assert.ok(
        recovered.some((item) => item.sourceEventIds.includes('evt-alpha-crash-100')),
        'the retried events must be readable with their source links',
      );
    } finally {
      await reopened.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
