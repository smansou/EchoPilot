/**
 * R03 acceptance oracle — conversational ambiguity, session switches, and permissions → correct
 * bounded dialogue (IMPLEMENTATION_PLAN.md §5.6 precedence 1–6, §5.7 auto-dispatch ≥0.95;
 * BACKLOG R03).
 *
 * Coverage map:
 *   R03-C1 all mode changes are visible/audible and stale pending-answer bindings expire.
 *   R03-C2 no corpus case routes a companion explanation or quoted instruction into an unintended
 *          agent session (fixtures/routing/adversarial/r03-adversarial-utterances.json).
 *   R03-C3a "stop all" is the precedence-1 emergency control in every mode; the report half of
 *          criterion 3 is pinned by packages/core/src/dialogue/r03.acceptance.test.ts.
 *
 * There is no implementation yet: this file pins the seam the ticket must provide in its owned
 * path. Every failure below is reported as missing R03 behavior, never as a broken import.
 *
 * `packages/routing/src/state/index.ts` must export:
 *
 *   PENDING_ANSWER_EXPIRY_MS = 30_000
 *     Plan §5.6 rule 4: "A pending companion question or confirmation binds the next answer to its
 *     request ID, with a 30-second expiry."
 *   AGENT_DIRECT_INACTIVITY_MS = 300_000
 *     Plan §5.6 rule 5: Agent Direct mode "lasts until switched, project changes, or five minutes
 *     of inactivity."
 *   DICTATION_END_PHRASE = 'finish dictation'
 *     Plan §5.6 rule 2 / A-F1: literal text "until 'finish dictation'".
 *   DICTATION_ESCAPE_PHRASE
 *     Plan §5.6 rule 2: "A literal escape phrase inserts the control words when desired." The
 *     implementation chooses the phrase; this oracle reads it from the module.
 *
 *   createRoutingState({ sessions, now? }) → RoutingState
 *     sessions — the active managed sessions, exactly createAddresseeRouter's ManagedSession shape.
 *     now      — () => Date (defaults to the system clock). Every expiry below is computed from
 *                this clock; the oracle drives all time with a fake clock.
 *
 *     RoutingState:
 *       setActiveSessions(sessions) — replaces the active session set.
 *       setProject(projectId)       — the current project; a change ends Agent Direct mode.
 *       mode()                      — the visible mode:
 *                                     { kind: 'companion' | 'agent_direct' | 'dictation',
 *                                       sessionId?, since }
 *       pending()                   — the pending-question queue, oldest first:
 *                                     { requestId, question, candidates, expiresAt }
 *       route({ utteranceId, text, asrConfidence?, partial? }) → RouteDecision plus extensions
 *         The contract fields keep their exact meaning; the routing package's documented
 *         extensions (hold, candidates) are unchanged. Additional R03 extensions:
 *           mode?           the visible mode after this turn (also available via mode()).
 *           modeChange?     { from, to, cue, visible }: this turn changed the mode. `cue` is the
 *                           audible cue text and is non-empty and names the mode; `visible` is the
 *                           widget label the user sees. A mode change is spoken even when the turn
 *                           is otherwise silent.
 *           pending?        { requestId, expiresAt }: this turn asked a companion question, which
 *                           binds the next answer; expiresAt = askedAt + PENDING_ANSWER_EXPIRY_MS.
 *           answer?         { requestId }: this turn is the answer bound to that pending question.
 *           expiredPending? request IDs dropped as stale before this utterance was routed.
 *           dictation?      { literal }: the verbatim text this turn dictates (dictation mode).
 *           control?        'stop_all' | 'stop_speaking' | 'pause' | 'mute' on a precedence-1
 *                           emergency control turn (destination 'control').
 *
 * Behavior pinned here (plan §5.6 precedence: 1 emergency controls, 2 dictation mode, 3 explicit
 * prefixes, 4 pending-answer binding, 5 Agent Direct mode, 6 classification/clarification):
 *
 *   - A turn whose only effect is entering or leaving a mode has destination 'control' and carries
 *     modeChange with a non-empty audible cue plus the visible mode. The visible mode is also kept
 *     on mode() and on the decision as mode.
 *   - "agent direct" (optionally "switch to"/"start"/"enter" and optionally naming a session)
 *     enters Agent Direct mode bound to that session. Ordinary instructions then route to it
 *     (destination 'harness', targetSessionId, basis 'active_mode', confidence ≥ 0.95); an
 *     explicit prefix still wins; a question beginning "Echo" stays local. "stop agent direct",
 *     a project change, and AGENT_DIRECT_INACTIVITY_MS of inactivity (measured from the last
 *     route() call) end the mode with a modeChange that carries the exit cue. An utterance routed
 *     at the moment the mode is found stale is still routed normally — it is not dispatched under
 *     the expired mode. The oracle only asserts that a mode idle for more than the five-minute
 *     window expires, so refreshing the idle clock on any route() call is equally acceptable.
 *   - "start dictation" enters dictation mode. Until "finish dictation", every utterance except a
 *     precedence-1 emergency control is literal: destination 'dictation', basis 'active_mode',
 *     dictation.literal equal to the utterance text verbatim, and the wake word and explicit
 *     prefixes are not parsed. DICTATION_ESCAPE_PHRASE is consumed and the words after it are
 *     dictated literally, so control words can be dictated. The end phrase is not dictated.
 *   - A turn that requires clarification registers a pending question (pending) with a 30-second
 *     expiry and dispatches nothing. The next answer-shaped utterance binds to the queue head
 *     (answer.requestId); a command-shaped utterance, explicit prefix, control, or mode change
 *     starts its own turn instead of answering. An eligible answer that names exactly one candidate
 *     dispatches it (destination 'harness', requiresClarification false, confidence ≥ 0.95).
 *     When the head has expired at route time it is dropped into expiredPending and can no longer
 *     bind: a stale answer must not reach the session it named.
 *   - Quoted content is never an instruction: when the utterance's first instruction-shaped span
 *     sits inside quotation marks (the adversarial corpus), no session is addressed and no
 *     dispatch may occur, even when the words look like an explicit prefix.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import type { ManagedSession, RoutingDecision } from '../index.js';

const FIXTURE_URL = new URL('../../../../fixtures/routing/adversarial/r03-adversarial-utterances.json', import.meta.url);

type ModeKind = 'companion' | 'agent_direct' | 'dictation';
type ControlKind = 'stop_all' | 'stop_speaking' | 'pause' | 'mute';

type RoutingMode = Readonly<{ kind: ModeKind; sessionId?: string; since: string }>;
type ModeChange = Readonly<{ from: ModeKind; to: ModeKind; cue: string; visible: string }>;
type PendingQuestion = Readonly<{
  requestId: string;
  question: string;
  candidates: ReadonlyArray<string>;
  expiresAt: string;
}>;

type R03Decision = RoutingDecision &
  Readonly<{
    mode?: RoutingMode;
    modeChange?: ModeChange;
    pending?: Readonly<{ requestId: string; expiresAt: string }>;
    answer?: Readonly<{ requestId: string }>;
    expiredPending?: ReadonlyArray<string>;
    dictation?: Readonly<{ literal: string }>;
    control?: ControlKind;
  }>;

type RoutingUtterance = Readonly<{
  utteranceId: string;
  text: string;
  asrConfidence?: number;
  partial?: boolean;
}>;

type RoutingState = Readonly<{
  setActiveSessions(sessions: ReadonlyArray<ManagedSession>): void;
  setProject(projectId: string): void;
  mode(): RoutingMode;
  pending(): ReadonlyArray<PendingQuestion>;
  route(utterance: RoutingUtterance): R03Decision;
}>;

type RoutingStateModule = Readonly<{
  PENDING_ANSWER_EXPIRY_MS: number;
  AGENT_DIRECT_INACTIVITY_MS: number;
  DICTATION_END_PHRASE: string;
  DICTATION_ESCAPE_PHRASE: string;
  createRoutingState(options: Readonly<{ sessions: ReadonlyArray<ManagedSession>; now?: () => Date }>): RoutingState;
}>;

const REQUIRED_EXPORTS =
  'packages/routing/src/state/index.ts must export PENDING_ANSWER_EXPIRY_MS (30000), '
  + 'AGENT_DIRECT_INACTIVITY_MS (300000), DICTATION_END_PHRASE ("finish dictation"), '
  + 'DICTATION_ESCAPE_PHRASE, and createRoutingState({ sessions, now? })';

let modulePromise: Promise<RoutingStateModule> | null = null;

/** Loads the R03 seam; a missing module or export is reported as missing R03 behavior below. */
function loadRoutingStateModule(): Promise<RoutingStateModule> {
  modulePromise ??= (async (): Promise<RoutingStateModule> => {
    const fail = (detail: string): never =>
      assert.fail(`R03 required routing-state behavior is not implemented yet: ${REQUIRED_EXPORTS}. ${detail}`);
    // Assembled at runtime so a missing implementation is reported as missing behavior instead of
    // a static resolution error that hides what the oracle is waiting for.
    const specifier = ['.', 'index.js'].join('/');
    let loaded: Record<string, unknown>;
    try {
      loaded = (await import(specifier)) as unknown as Record<string, unknown>;
    } catch (error) {
      return fail(`importing ${specifier} failed: ${(error as Error).message}`);
    }
    for (const name of [
      'PENDING_ANSWER_EXPIRY_MS',
      'AGENT_DIRECT_INACTIVITY_MS',
      'DICTATION_END_PHRASE',
      'DICTATION_ESCAPE_PHRASE',
      'createRoutingState',
    ]) {
      if (loaded[name] === undefined) return fail(`${name} is not exported`);
    }
    if (typeof loaded.createRoutingState !== 'function') return fail('createRoutingState is not a function');
    if (loaded.PENDING_ANSWER_EXPIRY_MS !== 30_000) {
      return fail('PENDING_ANSWER_EXPIRY_MS must be 30000 (plan §5.6 rule 4)');
    }
    if (loaded.AGENT_DIRECT_INACTIVITY_MS !== 300_000) {
      return fail('AGENT_DIRECT_INACTIVITY_MS must be 300000 (plan §5.6 rule 5)');
    }
    if (loaded.DICTATION_END_PHRASE !== 'finish dictation') {
      return fail('DICTATION_END_PHRASE must be "finish dictation" (plan §5.6 rule 2 / A-F1)');
    }
    if (typeof loaded.DICTATION_ESCAPE_PHRASE !== 'string' || loaded.DICTATION_ESCAPE_PHRASE.trim().length === 0) {
      return fail('DICTATION_ESCAPE_PHRASE must be a non-empty literal escape phrase (plan §5.6 rule 2)');
    }
    return loaded as unknown as RoutingStateModule;
  })();
  return modulePromise;
}

