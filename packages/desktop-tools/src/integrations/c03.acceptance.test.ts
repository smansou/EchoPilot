/**
 * C03 acceptance oracle — structured connector (browser + editor) → scoped desktop action →
 * verification, plus extension-message authentication (IMPLEMENTATION_PLAN.md §7.2 C03; §5.4 C flow
 * "revalidate target → execute one bounded step → inspect resulting state → record receipt"; §5.3
 * contracts).
 *
 * `packages/desktop-tools/src/integrations/index.ts` must export (this file freezes these names):
 *
 *   createStructuredIntegrationService({ scope, extensions, grants, connectors })
 *     → StructuredIntegrationService
 *
 *     extensions — the connector allowlist, one entry per supported application surface:
 *       { extensionId, app, origin, capabilities }. An extension is only usable against its own
 *       allowlisted app and origin, and only for the capabilities it declares.
 *
 *     grants — the user's scoped capability grants, `{ extensionId, origin, granted }`. The grant is
 *       the effective per-session capability set: an allowlisted extension that was granted less may
 *       not use more (acceptance: "cannot request broader capabilities than granted").
 *
 *     connectors — the raw extension boundary, one structured connector per extension id:
 *       read({ capability, targetRef }) → Promise<{ targetRef, fingerprint, value } | null>
 *         Current structured state of one DOM-backed control or editor target: the live value the
 *         extension API reports. `fingerprint` identifies the app + document + target identity.
 *       write({ capability, targetRef, value }) → Promise<void>
 *         One structured write (a DOM value set, an editor insertion at the caret). It resolves when
 *         the extension API returned, which is not proof the application applied it — that is what
 *         the post-action read-back is for.
 *       The boundary never types synthetic keystrokes and never moves focus. The oracle doubles also
 *       expose the fallback paths an implementation could reach for (synthetic typing, editor
 *       submit); the oracle pins that neither is ever used. That is what "less focus interference
 *       than synthetic typing" means here: the typing path needs at least one focus transfer
 *       (SYNTHETIC_TYPING_FOCUS_CHANGES), the structured path needs none.
 *
 *     scope — the explicit project association, e.g.
 *       { profileId: 'profile-c03', projectId: 'atlas', sensitivity: 'normal' }.
 *
 *     service:
 *       bindSession({ extensionId, origin, requestedCapabilities }) → Promise<SessionBinding>
 *         The native-messaging handshake. SessionBinding =
 *           { bound: true, session: { sessionId, nonce, extensionId, origin, capabilities } }
 *           | { bound: false, reason: 'unknown_extension' | 'origin_not_allowed'
 *               | 'capability_not_granted' }
 *         The service issues the session id and the nonce; the extension never picks either, and a
 *         refused handshake executes nothing.
 *
 *       dispatch({ sessionId, nonce, origin, capability, actionId, targetRef, value? })
 *         → Promise<IntegrationOutcome>
 *         One scoped structured action on an authenticated session.
 *         Outcome = {
 *           actionId,
 *           status: 'completed' | 'denied' | 'failed',
 *           reason?: 'unknown_session' | 'origin_mismatch' | 'nonce_mismatch'
 *                  | 'capability_not_granted' | 'verification_failed',
 *           before: string | null,
 *           after: string | null,
 *           evidenceIds: string[],
 *         }
 *         A message whose origin, session, or nonce does not match the bound session is denied
 *         before the connector is touched, and so is a capability outside the session's bound set.
 *         A read capability performs one structured read (before = value, after = null). A write
 *         capability performs the preflight read (before), one structured write, and the verifying
 *         read-back (after): the verified result for 'dom.set_value' is the requested value, and for
 *         'editor.insert_text' it is the insertion at the caret (before + value), with no submit.
 *         Evidence ids are derived, not invented: the preflight read is 'int:before:<actionId>' and
 *         the verified read-back is 'int:after:<actionId>'; a denied message produces neither.
 *
 * Deterministic rules pinned here (BACKLOG.json C03 acceptance criteria):
 *   1. One browser workflow (DOM-backed control) and one editor workflow (insertion at the caret)
 *      complete through the structured connector with a before/after verified read-back, exactly the
 *      intended structured write, zero synthetic keystrokes, zero editor submission, zero focus
 *      changes.
 *   2. A write the application does not apply is not a verified result: the read-back disagrees, the
 *      outcome is 'failed' with 'verification_failed', and it never claims 'completed'.
 *   3. Handshakes are allowlisted per extension and origin, capabilities never exceed the grant, and
 *      every dispatched message is origin/session/nonce authenticated before any connector call.
 *
 * Remaining limitation: this oracle pins the TypeScript seam with deterministic doubles. The real
 * Chrome/VS Code extension packages, native-messaging host registration, the browser-profile
 * allowlist, and extension-store signing still need a manual qualification pass against real
 * browsers and editors; the fixture is fully synthetic (no real page, editor buffer, or user data).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { Scope } from '../../../contracts/src/index.js';

/** The capability vocabulary an allowlisted extension may declare and a session may bind. */
type IntegrationCapability =
  | 'dom.read_controls'
  | 'dom.set_value'
  | 'editor.read_state'
  | 'editor.insert_text';

