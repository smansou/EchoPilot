/**
 * C01 widget wiring evidence: the production renderer path for desktop "what is this?".
 *
 * The frozen oracle (`packages/desktop-tools/src/context/c01.acceptance.test.ts`) pins the service
 * seam. This file pins the half the finding was about: the widget conversation itself. It drives
 * `createWidgetDesktopRuntime` — the module `main.tsx` renders through `DesktopQuestionWidget` —
 * with the same deterministic fixture corpus, and renders the panel those answers reach, so a user
 * asking a browser-error or IDE-control question in the widget is answered without Mission Control,
 * an excluded app is refused before capture, and missing Accessibility yields the limited-context
 * sentence instead of invented control state.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  Attention,
  BoundedContext,
  EvidenceBundle,
  Memory,
  Reasoner,
  ReasoningTask,
  Scope,
  SpeechLease,
  SpeechPlan,
  VoiceOutputEvent,
} from '../../../../../packages/contracts/src/index.js';
import type {
  DesktopBridge,
  ForegroundApp,
} from '../../../../../packages/desktop-tools/src/context/index.js';
import { DesktopAnswerPanel } from './DesktopAnswerPanel';
import { DesktopQuestionWidget } from './DesktopQuestionWidget';
import type { DesktopAnswer } from './desktop-answer';
import {
  createWidgetAttention,
  createWidgetDesktopRuntime,
  createWidgetVoice,
  UNCONNECTED_CONTEXT_TEMPLATE,
  type DesktopContextHost,
  type DesktopVoice,
} from './desktop-runtime';

const FIXTURE_URL = new URL('../../../../../fixtures/desktop/questions/c01-questions.json', import.meta.url);
const NOW = '2026-09-21T10:00:00.000Z';
const MAX_LEASE_MS = 30_000;
const BROWSER_EVIDENCE = ['desk:ax:0', 'desk:ax:1', 'desk:ocr:0', 'mem-atlas-1'];
const IDE_EVIDENCE = ['desk:ax:0', 'desk:ax:1', 'mem-atlas-2'];

type FixtureAxNode = Readonly<{ role: string; value: string }>;
type FixtureOcrSpan = Readonly<{ text: string }>;
type FixtureCaptureOutcome =
  | Readonly<{
      status: 'captured';
      snapshot: Readonly<{
        snapshotId: string;
        capturedAtMs: number;
        screenshotRef: string | null;
        quality: 'full' | 'partial' | 'unavailable';
        truncated: boolean;
        axNodes: ReadonlyArray<FixtureAxNode>;
        ocrSpans: ReadonlyArray<FixtureOcrSpan>;
      }>;
    }>
  | Readonly<{ status: 'unavailable'; reason: 'accessibility_denied' | 'screen_recording_denied' | 'no_window' }>;
type FixtureMemoryEntry = Readonly<{ id: string; projectId: string; text: string }>;
type FixtureScenario = Readonly<{
  key: string;
  question: string;
  app: Readonly<{ bundleId: string; name: string; windowTitle: string }>;
  captureMustNeverBeRequested?: true;
  leakMarker?: string;
  capture: FixtureCaptureOutcome;
  memory: Readonly<{
    explicitProject: ReadonlyArray<FixtureMemoryEntry>;
    otherProjects: ReadonlyArray<FixtureMemoryEntry>;
  }>;
  reasoner: Readonly<{ answer: string; inventedEvidenceIds: ReadonlyArray<string> }> | null;
}>;
type Fixture = Readonly<{
  profileId: string;
  project: Readonly<{ projectId: string; displayName: string }>;
  excludedBundleIds: ReadonlyArray<string>;
  forbiddenControlStateWords: ReadonlyArray<string>;
  excludedTemplate: string;
  limitedTemplates: Readonly<Record<string, string>>;
  scenarios: ReadonlyArray<FixtureScenario>;
}>;

const fixture = JSON.parse(await readFile(FIXTURE_URL, 'utf8')) as Fixture;

function scenarioByKey(key: string): FixtureScenario {
  const found = fixture.scenarios.find((entry) => entry.key === key);
  assert.ok(found, `fixture is missing scenario ${key}`);
  return found;
}

function renderTemplate(template: string, app: string): string {
  return template.replaceAll('{app}', app);
}

function sorted(ids: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...ids].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/** React escapes text children; decode so rendered answers can be compared with answer text. */
function decoded(markup: string): string {
  return markup
    .replaceAll('&#x27;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function tokenize(text: string): ReadonlySet<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 3));
}

function overlaps(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  for (const token of left) if (right.has(token)) return true;
  return false;
}

type MemoryQuery = Readonly<{ search: string; scope: Scope; budget: number }>;
type FakeMemory = Memory & Readonly<{ queries: Array<MemoryQuery> }>;

function fakeMemory(entries: ReadonlyArray<FixtureMemoryEntry>): FakeMemory {
  const queries: Array<MemoryQuery> = [];
  return {
    queries,
    async ingest(): Promise<never> {
      throw new Error('C01 widget: memory.ingest is not part of the desktop question path');
    },
    async query(search: string, scope: Scope, budget: number): Promise<EvidenceBundle> {
      queries.push({ search, scope, budget });
      const searchTokens = tokenize(search);
      const matches = entries
        .filter((entry) => (scope.projectId === undefined ? true : entry.projectId === scope.projectId))
        .filter((entry) => overlaps(tokenize(entry.text), searchTokens));
      const selected = matches.slice(0, Math.max(0, budget));
      return {
        evidenceIds: selected.map((entry) => entry.id),
        summary: selected.map((entry) => entry.text).join(' '),
      };
    },
    async consolidate(): Promise<never> {
      throw new Error('C01 widget: memory.consolidate is not part of the desktop question path');
    },
    async forget(): Promise<never> {
      throw new Error('C01 widget: memory.forget is not part of the desktop question path');
    },
  };
}

type ReasonerCall = Readonly<{
  task: ReasoningTask;
  context: BoundedContext;
  outputSchema: Readonly<Record<string, unknown>>;
  signal: AbortSignal;
}>;
type FakeReasoner = Reasoner & Readonly<{ calls: Array<ReasonerCall> }>;

function fakeReasoner(scenario: FixtureScenario): FakeReasoner {
  const calls: Array<ReasonerCall> = [];
  return {
    calls,
    async run(
      task: ReasoningTask,
      context: BoundedContext,
      outputSchema: Readonly<Record<string, unknown>>,
      abortSignal: AbortSignal,
    ): Promise<unknown> {
      calls.push({ task, context, outputSchema, signal: abortSignal });
      const script = scenario.reasoner;
      if (script === null) throw new Error(`C01 widget: scenario ${scenario.key} must not reach the reasoner`);
      return { text: script.answer, evidenceIds: [...context.evidenceIds, ...script.inventedEvidenceIds] };
    },
  };
}

type VoiceSubmission = Readonly<{ plan: SpeechPlan; lease: SpeechLease; authorized: boolean }>;
type RecordingVoice = DesktopVoice & Readonly<{
  submissions: Array<VoiceSubmission>;
  audible: Array<string>;
}>;

/** Playback double: a plan without a live lease is recorded but never audible. */
function recordingVoice(attention: Attention): RecordingVoice {
  const submissions: Array<VoiceSubmission> = [];
  const audible: Array<string> = [];
  return {
    submissions,
    audible,
    async submitSpeech(plan: SpeechPlan, lease: SpeechLease): Promise<ReadonlyArray<VoiceOutputEvent>> {
      const authorized = attention.canSpeak(lease);
      submissions.push({ plan, lease, authorized });
      if (!authorized) return [];
      for (const segment of plan.segments) audible.push(segment.text);
      return plan.segments.map((segment) => ({
        planId: plan.planId,
        segmentId: segment.id,
        positionMs: 0,
        status: 'started' as const,
      }));
    },
  };
}

type BridgeCalls = { foreground: number; capture: Array<Readonly<{ app: ForegroundApp; question: string }>> };

type WidgetRun = Readonly<{
  scenario: FixtureScenario;
  host: DesktopContextHost;
  calls: BridgeCalls;
  memory: FakeMemory;
  reasoner: FakeReasoner;
  attention: Attention;
  voice: RecordingVoice;
}>;

function widgetRun(
  key: string,
  options: Readonly<{ muted?: boolean; attention?: Attention }> = {},
): WidgetRun {
  const scenario = scenarioByKey(key);
  const calls: BridgeCalls = { foreground: 0, capture: [] };
  const bridge: DesktopBridge = {
    async foregroundApp(): Promise<ForegroundApp> {
      calls.foreground += 1;
      return scenario.app;
    },
    async captureQuestionContext(request): Promise<FixtureCaptureOutcome> {
      calls.capture.push(request);
      return scenario.capture;
    },
  };
  const memory = fakeMemory([...scenario.memory.explicitProject, ...scenario.memory.otherProjects]);
  const reasoner = fakeReasoner(scenario);
  const attention = options.attention
    ?? createWidgetAttention(() => options.muted === true, () => new Date(NOW));
  const voice = recordingVoice(attention);
  const host: DesktopContextHost = {
    bridge,
    memory,
    reasoner,
    scope: { profileId: fixture.profileId, projectId: fixture.project.projectId, sensitivity: 'normal' },
    excludedBundleIds: fixture.excludedBundleIds,
    now: () => new Date(NOW),
    attention,
    voice,
  };
  return { scenario, host, calls, memory, reasoner, attention, voice };
}

function scriptedAnswer(scenario: FixtureScenario): Readonly<{ answer: string; inventedEvidenceIds: ReadonlyArray<string> }> {
  const script = scenario.reasoner;
  assert.ok(script, `scenario ${scenario.key} must script a reasoner answer`);
  return script;
}

function assertSpokenThroughLease(run: WidgetRun, answer: DesktopAnswer): void {
  assert.equal(answer.spoken, true, 'the widget answer is spoken when the companion is audible');
  assert.equal(run.voice.submissions.length, 1, 'the widget submits exactly one speech plan per answer');
  const submission = run.voice.submissions[0];
  assert.ok(submission, 'the voice submission must exist');
  assert.equal(submission.authorized, true, 'the widget only plays a live attention lease');
  assert.equal(run.voice.audible.join(' '), answer.text, 'the spoken plan carries exactly the answer text');
  const nowMs = Date.parse(NOW);
  const expiresMs = Date.parse(submission.lease.expiresAt);
  assert.ok(Number.isFinite(expiresMs) && expiresMs > nowMs, 'the widget lease is live');
  assert.ok(expiresMs - nowMs <= MAX_LEASE_MS, 'the widget lease lasts at most 30 s');
}

function assertNoControlStateWords(answer: DesktopAnswer): void {
  for (const word of fixture.forbiddenControlStateWords) {
    assert.ok(
      !new RegExp(`\\b${word}\\b`, 'i').test(answer.text),
      `a limited-context answer never asserts control state ("${word}")`,
    );
  }
}

test('C01 widget: a browser error is answered in the widget conversation without Mission Control', async () => {
  const run = widgetRun('browser-error');
  const runtime = createWidgetDesktopRuntime(run.host);
  assert.equal(runtime.connected, true);

  const answer = await runtime.ask(run.scenario.question);
  assert.equal(answer.surface, 'widget', 'the widget conversation is the surface, never Mission Control');
  assert.equal(answer.capture.state, 'captured');
  assert.equal(answer.capture.app, 'Google Chrome');
  assert.equal(answer.text, scriptedAnswer(run.scenario).answer);
  assert.deepEqual(sorted(answer.evidenceIds), sorted(BROWSER_EVIDENCE));
  assert.equal(run.calls.foreground, 1);
  assert.equal(run.calls.capture.length, 1);
  assert.equal(run.memory.queries.length, 1);
  assert.equal(run.memory.queries[0]?.scope.projectId, fixture.project.projectId, 'memory stays in-project');
  assert.equal(run.reasoner.calls.length, 1);
  assertSpokenThroughLease(run, answer);

  const markup = decoded(renderToStaticMarkup(<DesktopAnswerPanel answer={answer} busy={false} />));
  assert.ok(markup.includes(scriptedAnswer(run.scenario).answer), 'the panel renders the grounded answer');
  assert.ok(markup.includes('mem-atlas-1'), 'the panel renders the evidence the answer cites');
  assert.ok(markup.includes('Captured foreground window'), 'the panel reports the capture the answer carries');
});

test('C01 widget: an IDE control is answered from the AX labels in the same widget path', async () => {
  const run = widgetRun('ide-control');
  const answer = await createWidgetDesktopRuntime(run.host).ask(run.scenario.question);

  assert.equal(answer.surface, 'widget');
  assert.equal(answer.capture.state, 'captured');
  assert.equal(answer.capture.app, 'Visual Studio Code');
  assert.match(answer.text, /Run Without Debugging/);
  assert.deepEqual(sorted(answer.evidenceIds), sorted(IDE_EVIDENCE));
  assertSpokenThroughLease(run, answer);
});

test('C01 widget: an excluded app is refused before capture and never rendered', async () => {
  const run = widgetRun('excluded-app');
  const answer = await createWidgetDesktopRuntime(run.host).ask(run.scenario.question);

  assert.equal(run.scenario.captureMustNeverBeRequested, true);
  assert.equal(run.calls.capture.length, 0, 'the widget never asks the bridge for an excluded app');
  assert.equal(run.memory.queries.length, 0);
  assert.equal(run.reasoner.calls.length, 0);

  assert.equal(answer.capture.state, 'excluded');
  assert.equal(answer.text, renderTemplate(fixture.excludedTemplate, run.scenario.app.name));
  assert.deepEqual([...answer.evidenceIds], []);
  const leakMarker = run.scenario.leakMarker;
  assert.ok(leakMarker);
  assert.ok(!JSON.stringify(answer).includes(leakMarker), 'no excluded-app content ever reaches the widget');

  const markup = decoded(renderToStaticMarkup(<DesktopAnswerPanel answer={answer} busy={false} />));
  assert.ok(markup.includes('Excluded from capture'));
  assert.ok(!markup.includes(leakMarker), 'the rendered widget never shows the excluded app content');
});

test('C01 widget: missing Accessibility yields the limited sentence, not invented control state', async () => {
  const run = widgetRun('missing-accessibility');
  const answer = await createWidgetDesktopRuntime(run.host).ask(run.scenario.question);

  assert.equal(run.calls.capture.length, 1, 'the capture is attempted because the app is not excluded');
  assert.equal(run.reasoner.calls.length, 0, 'no inference runs without screen evidence');
  assert.equal(run.memory.queries.length, 0);
  assert.equal(answer.capture.state, 'limited');
  assert.equal(answer.capture.reason, 'accessibility_denied');
  assert.equal(answer.text, renderTemplate(fixture.limitedTemplates.accessibility_denied ?? '', run.scenario.app.name));
  assertNoControlStateWords(answer);
  assert.deepEqual([...answer.evidenceIds], []);

  const hallucination = scriptedAnswer(run.scenario);
  const markup = decoded(renderToStaticMarkup(<DesktopAnswerPanel answer={answer} busy={false} />));
  assert.ok(markup.includes('Limited context'), 'the indicator never presents a limited answer as a read');
  assert.ok(!markup.includes(hallucination.answer), 'the invented control state never reaches the widget');
  const renderedText = /<p class="desktop-answer-text">(.*?)<\/p>/s.exec(markup)?.[1] ?? '';
  assert.ok(
    !/\b(enabled|disabled)\b/i.test(renderedText),
    'the answer the widget renders asserts no control state for an unread screen',
  );
});

test('C01 widget: an unconnected runtime stays at limited context and never guesses', async () => {
  const runtime = createWidgetDesktopRuntime(null);
  assert.equal(runtime.connected, false);
  const answer = await runtime.ask('Why is this button disabled?');

  assert.equal(answer.surface, 'widget');
  assert.equal(answer.capture.state, 'limited');
  assert.equal(answer.capture.reason, 'no_window');
  assert.equal(answer.text, UNCONNECTED_CONTEXT_TEMPLATE);
  assert.deepEqual([...answer.evidenceIds], []);
  assert.equal(answer.spoken, false, 'an unconnected widget claims no audio');
  assertNoControlStateWords(answer);
});

test('C01 widget: the widget itself renders the question surface and no Mission Control path', () => {
  const run = widgetRun('browser-error');
  const connected = decoded(renderToStaticMarkup(<DesktopQuestionWidget host={run.host} muted={false} />));
  assert.ok(connected.includes('Ask about the window in front'), 'the widget shows the desktop question box');
  assert.ok(connected.includes('placeholder="What is this?"'));
  assert.ok(connected.includes('>Ask</button>'));
  assert.ok(!connected.includes('Mission Control'), 'asking never routes through Mission Control');

  const unconnected = decoded(renderToStaticMarkup(<DesktopQuestionWidget host={null} muted={false} />));
  assert.ok(
    unconnected.includes('Answers stay at limited context'),
    'an unconnected widget says so instead of implying it can read the screen',
  );
});

test('C01 widget: a muted companion silences the same answer without replacing it', async () => {
  const requests: Array<string> = [];
  const mutedAttention = createWidgetAttention(() => true, () => new Date(NOW));
  const observed: Attention = {
    requestSpeech(eventId, expiresAt) {
      requests.push(eventId);
      return mutedAttention.requestSpeech(eventId, expiresAt);
    },
    canSpeak: (lease) => mutedAttention.canSpeak(lease),
    revokeSpeech: (reason) => mutedAttention.revokeSpeech(reason),
  };
  const audible = widgetRun('ide-control');
  const muted = widgetRun('ide-control', { attention: observed });
  const [spokenAnswer, mutedAnswer] = await Promise.all([
    createWidgetDesktopRuntime(audible.host).ask(audible.scenario.question),
    createWidgetDesktopRuntime(muted.host).ask(muted.scenario.question),
  ]);

  assert.equal(spokenAnswer.spoken, true);
  assert.equal(mutedAnswer.spoken, false, 'a muted widget answer is visible-only');
  assert.equal(requests.length, 1, 'the widget asks attention exactly once per answer');
  assert.equal(muted.voice.submissions.length, 0, 'no plan is submitted without a lease');
  assert.equal(mutedAnswer.text, spokenAnswer.text, 'muting never replaces the answer text');
  assert.deepEqual(sorted(mutedAnswer.evidenceIds), sorted(spokenAnswer.evidenceIds));
});

test('C01 widget: voice speaks only under a live lease and never claims missing audio', async () => {
  const attention = createWidgetAttention(() => false, () => new Date(NOW));
  const spoken: Array<string> = [];
  const target = globalThis as { SpeechSynthesisUtterance?: unknown };
  const previousUtterance = target.SpeechSynthesisUtterance;
  target.SpeechSynthesisUtterance = class {
    readonly text: string;
    constructor(text: string) {
      this.text = text;
    }
  };
  try {
    const voice = createWidgetVoice(attention, {
      speak: (utterance) => spoken.push((utterance as { text: string }).text),
      cancel: () => undefined,
    });
    const plan: SpeechPlan = {
      planId: 'widget-voice-test',
      epoch: 1,
      priority: 'completion',
      expiresAt: new Date(Date.parse(NOW) + MAX_LEASE_MS).toISOString(),
      dedupeKey: 'widget-voice-test',
      segments: [{ id: 'widget-voice-test:1', text: 'Run Without Debugging starts the configuration.', evidenceIds: [], exact: false, maxSeconds: 3 }],
      resume: 'discard',
    };
    const expired: SpeechLease = { eventId: 'expired', epoch: 1, expiresAt: new Date(Date.parse(NOW) - 1).toISOString() };
    assert.deepEqual([...await voice.submitSpeech(plan, expired)], [], 'an expired lease never speaks');
    assert.deepEqual(spoken, []);

    const lease = attention.requestSpeech('widget-voice-test', plan.expiresAt);
    assert.ok(lease, 'an audible companion gets a lease');
    const events = await voice.submitSpeech(plan, lease);
    assert.equal(events.length, 1);
    assert.deepEqual(spoken, ['Run Without Debugging starts the configuration.']);

    const silent = createWidgetVoice(attention, undefined);
    await assert.rejects(
      () => silent.submitSpeech(plan, lease),
      /Speech synthesis is unavailable/,
      'no synthesizer means the answer stays visible-only instead of claiming audio',
    );
  } finally {
    if (previousUtterance === undefined) delete target.SpeechSynthesisUtterance;
    else target.SpeechSynthesisUtterance = previousUtterance;
  }
});