type Clock = Readonly<{ now: () => Date; advance: (ms: number) => void; at: () => Date }>;

function createClock(startIso: string): Clock {
  let current = new Date(startIso);
  return {
    now: () => current,
    advance: (ms: number): void => {
      current = new Date(current.getTime() + ms);
    },
    at: () => current,
  };
}

/** The session a decision would dispatch to, or null when nothing may be dispatched. */
function dispatchTarget(decision: RoutingDecision): string | null {
  if (decision.destination !== 'harness') return null;
  if (decision.targetSessionId === undefined) return null;
  if (decision.requiresClarification === true) return null;
  if (decision.confidence < 0.95) return null;
  return decision.targetSessionId;
}

type FixtureMinimums = Readonly<{
  total: number;
  quotedInstructionNoDispatch: number;
  companionExplanationNoDispatch: number;
  ambiguousNoDispatch: number;
  noisyAsr: number;
  realInstructionDispatch: number;
  quoteInsideInstructionDispatch: number;
  agentDirect: number;
  dictationLiteral: number;
  partialAsr: number;
  stopAll: number;
  sequences: number;
  distinctTexts: number;
}>;

const REQUIRED_MINIMUMS: ReadonlyArray<keyof FixtureMinimums> = [
  'total',
  'quotedInstructionNoDispatch',
  'companionExplanationNoDispatch',
  'ambiguousNoDispatch',
  'noisyAsr',
  'realInstructionDispatch',
  'quoteInsideInstructionDispatch',
  'agentDirect',
  'dictationLiteral',
  'partialAsr',
  'stopAll',
  'sequences',
  'distinctTexts',
];