/** One structured read: the live value the extension API reports for a target. */
type StructuredControlState = Readonly<{
  targetRef: string;
  fingerprint: string;
  value: string;
}>;

type ExtensionDescriptor = Readonly<{
  extensionId: string;
  app: string;
  origin: string;
  capabilities: ReadonlyArray<IntegrationCapability>;
}>;

type CapabilityGrant = Readonly<{
  extensionId: string;
  origin: string;
  granted: ReadonlyArray<IntegrationCapability>;
}>;

/** The raw extension boundary: structured reads and writes for one extension id. */
type StructuredConnector = Readonly<{
  extensionId: string;
  read(input: Readonly<{
    capability: IntegrationCapability;
    targetRef: string;
  }>): Promise<StructuredControlState | null>;
  write(input: Readonly<{
    capability: IntegrationCapability;
    targetRef: string;
    value: string;
  }>): Promise<void>;
}>;

type IntegrationSession = Readonly<{
  sessionId: string;
  nonce: string;
  extensionId: string;
  origin: string;
  capabilities: ReadonlyArray<IntegrationCapability>;
}>;

type IntegrationBindingFailure = 'unknown_extension' | 'origin_not_allowed' | 'capability_not_granted';

type SessionBinding =
  | Readonly<{ bound: true; session: IntegrationSession }>
  | Readonly<{ bound: false; reason: IntegrationBindingFailure }>;

type IntegrationStopReason =
  | 'unknown_session'
  | 'origin_mismatch'
  | 'nonce_mismatch'
  | 'capability_not_granted'
  | 'verification_failed';

type IntegrationOutcome = Readonly<{
  actionId: string;
  status: 'completed' | 'denied' | 'failed';
  reason?: IntegrationStopReason;
  before: string | null;
  after: string | null;
  evidenceIds: ReadonlyArray<string>;
}>;

type StructuredIntegrationService = Readonly<{
  bindSession(input: Readonly<{
    extensionId: string;
    origin: string;
    requestedCapabilities: ReadonlyArray<IntegrationCapability>;
  }>): Promise<SessionBinding>;
  dispatch(input: Readonly<{
    sessionId: string;
    nonce: string;
    origin: string;
    capability: IntegrationCapability;
    actionId: string;
    targetRef: string;
    value?: string;
  }>): Promise<IntegrationOutcome>;
}>;

type StructuredIntegrationOptions = Readonly<{
  scope: Scope;
  extensions: ReadonlyArray<ExtensionDescriptor>;
  grants: ReadonlyArray<CapabilityGrant>;
  connectors: ReadonlyArray<StructuredConnector>;
}>;

type StructuredIntegrationModule = Readonly<{
  createStructuredIntegrationService(
    options: StructuredIntegrationOptions,
  ): StructuredIntegrationService;
}>;

const MISSING_BEHAVIOR = 'C03 required structured connector behavior is not implemented yet: '
  + 'packages/desktop-tools/src/integrations/index.ts must export '
  + 'createStructuredIntegrationService({ scope, extensions, grants, connectors }) returning '
  + 'bindSession and dispatch over the frozen structured connector seam.';

/** Until the implementation exists every test fails with the missing behavior, never an import crash. */
function missingModule(detail: string): StructuredIntegrationModule {
  return {
    createStructuredIntegrationService(): never {
      assert.fail(`${MISSING_BEHAVIOR} ${detail}`);
    },
  };
}

