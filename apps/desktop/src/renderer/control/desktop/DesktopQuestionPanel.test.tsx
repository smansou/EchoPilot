/**
 * Focused tests for the Mission Control → Desktop question panel (the focusable window). A fake
 * client is injected so each state is rendered deterministically without effects: the page must
 * explain the foreground-then-widget-then-review flow, show the exact returned prompt before any
 * send, and disclose that answers are model-generated and unverified.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { DesktopQuestionPanel } from './DesktopQuestionPanel';
import type {
  DesktopQuestionAnswer,
  DesktopQuestionClient,
  DesktopQuestionPreview,
  DesktopQuestionSource,
  DesktopQuestionState,
} from './desktop-question-client';

const PROJECT_ID = 'project-atlas';
const OBSERVED_AT = 1_759_000_000_000;
const NOW = OBSERVED_AT + 30_000;
const EXPIRES_AT = OBSERVED_AT + 300_000;
const noop = () => {};

function source(): DesktopQuestionSource {
  return {
    rows: [{ number: 1, evidenceId: 'desk:ax:0', role: 'AXStaticText', label: 'Retry budget', value: '5', truncated: false }],
    omittedRows: 0,
    application: { name: 'TextEdit', bundleId: 'com.apple.TextEdit', pid: 501, identityTruncated: false },
    window: { role: 'AXWindow', title: 'Untitled', titleTruncated: false },
    quality: 'full',
    truncated: false,
    truncations: [],
    observedAtMs: OBSERVED_AT,
  };
}

function preview(): DesktopQuestionPreview {
  return {
    confirmationId: 'confirmation-1',
    projectId: PROJECT_ID,
    snapshotId: 'snapshot-1',
    question: 'What is the retry budget?',
    prompt: '[1] AXStaticText Retry budget — 5',
    evidence: source(),
    providerId: 'openai',
    model: 'gpt-6-luna',
    expiresAtMs: EXPIRES_AT,
  };
}

function answer(): DesktopQuestionAnswer {
  return {
    answer: 'The retry budget is five [1].',
    answerKind: 'model_generated',
    citationsVerified: false,
    model: 'gpt-6-luna',
    inputTokens: null,
    outputTokens: null,
    estimatedUsd: null,
    snapshotId: 'snapshot-1',
    evidence: source(),
  };
}

function baseState(overrides: Partial<DesktopQuestionState> = {}): DesktopQuestionState {
  return {
    context: {
      kind: 'ready',
      projectId: PROJECT_ID,
      projectLabel: 'Atlas',
      snapshot: { snapshotId: 'snapshot-1', observedAtMs: OBSERVED_AT, expiresAtMs: EXPIRES_AT },
    },
    question: '',
    phase: 'idle',
    preview: null,
    answer: null,
    error: null,
    ...overrides,
  };
}

function fakeClient(state: DesktopQuestionState): DesktopQuestionClient {
  return {
    getSnapshot: () => state,
    subscribe: () => () => {},
    loadContext: async () => {},
    setQuestion: noop,
    preview: async () => {},
    confirm: async () => {},
    cancelPreview: async () => {},
    dispose: noop,
  };
}

function render(state: DesktopQuestionState): string {
  return renderToStaticMarkup(
    <DesktopQuestionPanel client={fakeClient(state)} onOpenWork={noop} now={() => NOW} />,
  );
}

test('the panel always explains the foreground target, the widget inspection, and the review step', () => {
  const markup = render(baseState());
  assert.match(markup, /Ask about the latest snapshot/);
  assert.match(markup, /Bring the app you want to ask about to the foreground/);
  assert.match(markup, /Inspect window/);
  assert.match(markup, /Opening or refreshing this page never captures anything/);
  assert.match(markup, /Send this evidence to OpenAI&quot; below reaches the API/);
  assert.match(markup, /The widget only reads; asking happens here in Mission Control/);
  assert.match(markup, /snapshot from 30 seconds ago/);
  assert.match(markup, /expires in about 5 minutes/);
  assert.match(markup, /Refresh context/);
  assert.match(markup, /maxLength="1000"/, 'the question is bounded before it is sent anywhere');
  assert.ok(!/<button[^>]*>Send this evidence to OpenAI<\/button>/.test(markup), 'no send control exists before a preview');
});

test('Preview stays disabled for an empty question or a missing snapshot', () => {
  const emptyQuestion = render(baseState());
  assert.match(emptyQuestion, /<button[^>]*disabled=""[^>]*>Preview<\/button>/);

  const noSnapshot = render(baseState({
    context: { kind: 'ready', projectId: PROJECT_ID, projectLabel: 'Atlas', snapshot: null },
    question: 'What is the retry budget?',
  }));
  assert.match(noSnapshot, /No recent local snapshot for Atlas/);
  assert.match(noSnapshot, /Bring the target app to the foreground/);
  assert.match(noSnapshot, /<button[^>]*disabled=""[^>]*>Preview<\/button>/, 'without a snapshot there is nothing to preview');

  const ready = render(baseState({ question: 'What is the retry budget?' }));
  assert.match(ready, />Preview<\/button>/);
  assert.ok(!/<button[^>]*disabled=""[^>]*>Preview<\/button>/.test(ready), 'a snapshot plus a question enables Preview');
});

test('a preview discloses the exact prompt, provider, model, source age, and expiry before any send', () => {
  const markup = render(baseState({ preview: preview() }));
  assert.match(markup, /REVIEW BEFORE SENDING/);
  assert.match(markup, /This is the exact prompt and evidence that would be sent to OpenAI\. Reviewing it sends nothing\./);
  assert.match(markup, /OpenAI · gpt-6-luna/);
  assert.match(markup, /\[1\] AXStaticText Retry budget — 5/);
  assert.match(markup, /desk:ax:0/);
  assert.match(markup, /label: Retry budget/);
  assert.match(markup, /value: 5/);
  assert.match(markup, /Send this evidence to OpenAI/);
  assert.match(markup, />Cancel<\/button>/);
  assert.match(markup, /one-time permission grant for this exact evidence/);
  assert.ok(!markup.includes('Your question about this snapshot'), 'the question form is replaced by its preview');
});

test('confirming shows a busy send control and no second send path', () => {
  const markup = render(baseState({ preview: preview(), phase: 'confirming' }));
  assert.match(markup, /Sending the previewed evidence…/);
  assert.match(markup, /aria-busy="true"/);
  assert.ok(!markup.includes('>Send this evidence to OpenAI</button>'));
});

test('an answer is labelled model-generated with unverified citations and honest unknown usage', () => {
  const markup = render(baseState({ phase: 'answered', answer: answer() }));
  assert.match(markup, /MODEL-GENERATED ANSWER · gpt-6-luna/);
  assert.match(markup, /The retry budget is five \[1\]\./);
  assert.match(markup, /citations were not verified against the snapshot/);
  assert.match(markup, /No screenshot or OCR was used/);
  assert.match(markup, /Token usage was not reported, so it stays unknown — not zero/);
  assert.match(markup, /Cost is not estimated for this path/);
  assert.ok(!markup.includes('$0'), 'an unknown cost is never shown as a dollar figure');
});

test('a consumed or failed preview is honest that a new preview is required', () => {
  const markup = render(baseState({
    error: { code: 'busy', message: 'Another desktop answer is already running. Wait for it to finish, then review a fresh preview.', requiresNewPreview: true },
    question: 'What is the retry budget?',
  }));
  assert.match(markup, /Another desktop answer is already running/);
  assert.match(markup, /The preview is used up, so retry with a new preview\./);
  assert.match(markup, /role="alert"/);
});

test('an empty or ambiguous scope points at Work and offers no question form', () => {
  const blocked = render(baseState({
    context: { kind: 'blocked', activeProjects: 0, options: [] },
  }));
  assert.match(blocked, /No active Work project/);
  assert.match(blocked, /Open Work ↗/);
  assert.ok(!blocked.includes('textarea'), 'a blocked scope never offers a question box');

  const ambiguous = render(baseState({
    context: { kind: 'blocked', activeProjects: 2, options: [{ projectId: PROJECT_ID, label: 'Atlas' }, { projectId: 'project-borealis', label: 'Borealis' }] },
  }));
  assert.match(ambiguous, /2 projects are active/);
  assert.match(ambiguous, /remembered selection/);
});

test('helper or transport unavailability is shown with a retry that only re-reads context', () => {
  const unavailable = render(baseState({
    context: { kind: 'unavailable', message: 'Work session status is unavailable, so no active project can be confirmed and nothing was observed.' },
  }));
  assert.match(unavailable, /Work session status is unavailable/);
  assert.match(unavailable, />Try again<\/button>/);
  assert.ok(!unavailable.includes('textarea'));

  const malformed = render(baseState({
    context: { kind: 'error', message: 'desktop-answer-context: snapshotId is invalid' },
  }));
  assert.match(malformed, /desktop-answer-context: snapshotId is invalid/);
  assert.match(malformed, />Try again<\/button>/);
});