type Fixture = Readonly<{
  sessions: ReadonlyArray<ManagedSession>;
  minimums: FixtureMinimums;
  quotedInstruction: Readonly<{ quotations: ReadonlyArray<string>; frames: ReadonlyArray<string> }>;
  companionExplanation: Readonly<{ utterances: ReadonlyArray<string> }>;
  ambiguousAddressee: Readonly<{ utterances: ReadonlyArray<string> }>;
  noisyAsr: Readonly<{ cases: ReadonlyArray<Readonly<{ text: string; asrConfidence: number; expectSession: string | null }>> }>;
  realInstruction: Readonly<{
    templates: ReadonlyArray<string>;
    names: ReadonlyArray<Readonly<{ text: string; sessionId: string }>>;
    tasks: ReadonlyArray<string>;
  }>;
  quoteInsideInstruction: Readonly<{ cases: ReadonlyArray<Readonly<{ text: string; expectSession: string }>> }>;
  agentDirect: Readonly<{
    cases: ReadonlyArray<
      Readonly<{
        context: Readonly<{ mode: ModeKind; sessionId?: string }>;
        text: string;
        expectSession: string | null;
      }>
    >;
  }>;
  dictationLiteral: Readonly<{ texts: ReadonlyArray<string> }>;
  partialAsr: Readonly<{ texts: ReadonlyArray<string> }>;
  stopAll: Readonly<{
    cases: ReadonlyArray<Readonly<{ context: Readonly<{ mode?: ModeKind; sessionId?: string }>; text: string }>>;
  }>;
  sequences: ReadonlyArray<
    Readonly<{
      key: string;
      steps: ReadonlyArray<
        Readonly<{
          advanceMs: number;
          text: string;
          expect: Readonly<{
            dispatch?: string | null;
            pendingCount?: number;
            requiresClarification?: boolean;
            expiredCount?: number;
            mode?: ModeKind;
            modeChanged?: boolean;
            destination?: string;
            answersHead?: boolean;
          }>;
        }>
      >;
    }>
  >;
}>;