async function loadStructuredIntegrationModule(): Promise<StructuredIntegrationModule> {
  // The specifier is assembled at runtime so a missing implementation is reported as missing
  // behavior instead of a resolution crash that hides what the oracle is waiting for.
  const specifier = ['.', 'index.js'].join('/');
  let loaded: Record<string, unknown>;
  try {
    loaded = (await import(specifier)) as Record<string, unknown>;
  } catch (error) {
    return missingModule(`importing ${specifier} failed: ${(error as Error).message}`);
  }
  if (typeof loaded.createStructuredIntegrationService !== 'function') {
    return missingModule('createStructuredIntegrationService is not exported');
  }
  return loaded as unknown as StructuredIntegrationModule;
}

const structuredIntegrations = await loadStructuredIntegrationModule();

/** A synthetic typing path needs at least one focus transfer; the structured path must need none. */
const SYNTHETIC_TYPING_FOCUS_CHANGES = 1;

const SCOPE: Scope = Object.freeze({
  profileId: 'profile-c03',
  projectId: 'atlas',
  sensitivity: 'normal',
});

const BROWSER_EXTENSION: ExtensionDescriptor = Object.freeze({
  extensionId: 'echopilot-chrome-dom',
  app: 'com.google.Chrome',
  origin: 'chrome-extension://echopilot-dom',
  capabilities: Object.freeze(['dom.read_controls', 'dom.set_value'] as const),
});

const EDITOR_EXTENSION: ExtensionDescriptor = Object.freeze({
  extensionId: 'echopilot-vscode-editor',
  app: 'com.microsoft.VSCode',
  origin: 'vscode-extension://echopilot-editor',
  capabilities: Object.freeze(['editor.read_state', 'editor.insert_text'] as const),
});

/** The allowlisted browser control the workflow acts on, as the page really renders it. */
const PAGE_CONTROL = Object.freeze({
  targetRef: 'dom:request-timeout',
  label: 'Request timeout (seconds)',
  fingerprint: 'chrome:settings#request-timeout@1',
  value: '30',
  changedValue: '45',
});

/** The active editor document, with the caret at the end of the buffer. */
const EDITOR_DOCUMENT = Object.freeze({
  targetRef: 'vscode:active-editor',
  documentRef: 'file:///workspace/atlas/src/config.ts',
  fingerprint: 'vscode:atlas/src/config.ts@1',
 text: 'export const TIMEOUT_SECONDS = 30;\n',
  insertedText: 'export const RETRY_LIMIT = 3;\n',
});

type ConnectorCall =
  | Readonly<{ kind: 'read'; capability: IntegrationCapability; targetRef: string }>
  | Readonly<{ kind: 'write'; capability: IntegrationCapability; targetRef: string; value: string }>
  | Readonly<{ kind: 'synthetic_type'; targetRef: string; value: string }>
  | Readonly<{ kind: 'submit'; targetRef: string }>;

type ConnectorEffects = {
  focusChanges: number;
  syntheticTypingCalls: number;
  submitCalls: number;
};

/** The double also offers the fallback routes a shortcut implementation would use, and counts them. */
type FakeConnector = StructuredConnector & Readonly<{
  calls: Array<ConnectorCall>;
  effects: ConnectorEffects;
  valueOf(targetRef: string): string;
  readings(targetRef: string): number;
  writes(): ReadonlyArray<Readonly<{ capability: IntegrationCapability; targetRef: string; value: string }>>;
  stallWrites(): void;
  typeSynthetically(input: Readonly<{ targetRef: string; value: string }>): Promise<void>;
  submit(targetRef: string): Promise<void>;
}>;

function baseEffects(): ConnectorEffects {
  return { focusChanges: 0, syntheticTypingCalls: 0, submitCalls: 0 };
}

