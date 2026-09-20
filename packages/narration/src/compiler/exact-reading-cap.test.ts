/**
 * N02 regression guard — an explicit exact-reading request is never dropped.
 *
 * The ordinary chapters obey the anti-redraw cap of six logical updates, so a run that fills every
 * chapter used to leave no room for the verbatim chapters the user explicitly asked for. This test
 * builds that saturated run from normalized §5.3 envelopes plus their payloads only (outcome,
 * problems, progress, decisions, changes, details) and fails loudly if the request is swallowed
 * again instead of being spoken in bounded exact segments.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { EventEnvelope } from '../../../contracts/src/index.js';
import { compileNarration } from './index.js';

const SCOPE = { profileId: 'profile-n02', sensitivity: 'normal' } as const;

function envelope(
  index: number,
  kind: EventEnvelope['kind'],
  payloadRef: string,
  unsupportedKind?: string,
): EventEnvelope {
  const base: EventEnvelope = {
    schemaVersion: 1,
    eventId: `event-${String(index).padStart(2, '0')}`,
    sourceId: 'source-n02',
    sourceEventId: `source-event-${index}`,
    sourceSequence: index,
    ingestSequence: index,
    occurredAt: '2026-09-14T06:00:00.000Z',
    observedAt: '2026-09-14T06:00:00.000Z',
    scope: SCOPE,
    kind,
    payloadRef,
    contentHash: `hash-${index}`,
    trust: 'tool_observed',
  };
  return unsupportedKind === undefined ? base : { ...base, unsupportedKind };
}

const EVENTS: ReadonlyArray<EventEnvelope> = [
  envelope(1, 'tool_completed', 'payload-receipt'),
  envelope(2, 'unsupported', 'payload-failure', 'log_line'),
  envelope(3, 'unsupported', 'payload-redraw', 'log_line'),
  envelope(4, 'decision', 'payload-decision'),
  envelope(5, 'artifact_changed', 'payload-artifact'),
  envelope(6, 'unsupported', 'payload-verification', 'log_line'),
];

const PAYLOADS: Readonly<Record<string, unknown>> = {
  'payload-receipt': {
    taskId: 'task-n02',
    command: 'pnpm test --filter narration',
    receiptId: 'receipt-1',
    output: '',
    exitCode: 0,
  },
  'payload-failure': { stream: 'stderr', line: 'N02-LOG checks FAILED: 3 of 12 failed' },
  'payload-redraw': { stream: 'stdout', line: 'N02-REDRAW progress [=====>    ] 45%' },
  'payload-decision': {
    summary: 'Keep the verifier offline and deterministic',
    rationale: 'The frozen corpus is the oracle',
  },
  'payload-artifact': { path: 'packages/narration/src/compiler/index.ts', change: 'modified' },
  'payload-verification': { stream: 'stdout', line: 'N02-LOG all checks passed, summary complete' },
};

const RUN = {
  runId: 'run-n02-saturated',
  sessionId: 'session-n02',
  taskId: 'task-n02',
  events: EVENTS,
  payloads: PAYLOADS,
} as const;

test('N02: an exact reading survives a run that fills all six ordinary chapters', () => {
  const ordinary = compileNarration({ run: RUN, verbosity: 'thorough', exactReading: null });
  assert.equal(ordinary.chapters.length, 6, 'the fixture must saturate the ordinary chapter cap');
  for (const chapter of ordinary.chapters) {
    assert.ok(chapter.segments.every((segment) => segment.exact === false), 'ordinary chapters stay exact-free');
  }

  const request = 'Read the failing line exactly: N02-LOG checks FAILED: 3 of 12 failed';
  const compiled = compileNarration({ run: RUN, verbosity: 'thorough', exactReading: { text: request } });
  const exactSegments = compiled.chapters.flatMap((chapter) => chapter.segments).filter((segment) => segment.exact);
  assert.ok(exactSegments.length > 0, 'the explicit exact reading must never be dropped');
  assert.equal(
    exactSegments.map((segment) => segment.text.trim()).join(' '),
    request.replace(/\s+/gu, ' ').trim(),
    'the exact reading must stay verbatim',
  );
  for (const segment of exactSegments) {
    assert.ok(segment.maxSeconds > 0 && segment.maxSeconds <= 40, 'exact segments stay inside the 40 second budget');
    assert.ok(segment.claimIds.length > 0 && segment.evidenceIds.length > 0, 'exact segments stay cited');
  }
  const ordinaryChapters = compiled.chapters.filter((chapter) => chapter.segments.every((segment) => !segment.exact));
  assert.equal(ordinaryChapters.length, 6, 'the ordinary chapters must survive beside the exact reading');
});