async function loadFixture(): Promise<Fixture> {
  const parsed = JSON.parse(await readFile(FIXTURE_URL, 'utf8')) as Fixture;
  assert.ok(parsed.sessions.length >= 3, 'the adversarial corpus must declare the active sessions');
  const minimums = parsed.minimums as unknown as Readonly<Record<string, unknown>>;
  for (const key of REQUIRED_MINIMUMS) {
    const value = minimums[key];
    assert.ok(
      typeof value === 'number' && Number.isFinite(value) && value > 0,
      `the adversarial corpus must declare a positive numeric minimum for ${key}`,
    );
  }
  return parsed;
}

const fixture = await loadFixture();
const SESSIONS: ReadonlyArray<ManagedSession> = fixture.sessions;
const ALL_SESSION_IDS = ['claude-notes', 'codex-parser', 'codex-runner'];

test('R03-C1a Agent Direct mode changes are visible and audible and expire after five minutes of inactivity', async () => {
  const routing = await loadRoutingStateModule();
  const clock = createClock('2026-09-21T00:00:00.000Z');
  const state = routing.createRoutingState({ sessions: SESSIONS, now: clock.now });

  const entry = state.route({ utteranceId: 'c1a-entry', text: 'agent direct codex parser' });
  assert.equal(dispatchTarget(entry), null, 'entering a mode dispatches nothing');
  assert.equal(entry.destination, 'control', 'a mode entry is a local control turn');
  assert.ok(entry.modeChange, 'entering Agent Direct mode is a mode change');
  assert.equal(entry.modeChange?.from, 'companion');
  assert.equal(entry.modeChange?.to, 'agent_direct');
  assert.ok((entry.modeChange?.cue ?? '').trim().length > 0, 'the mode change must be audible (cue text)');
  assert.match(entry.modeChange?.cue ?? '', /agent[\s-]*direct/i, 'the cue must name the mode');
  assert.ok((entry.modeChange?.visible ?? '').trim().length > 0, 'the mode change must be visible (widget label)');
  assert.equal(entry.mode?.kind, 'agent_direct', 'the visible mode travels on the decision');
  assert.equal(entry.mode?.sessionId, 'codex-parser');
  assert.equal(state.mode().kind, 'agent_direct');
  assert.equal(state.mode().sessionId, 'codex-parser');

  const instruction = state.route({ utteranceId: 'c1a-1', text: 'add a regression test' });
  assert.equal(dispatchTarget(instruction), 'codex-parser', 'Agent Direct routes ordinary instructions to the displayed session');
  assert.equal(instruction.basis, 'active_mode');
  assert.equal(instruction.requiresClarification, false);
  assert.ok(instruction.confidence >= 0.95, 'an Agent Direct dispatch still needs auto-dispatch confidence');

  const question = state.route({ utteranceId: 'c1a-2', text: 'Echo, what is the deploy status?' });
  assert.equal(question.destination, 'companion', 'a question beginning "Echo" stays local');
  assert.equal(dispatchTarget(question), null);

  const explicit = state.route({ utteranceId: 'c1a-3', text: 'tell claude notes to review the migration diff' });
  assert.equal(dispatchTarget(explicit), 'claude-notes', 'an explicit prefix still wins over the mode');

  clock.advance(4 * 60_000 + 59_000);
  const stillActive = state.route({ utteranceId: 'c1a-4', text: 'run the full test suite' });
  assert.equal(dispatchTarget(stillActive), 'codex-parser', 'Agent Direct stays active just under five minutes of inactivity');

  clock.advance(5 * 60_000 + 1_000);
  const expired = state.route({ utteranceId: 'c1a-5', text: 'run the full test suite' });
  assert.equal(dispatchTarget(expired), null, 'after five minutes of inactivity no instruction reaches the displayed session');
  assert.equal(state.mode().kind, 'companion', 'the stale mode expires');
  assert.equal(expired.modeChange?.to, 'companion', 'the expiry is reported as a mode change');
  assert.ok((expired.modeChange?.cue ?? '').trim().length > 0, 'the exit must be audible');
  assert.equal(dispatchTarget(state.route({ utteranceId: 'c1a-6', text: 'add another regression test' })), null);

  clock.advance(1_000);
  const reentry = state.route({ utteranceId: 'c1a-7', text: 'switch to agent direct codex runner' });
  assert.equal(reentry.modeChange?.to, 'agent_direct', 'Agent Direct can be switched to another session');
  assert.equal(state.mode().sessionId, 'codex-runner');
  assert.equal(dispatchTarget(state.route({ utteranceId: 'c1a-7b', text: 'bump the lockfile' })), 'codex-runner');

  const exit = state.route({ utteranceId: 'c1a-8', text: 'stop agent direct' });
  assert.equal(state.mode().kind, 'companion', 'the mode can be switched off explicitly');
  assert.equal(exit.modeChange?.to, 'companion');
  assert.ok((exit.modeChange?.cue ?? '').trim().length > 0, 'the exit must be audible');
  assert.equal(dispatchTarget(exit), null);

  clock.advance(1_000);
  state.route({ utteranceId: 'c1a-9', text: 'switch to agent direct codex parser' });
  assert.equal(state.mode().kind, 'agent_direct');
  state.setProject('beacon');
  assert.equal(state.mode().kind, 'companion', 'a project change ends Agent Direct mode');
  const afterProject = state.route({ utteranceId: 'c1a-10', text: 'add a regression test' });
  assert.equal(dispatchTarget(afterProject), null);
  assert.equal(afterProject.modeChange?.to, 'companion', 'the project-change exit is reported to the user');
});