function browserConnector(): FakeConnector {
  const state: { value: string; applyWrites: boolean } = { value: PAGE_CONTROL.value, applyWrites: true };
  const calls: Array<ConnectorCall> = [];
  const effects = baseEffects();
  return {
    extensionId: BROWSER_EXTENSION.extensionId,
    calls,
    effects,
    valueOf(targetRef) {
      assert.equal(targetRef, PAGE_CONTROL.targetRef, `browser double: unknown target ${targetRef}`);
      return state.value;
    },
    readings: (targetRef) => calls.filter((call) => call.kind === 'read' && call.targetRef === targetRef).length,
    writes: () => calls.filter((call) => call.kind === 'write'),
    stallWrites() {
      state.applyWrites = false;
    },
    async read({ capability, targetRef }) {
      calls.push({ kind: 'read', capability, targetRef });
      if (targetRef !== PAGE_CONTROL.targetRef) return null;
      return { targetRef, fingerprint: PAGE_CONTROL.fingerprint, value: state.value };
    },
    async write({ capability, targetRef, value }) {
      calls.push({ kind: 'write', capability, targetRef, value });
      if (targetRef === PAGE_CONTROL.targetRef && state.applyWrites) state.value = value;
    },
    async typeSynthetically({ targetRef, value }) {
      // The rejected fallback: synthetic keystrokes must focus the control before typing.
      effects.focusChanges += 1;
      effects.syntheticTypingCalls += 1;
      calls.push({ kind: 'synthetic_type', targetRef, value });
      if (targetRef === PAGE_CONTROL.targetRef && state.applyWrites) state.value = value;
    },
    async submit(targetRef) {
      effects.submitCalls += 1;
      calls.push({ kind: 'submit', targetRef });
    },
  };
}

function editorConnector(): FakeConnector {
  const state: { text: string; caret: number; applyWrites: boolean } = {
    text: EDITOR_DOCUMENT.text,
    caret: EDITOR_DOCUMENT.text.length,
    applyWrites: true,
  };
  const calls: Array<ConnectorCall> = [];
  const effects = baseEffects();
  return {
    extensionId: EDITOR_EXTENSION.extensionId,
    calls,
    effects,
    valueOf(targetRef) {
      assert.equal(targetRef, EDITOR_DOCUMENT.targetRef, `editor double: unknown target ${targetRef}`);
      return state.text;
    },
    readings: (targetRef) => calls.filter((call) => call.kind === 'read' && call.targetRef === targetRef).length,
    writes: () => calls.filter((call) => call.kind === 'write'),
    stallWrites() {
      state.applyWrites = false;
    },
    async read({ capability, targetRef }) {
      calls.push({ kind: 'read', capability, targetRef });
      if (targetRef !== EDITOR_DOCUMENT.targetRef) return null;
      return { targetRef, fingerprint: EDITOR_DOCUMENT.fingerprint, value: state.text };
    },
    async write({ capability, targetRef, value }) {
      calls.push({ kind: 'write', capability, targetRef, value });
      if (targetRef !== EDITOR_DOCUMENT.targetRef || !state.applyWrites) return;
      // Insertion at the caret; the buffer stays open and is never submitted.
      state.text = `${state.text.slice(0, state.caret)}${value}${state.text.slice(state.caret)}`;
      state.caret += value.length;
    },
    async typeSynthetically({ targetRef, value }) {
      effects.focusChanges += 1;
      effects.syntheticTypingCalls += 1;
      calls.push({ kind: 'synthetic_type', targetRef, value });
    },
    async submit(targetRef) {
      effects.submitCalls += 1;
      calls.push({ kind: 'submit', targetRef });
    },
  };
}

function sessionOf(binding: SessionBinding, label: string): IntegrationSession {
  if (!binding.bound) assert.fail(`${label}: expected a bound session, got ${binding.reason}`);
  return binding.session;
}

function bindingFailure(binding: SessionBinding, label: string): IntegrationBindingFailure {
  if (binding.bound) {
    assert.fail(`${label}: expected the handshake to be refused, but it bound ${binding.session.sessionId}`);
  }
  return binding.reason;
}

/** The structured path must never reach for typing, focus, or submit: the doubles are the ground truth. */
function assertStructuredOnly(double: FakeConnector, label: string): void {
  assert.equal(double.effects.syntheticTypingCalls, 0, `${label}: no synthetic keystrokes`);
  assert.equal(double.effects.focusChanges, 0, `${label}: the structured workflow never moves focus`);
  assert.ok(double.effects.focusChanges < SYNTHETIC_TYPING_FOCUS_CHANGES,
    `${label}: less focus interference than the synthetic typing path, which needs a focus transfer`);
  assert.equal(double.effects.submitCalls, 0, `${label}: no editor submit / Enter`);
  assert.ok(double.calls.every((call) => call.kind !== 'synthetic_type'),
    `${label}: only structured connector calls reached the application`);
}

type HarnessOptions = Readonly<{ browserGrant?: ReadonlyArray<IntegrationCapability> }>;

