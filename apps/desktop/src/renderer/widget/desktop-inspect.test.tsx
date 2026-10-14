/**
 * C05 widget-side tests: the renderer half of `desktop-observe`.
 *
 * Everything here runs against a fake same-origin route and a fake local UI state, so the whole
 * flow is exercised without a live Electron window, a native helper, or Accessibility permission:
 *
 *  - the explicit active project: persisted Work selection first, then a single active project,
 *    and a visible choose-one instruction for ambiguous or empty scope (with zero observe calls);
 *  - one click is exactly one `POST desktop-observe`, and concurrent re-entry cannot fan out;
 *  - the preview shows real AX labels/values with evidence ids and its truncation/partial state,
 *    while naming itself a local Accessibility preview and keeping speech off;
 *  - denied, missing-helper, timeout, and malformed answers each keep an honest, distinct state;
 *  - nothing about the observation reaches local UI state.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { DesktopInspectResultPanel } from './DesktopInspectResultPanel';
import { DesktopInspectWidget, desktopInspectScopeLine } from './DesktopInspectWidget';
import {
  createDesktopInspectClient,
  createDesktopInspectTransport,
  DESKTOP_INSPECT_PROJECT_KEY,
  DESKTOP_PREVIEW_LABEL,
  readRememberedProject,
  rememberProject,
  parseWorkSessions,
  resolveActiveProject,
  runDesktopInspect,
  type DesktopInspectState,
  type DesktopScopeState,
  type StorageLike,
  type WorkSessionSummary,
} from './desktop-inspect';

const PROJECT = 'project-atlas';
const OTHER_PROJECT = 'project-borealis';
const OBSERVED_AT_MS = 1_759_000_000_000;
const LEAK_MARKER = 'top-secret-marker';

test('explicit associated project scope works without a Codex session and overrides stale renderer selection', () => {
  const sessions = parseWorkSessions({ sessions: [], selectedProject: { projectId: PROJECT, label: 'Associated Atlas', cwd: '/chosen/project' } });
  const resolved = resolveActiveProject(sessions, OTHER_PROJECT);
  assert.equal(resolved.kind, 'resolved');
  if (resolved.kind === 'resolved') assert.equal(resolved.projectId, PROJECT);
  assert.deepEqual(parseWorkSessions({ sessions: [{ id: 'other', projectId: OTHER_PROJECT, label: 'Other', active: true }], selectedProject: null }), []);
});

type AxNode = Readonly<Record<string, unknown>>;

function axNode(overrides: AxNode = {}): AxNode {
  return {
    depth: 1,
    role: 'AXStaticText',
    subrole: null,
    label: 'Save',
    value: null,
    labelTruncated: false,
    valueTruncated: false,
    redacted: false,
    roleTruncated: false,
    subroleTruncated: false,
    ...overrides,
  };
}

function evidence(overrides: Record<string, unknown> = {}, nodes: readonly AxNode[] = [axNode()]): Record<string, unknown> {
  return {
    kind: 'desktop_observe',
    observedAtMs: OBSERVED_AT_MS,
    projectId: PROJECT,
    application: { pid: 501, bundleId: 'com.apple.TextEdit', name: 'TextEdit', bundleIdTruncated: false, nameTruncated: false },
    window: { role: 'AXWindow', roleTruncated: false, title: 'Untitled', titleTruncated: false },
    nodes,
    quality: 'full',
    truncated: false,
    truncations: [],
    stats: { visitedNodes: nodes.length, emittedNodes: nodes.length, maxDepthReached: 2, estimatedBytes: 512 },
    ...overrides,
  };
}

function session(id: string, projectId: string, label: string, active: boolean): WorkSessionSummary {
  return { id, projectId, label, active };
}

type RouteCall = Readonly<{ url: string; method: string; body: unknown }>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function fakeRoute(options: Readonly<{
  sessions?: () => Response;
  observe?: (body: Record<string, unknown>) => Response;
}>): Readonly<{ fetchImpl: typeof fetch; calls: RouteCall[] }> {
  const calls: RouteCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : null;
    calls.push({ url, method, body });
    if (url.endsWith('/work-status')) {
      if (!options.sessions) return jsonResponse({ error: 'unexpected route' }, 404);
      return options.sessions();
    }
    if (url.endsWith('/desktop-observe')) {
      if (!options.observe) return jsonResponse({ error: 'unexpected route' }, 404);
      return options.observe((body ?? {}) as Record<string, unknown>);
    }
    return jsonResponse({ error: 'unexpected route' }, 404);
  };
  return { fetchImpl, calls };
}

function posts(calls: readonly RouteCall[]): readonly RouteCall[] {
  return calls.filter((call) => call.method === 'POST');
}

function scopeTransport(sessions: readonly WorkSessionSummary[]): Readonly<{
  transport: ReturnType<typeof createDesktopInspectTransport>;
  calls: RouteCall[];
}> {
  const route = fakeRoute({ sessions: () => jsonResponse({ sessions }) });
  return { transport: createDesktopInspectTransport(route.fetchImpl, 'echo://app/index.html'), calls: route.calls };
}

function expectPreview(state: DesktopInspectState | null): Extract<DesktopInspectState, { kind: 'preview' }> {
  assert.ok(state !== null && state.kind === 'preview', `expected a preview state, got ${state?.kind ?? 'null'}`);
  return state;
}

function expectState<K extends DesktopInspectState['kind']>(
  state: DesktopInspectState | null,
  kind: K,
): Extract<DesktopInspectState, { kind: K }> {
  assert.ok(state !== null && state.kind === kind, `expected a ${kind} state, got ${state?.kind ?? 'null'}`);
  return state as Extract<DesktopInspectState, { kind: K }>;
}

test('C05 widget: a persisted Work selection wins; exactly one observe POST carries that project id', async () => {
  const route = fakeRoute({
    sessions: () => jsonResponse({ sessions: [session('a1', PROJECT, 'Atlas', true), session('b1', OTHER_PROJECT, 'Borealis', true)] }),
    observe: (body) => jsonResponse(body.projectId === OTHER_PROJECT
      ? { ok: true, evidence: evidence({ projectId: OTHER_PROJECT }) }
      : { ok: false, reason: 'invalid_scope', error: 'wrong project' }, 400),
  });
  const transport = createDesktopInspectTransport(route.fetchImpl, 'echo://app/index.html');
  const client = createDesktopInspectClient({ transport, selectedProjectId: () => OTHER_PROJECT });

  const scope = await client.loadScope();
  assert.deepEqual(scope, { kind: 'ready', projectId: OTHER_PROJECT, label: 'Borealis', source: 'selection' });

  const state = await client.inspect();
  const preview = expectPreview(state);
  assert.equal(preview.projectId, OTHER_PROJECT);
  assert.equal(preview.projectLabel, 'Borealis');
  assert.equal(preview.observedAtMs, OBSERVED_AT_MS);

  assert.equal(posts(route.calls).length, 1, 'one observe request, not one per active project');
  assert.deepEqual(posts(route.calls)[0]?.body, { projectId: OTHER_PROJECT });
  // Scope checks only read the managed-session list; they never observe on their own. `inspect`
  // re-resolves the scope at click time instead of trusting a cached earlier resolution.
  const scopes = route.calls.filter((call) => call.url.endsWith('/work-status'));
  assert.equal(scopes.length, 2, 'one scope poll plus one fresh resolution at inspect time');
  assert.ok(scopes.every((call) => call.method === 'GET'), 'scope reads are plain GETs');
  assert.ok(route.calls.every((call) => call.url.endsWith('/work-status') || call.url.endsWith('/desktop-observe')),
    'nothing but session status and the one observation is ever requested');
});

test('C05 widget: exactly one active project is used when nothing was selected', async () => {
  assert.deepEqual(resolveActiveProject([session('a1', PROJECT, 'Atlas', true)], null), {
    kind: 'resolved', projectId: PROJECT, label: 'Atlas', source: 'single_active',
  });
  // A stale remembered id that is not active must not beat the only active project.
  assert.deepEqual(resolveActiveProject([session('a1', PROJECT, 'Atlas', true)], OTHER_PROJECT), {
    kind: 'resolved', projectId: PROJECT, label: 'Atlas', source: 'single_active',
  });

  const route = fakeRoute({
    sessions: () => jsonResponse({ sessions: [session('a1', PROJECT, 'Atlas', true)] }),
    observe: () => jsonResponse({ ok: true, evidence: evidence() }),
  });
  const transport = createDesktopInspectTransport(route.fetchImpl, 'echo://app/index.html');
  const scope = await createDesktopInspectClient({ transport, selectedProjectId: () => null }).loadScope();
  assert.deepEqual(scope, { kind: 'ready', projectId: PROJECT, label: 'Atlas', source: 'single_active' });
});

test('C05 widget: the persisted project choice is validated and stored compactly', () => {
  const items = new Map<string, string>();
  const storage: StorageLike = {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => { items.set(key, value); },
    removeItem: (key) => { items.delete(key); },
  };

  assert.equal(readRememberedProject(storage), null, 'no selection reads as null');
  assert.equal(rememberProject(`  ${PROJECT}  `, storage), true, 'a project id is trimmed and stored');
  assert.equal(items.get(DESKTOP_INSPECT_PROJECT_KEY), PROJECT);
  assert.equal(readRememberedProject(storage), PROJECT);
  assert.equal(rememberProject('   ', storage), false, 'blank ids are never persisted');
  assert.equal(rememberProject('x'.repeat(300), storage), false, 'oversized ids are never persisted');
  assert.equal(readRememberedProject({ getItem: () => { throw new Error('denied'); }, setItem: () => {}, removeItem: () => {} }), null);
});

test('C05 widget: ambiguous or empty active scope is a visible instruction with zero observe requests', async () => {
  const ambiguous = fakeRoute({
    sessions: () => jsonResponse({ sessions: [session('a1', PROJECT, 'Atlas', true), session('b1', OTHER_PROJECT, 'Borealis', true)] }),
    observe: () => { throw new Error('observe must never run for an ambiguous scope'); },
  });
  const transport = createDesktopInspectTransport(ambiguous.fetchImpl, 'echo://app/index.html');

  const choose = await runDesktopInspect({ transport, selectedProjectId: null });
  const chooseState = expectState(choose, 'blocked');
  assert.equal(chooseState.activeProjects, 2);
  assert.deepEqual([...chooseState.options].map((option) => option.projectId), [PROJECT, OTHER_PROJECT]);
  assert.equal(posts(ambiguous.calls).length, 0, 'an ambiguous scope never observes');

  // A remembered id that belongs to no active session is not a valid selection either.
  const stale = await runDesktopInspect({ transport, selectedProjectId: 'project-not-active' });
  assert.equal(expectState(stale, 'blocked').activeProjects, 2);
  assert.equal(posts(ambiguous.calls).length, 0);

  const none = fakeRoute({ sessions: () => jsonResponse({ sessions: [session('a1', PROJECT, 'Atlas', false)] }) });
  const empty = await runDesktopInspect({
    transport: createDesktopInspectTransport(none.fetchImpl, 'echo://app/index.html'),
    selectedProjectId: PROJECT,
  });
  const emptyState = expectState(empty, 'blocked');
  assert.equal(emptyState.activeProjects, 0);
  assert.equal(posts(none.calls).length, 0, 'a closed session is never observed');

  const blockedMarkup = renderToStaticMarkup(<DesktopInspectResultPanel state={choose} />);
  assert.ok(blockedMarkup.includes('Choose one in Mission Control → Work'), 'the instruction names the picker');
  assert.ok(!blockedMarkup.includes('desktop-inspect-preview'), 'no preview is painted without evidence');
  const emptyMarkup = renderToStaticMarkup(<DesktopInspectResultPanel state={empty} />);
  assert.ok(emptyMarkup.includes('No active Work project'), 'an empty scope says so plainly');
});

test('C05 widget: a successful inspect previews real AX labels and values with ids and speech off', async () => {
  const longValue = `prefix-${'v'.repeat(260)}`;
  const nodes: AxNode[] = Array.from({ length: 26 }, (_, index) => axNode({
    depth: index % 3,
    role: index === 3 ? 'AXTextField' : 'AXStaticText',
    label: `Row ${index}`,
    value: index === 1 ? longValue : index === 2 ? 'draft.txt' : null,
    redacted: index === 4,
    valueTruncated: index === 1,
  }));
  const route = fakeRoute({
    sessions: () => jsonResponse({ sessions: [session('a1', PROJECT, 'Atlas', true)] }),
    observe: () => jsonResponse({ ok: true, evidence: evidence({}, nodes) }),
  });
  const transport = createDesktopInspectTransport(route.fetchImpl, 'echo://app/index.html');
  const state = expectPreview(await runDesktopInspect({ transport, selectedProjectId: null }));

  assert.equal(state.preview.spoken, false, 'the preview is never spoken');
  assert.equal(state.preview.label, DESKTOP_PREVIEW_LABEL);
  assert.equal(state.preview.application.name, 'TextEdit');
  assert.equal(state.preview.application.pid, 501);
  assert.equal(state.preview.window.title, 'Untitled');
  assert.equal(state.preview.rows.length, 24, 'the preview is bounded to its own row budget');
  assert.equal(state.preview.omittedRows, 2, 'rows beyond the budget are counted, not silently dropped');
  assert.equal(state.preview.rows[0]?.evidenceId, 'desk:ax:0');
  assert.equal(state.preview.rows[1]?.value, `${longValue.slice(0, 199)}…`, 'display text is clipped with a visible ellipsis');
  assert.equal(state.preview.rows[1]?.truncated, true);
  assert.equal(state.preview.rows[2]?.value, 'draft.txt');
  assert.equal(state.preview.rows[4]?.redacted, true);

  const markup = renderToStaticMarkup(<DesktopInspectResultPanel state={state} />);
  assert.ok(markup.includes('desk:ax:0'), 'each preview row carries its evidence id');
  assert.ok(markup.includes('Row 0'), 'the real AX label is shown');
  assert.ok(markup.includes('draft.txt'), 'the real AX value is shown');
  assert.ok(markup.includes('TextEdit — com.apple.TextEdit'), 'the app identity is named');
  assert.ok(markup.includes(DESKTOP_PREVIEW_LABEL), 'the disclosure label is exact');
  assert.ok(markup.includes('never spoken'), 'the preview states that speech stays off');
  assert.ok(markup.includes('+2 more nodes'), 'the omitted rows are disclosed');
  assert.ok(markup.includes('Open Mission Control → Desktop to ask about this snapshot'), 'the widget hands off asking to the focusable window');
  assert.ok(!markup.includes('v'.repeat(240)), 'the full unclipped value never reaches the markup');
});

test('C05 widget: partial snapshots are labelled partial, never complete', async () => {
  const truncatedNode = axNode({ label: 'Visible part', labelTruncated: true });
  const route = fakeRoute({
    sessions: () => jsonResponse({ sessions: [session('a1', PROJECT, 'Atlas', true)] }),
    observe: () => jsonResponse({
      ok: true,
      evidence: evidence({
        quality: 'partial',
        truncated: true,
        truncations: ['nodes', 'bytes'],
        stats: { visitedNodes: 900, emittedNodes: 1, maxDepthReached: 4, estimatedBytes: 32_768 },
      }, [truncatedNode]),
    }),
  });
  const transport = createDesktopInspectTransport(route.fetchImpl, 'echo://app/index.html');
  const state = expectPreview(await runDesktopInspect({ transport, selectedProjectId: null }));
  assert.equal(state.preview.quality, 'partial');
  assert.equal(state.preview.truncated, true);
  assert.equal(state.preview.rows[0]?.truncated, true, 'a native clip is carried into the preview row');
  assert.equal(state.preview.visitedNodes, 900);
  assert.equal(state.preview.emittedNodes, 1);

  const markup = renderToStaticMarkup(<DesktopInspectResultPanel state={state} />);
  assert.ok(markup.includes('Partial result'), 'the partial state is visible');
  assert.ok(markup.includes('Partial snapshot'), 'the snapshot is never presented as complete');
  assert.ok(markup.includes('nodes, bytes'), 'the named native bounds are repeated honestly');
});

test('C05 widget: every native denial keeps its own honest limited state', async () => {
  const cases = [
    { reason: 'accessibility_denied', copy: 'Accessibility access is not granted' },
    { reason: 'excluded_application', copy: 'excluded from observation' },
    { reason: 'no_window', copy: 'No focused window was available' },
    { reason: 'empty_evidence', copy: 'no readable Accessibility labels or values' },
  ] as const;
  for (const entry of cases) {
    const route = fakeRoute({
      sessions: () => jsonResponse({ sessions: [session('a1', PROJECT, 'Atlas', true)] }),
      observe: () => jsonResponse({ ok: false, reason: entry.reason, detail: `${entry.reason}\u0000detail` }),
    });
    const transport = createDesktopInspectTransport(route.fetchImpl, 'echo://app/index.html');
    const state = expectState(await runDesktopInspect({ transport, selectedProjectId: null }), 'limited');
    assert.equal(state.code, entry.reason);
    assert.equal(state.detail, `${entry.reason} detail`, 'the native detail is sanitized and bounded');

    const markup = renderToStaticMarkup(<DesktopInspectResultPanel state={state} />);
    assert.ok(markup.includes(entry.copy), `${entry.reason} keeps its own copy`);
    assert.ok(markup.includes('Nothing was invented'), 'a denial never masquerades as an answer');
    assert.ok(markup.includes(DESKTOP_PREVIEW_LABEL), 'even a denial keeps the preview disclosure');
    assert.ok(!markup.includes('desktop-inspect-preview'), 'a denial paints no evidence');
    assert.equal(posts(route.calls).length, 1, 'a denial is still exactly one observe request');
  }
});

test('C05 widget: missing helper, timeout, malformed, and route failures stay named and evidence-free', async () => {
  const states: Array<{ name: string; sessions?: () => Response; observe: () => Response; expect: string; copy: string }> = [
    {
      name: 'helper_missing',
      observe: () => jsonResponse({ ok: false, reason: 'helper_missing', error: 'missing', searched: ['/app/dist/native/echopilot-desktop'] }, 503),
      expect: 'helper_missing',
      copy: 'desktop observation helper is missing',
    },
    { name: 'timeout', observe: () => jsonResponse({ ok: false, reason: 'timeout', error: 'late' }, 504), expect: 'timeout', copy: 'timed out' },
    { name: 'malformed_response', observe: () => jsonResponse({ ok: false, reason: 'malformed_response', error: 'bad line' }, 502), expect: 'malformed_response', copy: 'could not trust' },
    { name: 'crashed', observe: () => jsonResponse({ ok: false, reason: 'crashed', error: 'exit 1' }, 502), expect: 'crashed', copy: 'exited before answering' },
    { name: 'unknown reason', observe: () => jsonResponse({ ok: false, reason: 'imaginary' }), expect: 'malformed_response', copy: 'could not trust' },
    { name: 'missing body', observe: () => jsonResponse({ ok: false }), expect: 'malformed_response', copy: 'could not trust' },
  ];
  for (const entry of states) {
    const route = fakeRoute({
      sessions: entry.sessions ?? (() => jsonResponse({ sessions: [session('a1', PROJECT, 'Atlas', true)] })),
      observe: entry.observe,
    });
    const transport = createDesktopInspectTransport(route.fetchImpl, 'echo://app/index.html');
    const state = expectState(await runDesktopInspect({ transport, selectedProjectId: null }), 'error');
    assert.equal(state.reason, entry.expect, entry.name);
    assert.ok(state.message.includes(entry.copy), `${entry.name} keeps its own copy`);

    const markup = renderToStaticMarkup(<DesktopInspectResultPanel state={state} />);
    assert.ok(markup.includes('role="alert"'), 'a failure is announced as an alert');
    assert.ok(markup.includes(`data-reason="${entry.expect}"`), 'the failure reason is machine-visible');
    assert.ok(!markup.includes('desk:ax:'), 'no evidence id is ever invented for a failure');
  }

  // A route that answers with a non-JSON body is a transport failure, not evidence.
  const notJson = fakeRoute({
    sessions: () => jsonResponse({ sessions: [session('a1', PROJECT, 'Atlas', true)] }),
    observe: () => new Response('<html>nope</html>', { status: 200 }),
  });
  const transport = createDesktopInspectTransport(notJson.fetchImpl, 'echo://app/index.html');
  assert.equal(expectState(await runDesktopInspect({ transport, selectedProjectId: null }), 'error').reason, 'transport');

  // A work-status route that fails leaves no project to confirm, and no observation runs.
  const noStatus = fakeRoute({ sessions: () => new Response('down', { status: 500 }) });
  const noStatusTransport = createDesktopInspectTransport(noStatus.fetchImpl, 'echo://app/index.html');
  const blocked = expectState(await runDesktopInspect({ transport: noStatusTransport, selectedProjectId: PROJECT }), 'error');
  assert.equal(blocked.reason, 'work_status_unavailable');
  assert.equal(posts(noStatus.calls).length, 0, 'an unconfirmed scope never observes');
});

test('C05 widget: one click is one request, even when the click lands while one is running', async () => {
  const route = fakeRoute({
    sessions: () => jsonResponse({ sessions: [session('a1', PROJECT, 'Atlas', true)] }),
    observe: () => jsonResponse({ ok: true, evidence: evidence() }),
  });
  // Gate every observe response so the first request is provably still in flight on re-entry.
  const gates: Array<(response: Response) => void> = [];
  const gatedFetch: typeof fetch = (input, init) => {
    if (`${input}`.endsWith('/desktop-observe')) {
      return new Promise<Response>((resolve) => { gates.push(resolve); });
    }
    return route.fetchImpl(input, init);
  };
  const transport = createDesktopInspectTransport(gatedFetch, 'echo://app/index.html');
  const client = createDesktopInspectClient({ transport, selectedProjectId: () => null });

  const first = client.inspect();
  while (gates.length === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  const second = await client.inspect();
  assert.equal(second, null, 're-entry while running issues nothing');
  assert.equal(gates.length, 1, 'exactly one observe request is in flight');

  (gates[0] as (response: Response) => void)(jsonResponse({ ok: true, evidence: evidence() }));
  assert.equal(expectPreview(await first).preview.rows.length, 1);

  // A later, separate click is a new observation: one click, one request.
  const third = client.inspect();
  while (gates.length < 2) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(gates.length, 2, 'the later click issued exactly one new request');
  (gates[1] as (response: Response) => void)(jsonResponse({ ok: true, evidence: evidence() }));
  assert.equal(expectPreview(await third).preview.spoken, false);
  assert.equal(posts(route.calls).length, 0, 'the counting route never saw an observe request; the gate did');
});

test('C05 widget: the widget renders the one-click affordance and the exact preview disclosure', () => {
  const ready: DesktopScopeState = { kind: 'ready', projectId: PROJECT, label: 'Atlas', source: 'selection' };
  const client = {
    loadScope: async () => ready,
    inspect: async () => null,
  };
  const markup = renderToStaticMarkup(<DesktopInspectWidget client={client} />);
  assert.ok(markup.includes('>Inspect window</button>'), 'the only action is a plain one-click button');
  assert.ok(markup.includes('local Accessibility preview — no AI answer or screenshot'), 'the disclosure is exact');
  assert.ok(markup.includes('Output speech stays off'), 'the widget states speech stays off');
  assert.ok(markup.includes('aria-busy="false"'), 'busy state is exposed to assistive tech');
  assert.ok(!markup.includes('<input'), 'there is no unfocusable text field left');
  assert.ok(!markup.includes('What is this?'), 'the old question affordance is gone');

  const blocked: DesktopScopeState = { kind: 'blocked', activeProjects: 2, options: [] };
  const checkingLine = desktopInspectScopeLine({ kind: 'checking' });
  assert.ok(checkingLine.includes('Checking Work sessions'));
  assert.ok(desktopInspectScopeLine(ready).includes('selected in Work'));
  assert.ok(desktopInspectScopeLine(blocked).includes('choose one in Mission Control → Work'));
  assert.ok(desktopInspectScopeLine({ kind: 'blocked', activeProjects: 0, options: [] }).includes('No active Work project'));
  assert.ok(desktopInspectScopeLine({ kind: 'unavailable' }).includes('Work session status is unavailable'));
});

test('C05 widget: a successful observation never writes anything to local UI state', async () => {
  const items = new Map<string, string>();
  const storage: StorageLike = {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => { items.set(key, value); },
    removeItem: (key) => { items.delete(key); },
  };
  assert.equal(rememberProject(PROJECT, storage), true);

  const route = fakeRoute({
    sessions: () => jsonResponse({ sessions: [session('a1', PROJECT, 'Atlas', true)] }),
    observe: () => jsonResponse({ ok: true, evidence: evidence({}, [axNode({ value: LEAK_MARKER })]) }),
  });
  const transport = createDesktopInspectTransport(route.fetchImpl, 'echo://app/index.html');
  const client = createDesktopInspectClient({ transport, selectedProjectId: () => readRememberedProject(storage) });
  const preview = expectPreview(await client.inspect());
  assert.equal(preview.preview.rows[0]?.value, LEAK_MARKER, 'the preview state itself does carry the read value');

  assert.equal(items.size, 1, 'only the project selection is ever persisted');
  assert.equal(items.get(DESKTOP_INSPECT_PROJECT_KEY), PROJECT);
  assert.ok(!JSON.stringify(Object.fromEntries(items)).includes(LEAK_MARKER), 'raw AX text never reaches local UI state');
});