test('R03-C1b dictation mode keeps literal text literal and the escape phrase inserts control words', async () => {
  const routing = await loadRoutingStateModule();
  const clock = createClock('2026-09-21T00:10:00.000Z');
  const state = routing.createRoutingState({ sessions: SESSIONS, now: clock.now });

  const entry = state.route({ utteranceId: 'c1b-entry', text: 'start dictation' });
  assert.equal(entry.destination, 'control');
  assert.equal(entry.modeChange?.to, 'dictation');
  assert.ok((entry.modeChange?.cue ?? '').trim().length > 0, 'entering dictation must be audible');
  assert.equal(state.mode().kind, 'dictation');
  assert.equal(dispatchTarget(entry), null);

  fixture.dictationLiteral.texts.forEach((text, index) => {
    const decision = state.route({ utteranceId: `c1b-${index}`, text });
    assert.equal(decision.destination, 'dictation', `dictated text stays dictation: ${text}`);
    assert.equal(decision.dictation?.literal, text, `dictated text is preserved verbatim: ${text}`);
    assert.equal(decision.targetSessionId, undefined, `no session is addressed while dictating: ${text}`);
    assert.equal(decision.control, undefined, `no control is executed while dictating: ${text}`);
    assert.equal(dispatchTarget(decision), null, `no dictated content may reach a session: ${text}`);
    assert.equal(state.mode().kind, 'dictation', 'dictating does not leave the mode');
  });

  const escape = routing.DICTATION_ESCAPE_PHRASE;
  const escaped = state.route({ utteranceId: 'c1b-escape', text: `${escape} stop all` });
  assert.equal(escaped.destination, 'dictation', 'the escape phrase keeps the turn in dictation');
  assert.equal(escaped.control, undefined, 'the escape phrase keeps control words literal');
  assert.equal(escaped.dictation?.literal, 'stop all', 'the escape phrase is consumed and the words after it are dictated');
  assert.equal(state.mode().kind, 'dictation');

  const stop = state.route({ utteranceId: 'c1b-stop', text: 'stop all' });
  assert.equal(stop.destination, 'control', 'precedence 1: the emergency control still works while dictating');
  assert.equal(stop.control, 'stop_all');
  assert.equal(stop.dictation, undefined, 'the emergency control is not dictated');
  assert.equal(dispatchTarget(stop), null);

  const exit = state.route({ utteranceId: 'c1b-exit', text: routing.DICTATION_END_PHRASE });
  assert.equal(state.mode().kind, 'companion', '"finish dictation" leaves dictation mode');
  assert.equal(exit.modeChange?.to, 'companion');
  assert.ok((exit.modeChange?.cue ?? '').trim().length > 0, 'leaving dictation must be audible');
  assert.equal(exit.dictation, undefined, 'the end phrase is not dictated');
  assert.equal(dispatchTarget(exit), null);
});