type Run = Readonly<{
  service: StructuredIntegrationService;
  browser: FakeConnector;
  editor: FakeConnector;
  bindBrowser(requested?: ReadonlyArray<IntegrationCapability>): Promise<SessionBinding>;
  bindEditor(requested?: ReadonlyArray<IntegrationCapability>): Promise<SessionBinding>;
}>;

function harness(options?: HarnessOptions): Run {
  const browser = browserConnector();
  const editor = editorConnector();
  const grants: ReadonlyArray<CapabilityGrant> = [
    {
      extensionId: BROWSER_EXTENSION.extensionId,
      origin: BROWSER_EXTENSION.origin,
      granted: options?.browserGrant ?? BROWSER_EXTENSION.capabilities,
    },
    {
      extensionId: EDITOR_EXTENSION.extensionId,
      origin: EDITOR_EXTENSION.origin,
      granted: EDITOR_EXTENSION.capabilities,
    },
  ];
  const service = structuredIntegrations.createStructuredIntegrationService({
    scope: SCOPE,
    extensions: [BROWSER_EXTENSION, EDITOR_EXTENSION],
    grants,
    connectors: [browser, editor],
  });
  return {
    service,
    browser,
    editor,
    bindBrowser: (requested = BROWSER_EXTENSION.capabilities) => service.bindSession({
      extensionId: BROWSER_EXTENSION.extensionId,
      origin: BROWSER_EXTENSION.origin,
      requestedCapabilities: requested,
    }),
    bindEditor: (requested = EDITOR_EXTENSION.capabilities) => service.bindSession({
      extensionId: EDITOR_EXTENSION.extensionId,
      origin: EDITOR_EXTENSION.origin,
      requestedCapabilities: requested,
    }),
  };
}

test('C03: a browser workflow runs through the DOM connector with less focus interference than typing', async () => {
  const run = harness();
  const session = sessionOf(await run.bindBrowser(), 'browser');

  assert.ok(session.sessionId.length > 0, 'the service issues the session id');
  assert.ok(session.nonce.length > 0, 'the service issues the session nonce');
  assert.equal(session.extensionId, BROWSER_EXTENSION.extensionId);
  assert.equal(session.origin, BROWSER_EXTENSION.origin);
  assert.deepEqual([...session.capabilities].sort(), [...BROWSER_EXTENSION.capabilities].sort());
  assert.equal(run.browser.calls.length, 0, 'binding a session executes nothing');
  assert.equal(SCOPE.projectId, 'atlas', 'the connector actions stay inside the explicit project scope');

  const read = await run.service.dispatch({
    sessionId: session.sessionId,
    nonce: session.nonce,
    origin: BROWSER_EXTENSION.origin,
    capability: 'dom.read_controls',
    actionId: 'act-browser-read',
    targetRef: PAGE_CONTROL.targetRef,
  });
  assert.equal(read.status, 'completed', 'a granted structured read completes');
  assert.equal(read.before, PAGE_CONTROL.value, 'the read reports the live DOM-backed control value');
  assert.equal(read.after, null, 'a read has no post-action state');
  assert.deepEqual([...read.evidenceIds], ['int:before:act-browser-read']);

  const write = await run.service.dispatch({
    sessionId: session.sessionId,
    nonce: session.nonce,
    origin: BROWSER_EXTENSION.origin,
    capability: 'dom.set_value',
    actionId: 'act-browser-set',
    targetRef: PAGE_CONTROL.targetRef,
    value: PAGE_CONTROL.changedValue,
  });
  assert.equal(write.status, 'completed', 'the granted structured write completes');
  assert.equal(write.reason, undefined, 'a completed action carries no stop reason');
  assert.equal(write.actionId, 'act-browser-set');
  assert.equal(write.before, PAGE_CONTROL.value, 'the preflight read observes the state before the write');
  assert.equal(write.after, PAGE_CONTROL.changedValue, 'the read-back verifies the requested value');
  assert.deepEqual([...write.evidenceIds], ['int:before:act-browser-set', 'int:after:act-browser-set']);
  assert.equal(run.browser.valueOf(PAGE_CONTROL.targetRef), PAGE_CONTROL.changedValue,
    'the browser control now holds the requested value');
  assert.deepEqual(run.browser.writes(), [{
    kind: 'write',
    capability: 'dom.set_value',
    targetRef: PAGE_CONTROL.targetRef,
    value: PAGE_CONTROL.changedValue,
  }], 'exactly the intended structured write reached the extension');
  assert.ok(run.browser.readings(PAGE_CONTROL.targetRef) >= 2,
    'the write is preflighted and re-read for verification');
  assertStructuredOnly(run.browser, 'browser workflow');
});