test('R03-C1c a pending companion question binds the next answer for 30 seconds and stale bindings expire', async () => {
  const routing = await loadRoutingStateModule();
  const clock = createClock('2026-09-21T00:20:00.000Z');
  const state = routing.createRoutingState({ sessions: SESSIONS, now: clock.now });

  assert.equal(routing.PENDING_ANSWER_EXPIRY_MS, 30_000, 'plan §5.6 rule 4: a 30-second expiry');
  const askedAt = clock.at();
  const question = state.route({ utteranceId: 'c1c-q1', text: 'tell the session to run the tests' });
  assert.equal(question.requiresClarification, true, 'an ambiguous destination asks one question');
  assert.equal(dispatchTarget(question), null, 'a clarification dispatches nothing');
  const pending = question.pending;
  assert.ok(pending, 'asking a companion question registers a pending-answer binding');
  assert.ok((pending?.requestId ?? '').trim().length > 0, 'the binding carries its request id');
  assert.equal(
    pending?.expiresAt,
    new Date(askedAt.getTime() + routing.PENDING_ANSWER_EXPIRY_MS).toISOString(),
    'the binding expires 30 seconds after the question is asked',
  );
  assert.deepEqual(state.pending().map((entry) => entry.requestId), [pending?.requestId], 'the question is queued');
  assert.deepEqual(
    [...(state.pending()[0]?.candidates ?? [])].sort(),
    ALL_SESSION_IDS,
    'the pending question names the candidate sessions the user must choose between',
  );

  clock.advance(29_000);
  const answer = state.route({ utteranceId: 'c1c-a1', text: 'codex parser' });
  assert.equal(answer.answer?.requestId, pending?.requestId, 'the next answer binds to the pending request id');
  assert.equal(dispatchTarget(answer), 'codex-parser', 'the bound answer resolves the clarification');
  assert.equal(answer.requiresClarification, false);
  assert.ok(answer.confidence >= 0.95, 'a resolved answer is dispatchable');
  assert.equal(state.pending().length, 0, 'the answer consumes its binding');

  clock.advance(1_000);
  const staleQuestion = state.route({ utteranceId: 'c1c-q2', text: 'tell the session to run the tests' });
  const staleId = staleQuestion.pending?.requestId;
  assert.ok(staleId, 'a second question is queued');
  clock.advance(31_000);
  const staleAnswer = state.route({ utteranceId: 'c1c-a2', text: 'codex runner' });
  assert.equal(dispatchTarget(staleAnswer), null, 'an answer after the 30 s expiry must not reach the session it named');
  assert.ok((staleAnswer.expiredPending ?? []).includes(staleId), 'the stale binding is reported as expired');
  assert.equal(staleAnswer.answer, undefined, 'a stale binding does not answer anything');
  assert.equal(state.pending().length, 0, 'the expired question leaves the queue');

  clock.advance(500);
  const explicit = state.route({ utteranceId: 'c1c-a3', text: 'tell codex runner to run the tests' });
  assert.equal(dispatchTarget(explicit), 'codex-runner', 'explicit instructions still work after an expiry');
});

test('R03-C1d stop all is the precedence-1 emergency control in every mode and is never dispatched', async () => {
  const routing = await loadRoutingStateModule();
  const clock = createClock('2026-09-21T00:30:00.000Z');
  const state = routing.createRoutingState({ sessions: SESSIONS, now: clock.now });

  const controls: ReadonlyArray<readonly [string, ControlKind]> = [
    ['stop all', 'stop_all'],
    ['stop speaking', 'stop_speaking'],
    ['pause conversation', 'pause'],
    ['mute', 'mute'],
  ];
  for (const [text, control] of controls) {
    const decision = state.route({ utteranceId: `c1d-${control}`, text });
    assert.equal(decision.destination, 'control', `"${text}" is a global emergency control`);
    assert.equal(decision.control, control, `"${text}" must carry its control discriminant`);
    assert.equal(dispatchTarget(decision), null, `"${text}" dispatches nothing`);
  }

  state.route({ utteranceId: 'c1d-mode', text: 'agent direct codex parser' });
  assert.equal(state.route({ utteranceId: 'c1d-stop-mode', text: 'stop all' }).control, 'stop_all');

  const queued = state.route({ utteranceId: 'c1d-q', text: 'tell the session to run the tests' });
  assert.ok(queued.pending, 'a pending question is queued before the emergency control');
  const stopWhilePending = state.route({ utteranceId: 'c1d-stop-pending', text: 'stop all' });
  assert.equal(stopWhilePending.control, 'stop_all', 'stop all is never swallowed by a pending question');
  assert.equal(stopWhilePending.answer, undefined, 'stop all is not an answer to the pending question');
  assert.equal(dispatchTarget(stopWhilePending), null);
});

type CorpusCase = Readonly<{
  key: string;
  category: string;
  text: string;
  asrConfidence: number;
  partial?: boolean;
  expectSession: string | null;
  context: Readonly<{ mode?: ModeKind; sessionId?: string }>;
  literal?: boolean;
  control?: ControlKind;
}>;

function corpusCases(): ReadonlyArray<CorpusCase> {
  const cases: CorpusCase[] = [];
  const push = (entry: Omit<CorpusCase, 'key' | 'context'> & Readonly<{ key: string; context?: CorpusCase['context'] }>): void => {
    cases.push({ context: entry.context ?? {}, ...entry });
  };

  fixture.quotedInstruction.frames.forEach((frame, frameIndex) => {
    fixture.quotedInstruction.quotations.forEach((quote, quoteIndex) => {
      push({
        key: `quoted-${frameIndex}-${quoteIndex}`,
        category: 'quotedInstruction',
        text: frame.replace('{quote}', quote),
        asrConfidence: 0.97,
        expectSession: null,
      });
    });
  });
  fixture.companionExplanation.utterances.forEach((text, index) => {
    push({ key: `companion-${index}`, category: 'companionExplanation', text, asrConfidence: 0.97, expectSession: null });
  });
  fixture.ambiguousAddressee.utterances.forEach((text, index) => {
    push({ key: `ambiguous-${index}`, category: 'ambiguousAddressee', text, asrConfidence: 0.96, expectSession: null });
  });
  fixture.noisyAsr.cases.forEach((entry, index) => {
    push({
      key: `noisy-${index}`,
      category: 'noisyAsr',
      text: entry.text,
      asrConfidence: entry.asrConfidence,
      expectSession: entry.expectSession,
    });
  });
  fixture.realInstruction.templates.forEach((template, templateIndex) => {
    fixture.realInstruction.names.forEach((name, nameIndex) => {
      fixture.realInstruction.tasks.forEach((task, taskIndex) => {
        push({
          key: `real-${templateIndex}-${nameIndex}-${taskIndex}`,
          category: 'realInstruction',
          text: template.replace('{name}', name.text).replace('{task}', task),
          asrConfidence: 0.97,
          expectSession: name.sessionId,
        });
      });
    });
  });
  fixture.quoteInsideInstruction.cases.forEach((entry, index) => {
    push({
      key: `quote-inside-${index}`,
      category: 'quoteInsideInstruction',
      text: entry.text,
      asrConfidence: 0.97,
      expectSession: entry.expectSession,
    });
  });
  fixture.agentDirect.cases.forEach((entry, index) => {
    push({
      key: `agent-direct-${index}`,
      category: 'agentDirect',
      text: entry.text,
      asrConfidence: 0.97,
      expectSession: entry.expectSession,
      context: entry.context,
    });
  });
  fixture.dictationLiteral.texts.forEach((text, index) => {
    push({
      key: `dictation-${index}`,
      category: 'dictationLiteral',
      text,
      asrConfidence: 0.97,
      expectSession: null,
      context: { mode: 'dictation' },
      literal: true,
    });
  });
  fixture.partialAsr.texts.forEach((text, index) => {
    push({ key: `partial-${index}`, category: 'partialAsr', text, asrConfidence: 0.97, partial: true, expectSession: null });
  });
  fixture.stopAll.cases.forEach((entry, index) => {
    push({
      key: `stop-all-${index}`,
      category: 'stopAll',
      text: entry.text,
      asrConfidence: 0.97,
      expectSession: null,
      context: entry.context,
      control: 'stop_all',
    });
  });
  return cases;
}

/** Routes one corpus utterance through a fresh state, entering the case's mode context first. */
function routeCorpusCase(routing: RoutingStateModule, testCase: CorpusCase): Readonly<{ decision: R03Decision; state: RoutingState }> {
  const clock = createClock('2026-09-21T01:00:00.000Z');
  const state = routing.createRoutingState({ sessions: SESSIONS, now: clock.now });
  if (testCase.context.mode === 'dictation') state.route({ utteranceId: 'context-mode', text: 'start dictation' });
  if (testCase.context.mode === 'agent_direct') {
    state.route({ utteranceId: 'context-mode', text: `agent direct ${testCase.context.sessionId ?? ''}`.trim() });
  }
  const decision = state.route({
    utteranceId: testCase.key,
    text: testCase.text,
    asrConfidence: testCase.asrConfidence,
    ...(testCase.partial === true ? { partial: true } : {}),
  });
  return { decision, state };
}