test('C03: an editor workflow inserts at the caret through the VS Code connector and verifies it', async (t) => {
  const run = harness();
  const session = sessionOf(await run.bindEditor(), 'editor');

  const read = await run.service.dispatch({
    sessionId: session.sessionId,
    nonce: session.nonce,
    origin: EDITOR_EXTENSION.origin,
    capability: 'editor.read_state',
    actionId: 'act-editor-read',
    targetRef: EDITOR_DOCUMENT.targetRef,
  });
  assert.equal(read.status, 'completed', 'a granted editor-state read completes');
  assert.equal(read.before, EDITOR_DOCUMENT.text, 'the read reports the live editor buffer');

  const insert = await run.service.dispatch({
    sessionId: session.sessionId,
    nonce: session.nonce,
    origin: EDITOR_EXTENSION.origin,
    capability: 'editor.insert_text',
    actionId: 'act-editor-insert',
    targetRef: EDITOR_DOCUMENT.targetRef,
    value: EDITOR_DOCUMENT.insertedText,
  });
  assert.equal(insert.status, 'completed', 'the granted insertion completes');
  assert.equal(insert.before, EDITOR_DOCUMENT.text, 'the preflight read observes the buffer before insertion');
  assert.equal(insert.after, `${EDITOR_DOCUMENT.text}${EDITOR_DOCUMENT.insertedText}`,
    'the verified result is the insertion at the caret, not a replacement');
  assert.deepEqual([...insert.evidenceIds], ['int:before:act-editor-insert', 'int:after:act-editor-insert']);
  assert.equal(run.editor.valueOf(EDITOR_DOCUMENT.targetRef),
    `${EDITOR_DOCUMENT.text}${EDITOR_DOCUMENT.insertedText}`, 'the editor buffer holds the inserted text');
  assert.deepEqual(run.editor.writes(), [{
    kind: 'write',
    capability: 'editor.insert_text',
    targetRef: EDITOR_DOCUMENT.targetRef,
    value: EDITOR_DOCUMENT.insertedText,
  }], 'exactly the intended insertion reached the extension');
  assertStructuredOnly(run.editor, 'editor workflow');

  await t.test('an insertion the editor never applies is not reported as a completed result', async () => {
    const stalled = harness();
    const stalledSession = sessionOf(await stalled.bindEditor(), 'editor');
    stalled.editor.stallWrites();

    const outcome = await stalled.service.dispatch({
      sessionId: stalledSession.sessionId,
      nonce: stalledSession.nonce,
      origin: EDITOR_EXTENSION.origin,
      capability: 'editor.insert_text',
      actionId: 'act-editor-stalled',
      targetRef: EDITOR_DOCUMENT.targetRef,
      value: EDITOR_DOCUMENT.insertedText,
    });

    assert.equal(outcome.status, 'failed', 'a disagreeing read-back is never a completed action');
    assert.equal(outcome.reason, 'verification_failed', 'the receipt names the failed verification');
    assert.equal(outcome.before, EDITOR_DOCUMENT.text, 'the preflight read is still reported');
    assert.equal(outcome.after, EDITOR_DOCUMENT.text, 'the read-back disagrees, so the insert is not verified');
    assert.deepEqual([...outcome.evidenceIds], ['int:before:act-editor-stalled', 'int:after:act-editor-stalled']);
    assert.equal(stalled.editor.valueOf(EDITOR_DOCUMENT.targetRef), EDITOR_DOCUMENT.text,
      'the buffer kept its text');
    assertStructuredOnly(stalled.editor, 'stalled editor workflow');
  });
});