test('R03-C2 no adversarial corpus case routes a companion explanation or quoted instruction into an unintended session', async () => {
  const routing = await loadRoutingStateModule();
  const cases = corpusCases();
  const counts = new Map<string, number>();
  for (const testCase of cases) counts.set(testCase.category, (counts.get(testCase.category) ?? 0) + 1);

  assert.ok(cases.length >= fixture.minimums.total, `the adversarial corpus must keep at least ${fixture.minimums.total} cases`);
  const expectedCounts: Readonly<Record<string, number>> = {
    quotedInstruction: fixture.minimums.quotedInstructionNoDispatch,
    companionExplanation: fixture.minimums.companionExplanationNoDispatch,
    ambiguousAddressee: fixture.minimums.ambiguousNoDispatch,
    noisyAsr: fixture.minimums.noisyAsr,
    realInstruction: fixture.minimums.realInstructionDispatch,
    quoteInsideInstruction: fixture.minimums.quoteInsideInstructionDispatch,
    agentDirect: fixture.minimums.agentDirect,
    dictationLiteral: fixture.minimums.dictationLiteral,
    partialAsr: fixture.minimums.partialAsr,
    stopAll: fixture.minimums.stopAll,
  };
  for (const [category, minimum] of Object.entries(expectedCounts)) {
    assert.ok((counts.get(category) ?? 0) >= minimum, `the corpus must keep at least ${minimum} ${category} cases`);
  }
  assert.ok(
    new Set(cases.map((entry) => entry.text)).size >= fixture.minimums.distinctTexts,
    `the corpus must keep at least ${fixture.minimums.distinctTexts} distinct utterances`,
  );

  const mismatches: string[] = [];
  for (const testCase of cases) {
    const { decision } = routeCorpusCase(routing, testCase);
    const target = dispatchTarget(decision);
    const label = testCase.expectSession === null ? 'no dispatch' : testCase.expectSession;
    if (target !== testCase.expectSession) {
      mismatches.push(`${testCase.key} [${testCase.category}] wanted ${label}, got ${target ?? 'no dispatch'}: ${testCase.text}`);
      continue;
    }
    if (testCase.literal === true && decision.dictation?.literal !== testCase.text) {
      mismatches.push(`${testCase.key} [${testCase.category}] dictated content was not literal: ${testCase.text}`);
    }
    if (testCase.control !== undefined && decision.control !== testCase.control) {
      mismatches.push(`${testCase.key} [${testCase.category}] wanted control ${testCase.control}, got ${decision.control ?? 'none'}: ${testCase.text}`);
    }
  }
  assert.equal(
    mismatches.length,
    0,
    `${mismatches.length}/${cases.length} adversarial corpus cases violated their ground-truth label:\n${mismatches.slice(0, 20).join('\n')}`,
  );
});

test('R03-C2b the corpus sequences queue overlapping pending events and switch sessions through modes', async () => {
  const routing = await loadRoutingStateModule();
  assert.ok(fixture.sequences.length >= fixture.minimums.sequences, 'the corpus must keep its pending-event sequences');

  for (const sequence of fixture.sequences) {
    const clock = createClock('2026-09-21T02:00:00.000Z');
    const state = routing.createRoutingState({ sessions: SESSIONS, now: clock.now });
    sequence.steps.forEach((step, index) => {
      if (step.advanceMs > 0) clock.advance(step.advanceMs);
      const headBefore = state.pending()[0]?.requestId;
      const decision = state.route({ utteranceId: `${sequence.key}-${index}`, text: step.text, asrConfidence: 0.97 });
      const where = `${sequence.key} step ${index + 1} (${step.text})`;
      if (step.expect.dispatch !== undefined) {
        assert.equal(dispatchTarget(decision), step.expect.dispatch, `${where}: dispatch`);
      }
      if (step.expect.pendingCount !== undefined) {
        assert.equal(state.pending().length, step.expect.pendingCount, `${where}: pending-question queue length`);
      }
      if (step.expect.requiresClarification !== undefined) {
        assert.equal(decision.requiresClarification, step.expect.requiresClarification, `${where}: requiresClarification`);
      }
      if (step.expect.expiredCount !== undefined) {
        assert.equal((decision.expiredPending ?? []).length, step.expect.expiredCount, `${where}: stale bindings dropped`);
      }
      if (step.expect.mode !== undefined) {
        assert.equal(state.mode().kind, step.expect.mode, `${where}: visible mode`);
      }
      if (step.expect.modeChanged === true) {
        assert.ok(decision.modeChange, `${where}: mode change must be visible/audible`);
        assert.ok((decision.modeChange?.cue ?? '').trim().length > 0, `${where}: mode change must be audible`);
      }
      if (step.expect.destination !== undefined) {
        assert.equal(decision.destination, step.expect.destination, `${where}: destination`);
      }
      if (step.expect.answersHead === true) {
        assert.equal(decision.answer?.requestId, headBefore, `${where}: only the queue head is eligible for the next answer`);
      }
    });
  }
});