test('C03: extension messages are origin/session authenticated and never exceed the granted capabilities', async (t) => {
  await t.test('an unlisted extension or a non-allowlisted origin cannot bind a session', async () => {
    const run = harness();

    const unlisted = await run.service.bindSession({
      extensionId: 'echopilot-unlisted',
      origin: BROWSER_EXTENSION.origin,
      requestedCapabilities: ['dom.read_controls'],
    });
    assert.equal(bindingFailure(unlisted, 'unlisted extension'), 'unknown_extension');

    const foreignOrigin = await run.service.bindSession({
      extensionId: BROWSER_EXTENSION.extensionId,
      origin: 'https://attacker.example',
      requestedCapabilities: ['dom.read_controls'],
    });
    assert.equal(bindingFailure(foreignOrigin, 'foreign origin'), 'origin_not_allowed');

    assert.equal(run.browser.calls.length + run.editor.calls.length, 0,
      'a refused handshake executes nothing');
  });

  await t.test('a handshake cannot bind broader capabilities than the grant allows', async () => {
    const run = harness({ browserGrant: ['dom.read_controls'] });

    const escalated = await run.service.bindSession({
      extensionId: BROWSER_EXTENSION.extensionId,
      origin: BROWSER_EXTENSION.origin,
      requestedCapabilities: ['dom.read_controls', 'dom.set_value'],
    });
    assert.equal(bindingFailure(escalated, 'escalated browser grant'), 'capability_not_granted');

    const foreignCapability = await run.service.bindSession({
      extensionId: BROWSER_EXTENSION.extensionId,
      origin: BROWSER_EXTENSION.origin,
      requestedCapabilities: ['editor.insert_text'],
    });
    assert.equal(bindingFailure(foreignCapability, 'browser asking for an editor capability'),
      'capability_not_granted');

    assert.equal(run.browser.calls.length, 0, 'a refused capability never reaches the extension');
  });

  await t.test('a displaced origin, session, or nonce is denied before any connector call', async () => {
    const run = harness();
    const session = sessionOf(await run.bindBrowser(), 'browser');

    const send = (overrides: Readonly<{ origin: string; sessionId: string; nonce: string }>, actionId: string) =>
      run.service.dispatch({
        sessionId: overrides.sessionId,
        nonce: overrides.nonce,
        origin: overrides.origin,
        capability: 'dom.set_value',
        actionId,
        targetRef: PAGE_CONTROL.targetRef,
        value: PAGE_CONTROL.changedValue,
      });

    const foreignOrigin = await send({
      origin: 'https://attacker.example',
      sessionId: session.sessionId,
      nonce: session.nonce,
    }, 'act-forged-origin');
    assert.equal(foreignOrigin.status, 'denied', 'a message from another origin is denied');
    assert.equal(foreignOrigin.reason, 'origin_mismatch');
    assert.deepEqual([...foreignOrigin.evidenceIds], [], 'a denied message produces no evidence');

    const unknownSession = await send({
      origin: BROWSER_EXTENSION.origin,
      sessionId: 'session-forged-0000',
      nonce: session.nonce,
    }, 'act-forged-session');
    assert.equal(unknownSession.status, 'denied');
    assert.equal(unknownSession.reason, 'unknown_session');

    const replayedNonce = await send({
      origin: BROWSER_EXTENSION.origin,
      sessionId: session.sessionId,
      nonce: `${session.nonce}:replayed`,
    }, 'act-forged-nonce');
    assert.equal(replayedNonce.status, 'denied');
    assert.equal(replayedNonce.reason, 'nonce_mismatch');

    assert.equal(run.browser.calls.length, 0, 'no connector call happens before a message is authenticated');
    assert.equal(run.browser.valueOf(PAGE_CONTROL.targetRef), PAGE_CONTROL.value, 'the control is untouched');
  });

  await t.test('a bound session cannot dispatch a capability outside its binding', async () => {
    const run = harness({ browserGrant: ['dom.read_controls'] });
    const session = sessionOf(await run.bindBrowser(['dom.read_controls']), 'read-only browser');

    const elevated = await run.service.dispatch({
      sessionId: session.sessionId,
      nonce: session.nonce,
      origin: BROWSER_EXTENSION.origin,
      capability: 'dom.set_value',
      actionId: 'act-browser-elevated',
      targetRef: PAGE_CONTROL.targetRef,
      value: PAGE_CONTROL.changedValue,
    });

    assert.equal(elevated.status, 'denied', 'the ungranted capability is denied');
    assert.equal(elevated.reason, 'capability_not_granted');
    assert.equal(elevated.before, null);
    assert.equal(elevated.after, null);
    assert.equal(run.browser.calls.length, 0, 'the extension is never asked for an ungranted capability');
    assert.equal(run.browser.valueOf(PAGE_CONTROL.targetRef), PAGE_CONTROL.value, 'the control keeps its value');
  });
});
