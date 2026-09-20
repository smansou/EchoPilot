/**
 * F03 acceptance oracle — Mission Control display, widget reflection and keyboard/VoiceOver
 * navigation (renderer half; ticket F03, IMPLEMENTATION_PLAN.md §4.3 "Configuration and UI").
 *
 * Red baseline: `apps/desktop/src/renderer/control/settings/settings-surface.ts` and
 * `packages/core/src/settings/index.ts` do not exist yet, so both modules are loaded at runtime and
 * the missing behavior is reported as explicit named assertions instead of a module-resolution
 * crash. No model, network, hardware, or Electron call is made.
 *
 * The renderer is a projection, exactly like the R02 attention surface: it never re-derives a
 * setting, it displays the policy rows it is handed. Frozen seam —
 * `apps/desktop/src/renderer/control/settings/settings-surface.ts` must export:
 *
 *   projectSettingsSurface({ effective, pending }) → SettingsSurface
 *
 *     effective — the core policy rows of packages/core/src/settings/index.ts:
 *       { key, family, label, value, source: 'default'|'profile'|'project'|'session',
 *         shadowed: [{ scope, value }], privileged }
 *     pending — the changes staged for the next safe boundary:
 *       [{ scope, key, value }]
 *
 *     SettingsSurface
 *       pages: [{ id, title, rows: ControlRow[] }]
 *         Every effective setting is displayed exactly once, all settings of one family live on one
 *         page, and page ids and titles are non-empty and unique.
 *       widget: [{ key, label, value, sourceLabel }]
 *         The four runtime settings this ticket names, in this order —
 *         persona.preset, verbosity.level, context.captureScope, attention.preset — each showing the
 *         value in force and the same sourceLabel the Mission Control row shows.
 *       pending: the staged changes, in stage order (the values in force stay untouched).
 *       navigation: [{ id: `page:<pageId>` | `setting:<key>`, role, accessibleName }]
 *         The keyboard/VoiceOver order: each page tab followed by that page's primary controls,
 *         starting at the first page's tab, with no duplicates and a non-empty accessible name for
 *         every entry (the name contains the visible label).
 *
 *     ControlRow
 *       { id: `setting:${key}`, key, family, label, value, source, sourceLabel, shadowed, pending,
 *         primary, role, accessibleName }
 *       · value and source are the value in force: a staged change is marked `pending: true` but is
 *         never displayed early;
 *       · sourceLabel is the visible provenance and is distinct per scope (default, profile,
 *         project and session must be distinguishable);
 *       · shadowed restates the overridden scopes and values the conflict explanation needs;
 *       · every setting row is `primary: true` — the controls keyboard and VoiceOver must reach.
 *
 *   importReport({ staged, proposals, rejected }) → [{ kind: 'staged'|'proposal'|'rejected', key,
 *     message }]
 *     The UI half of the import contract in packages/core/src/settings/index.ts: a rejected unknown
 *     privileged key is shown as rejected with the reason and never as staged, proposed or granted.
 *
 * Not covered here (manual qualification, reported with the oracle's evidence): real Electron focus
 * traversal and VoiceOver announcement in the running app. This oracle asserts the strongest
 * deterministic part — that every primary control is present once in the surface's keyboard order,
 * exposes an interactive role, and carries a non-empty accessible name — and that a rejected import
 * can never be rendered as a grant.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { NARRATION_VERBOSITIES } from '../../../../../../packages/narration/src/compiler/index.js';

type Scope = 'default' | 'profile' | 'project' | 'session';
type OverrideScope = Exclude<Scope, 'default'>;
type SettingsValue = string;

type CoreSchemaEntry = Readonly<{
  key: string;
  family: string;
  label: string;
  default: SettingsValue;
  values?: readonly string[];
  privileged?: boolean;
}>;

type CoreEffectiveSetting = Readonly<{
  key: string;
  family: string;
  label: string;
  value: SettingsValue;
  source: Scope;
  shadowed: readonly Readonly<{ scope: Scope; value: SettingsValue }>[];
  privileged: boolean;
}>;

type PendingSetting = Readonly<{ scope: OverrideScope; key: string; value: SettingsValue }>;

type CoreImportResult = Readonly<{
  staged: readonly string[];
  proposals: readonly Readonly<{ key: string; value: SettingsValue; reason: string }>[];
  rejected: readonly Readonly<{ key: string; reason: string }>[];
}>;

type CoreStore = Readonly<{
  effective: () => readonly CoreEffectiveSetting[];
  effectiveFor: (key: string) => CoreEffectiveSetting;
  pending: () => readonly PendingSetting[];
  stageChange: (change: Readonly<PendingSetting & { confirmed?: boolean }>) => void;
  applyAtSafeBoundary: () => readonly CoreEffectiveSetting[];
  importDocument: (text: string, options: Readonly<{ scope: OverrideScope }>) => CoreImportResult;
}>;

type CoreModule = Readonly<{
  createSettingsStore: (input: Readonly<{
    schema: readonly CoreSchemaEntry[];
    layers?: readonly Readonly<{ scope: OverrideScope; values: Readonly<Record<string, SettingsValue>> }>[];
  }>) => CoreStore;
}>;

type ControlRow = Readonly<{
  id: string;
  key: string;
  family: string;
  label: string;
  value: SettingsValue;
  source: Scope;
  sourceLabel: string;
  shadowed: readonly Readonly<{ scope: Scope; value: SettingsValue }>[];
  pending: boolean;
  primary: boolean;
  role: string;
  accessibleName: string;
}>;

type SettingsSurface = Readonly<{
  pages: readonly Readonly<{ id: string; title: string; rows: readonly ControlRow[] }>[];
  widget: readonly Readonly<{ key: string; label: string; value: SettingsValue; sourceLabel: string }>[];
  pending: readonly PendingSetting[];
  navigation: readonly Readonly<{ id: string; role: string; accessibleName: string }>[];
}>;

type ImportReportRow = Readonly<{ kind: 'staged' | 'proposal' | 'rejected'; key: string; message: string }>;

type SurfaceModule = Readonly<{
  projectSettingsSurface: (input: Readonly<{
    effective: readonly CoreEffectiveSetting[];
    pending?: readonly PendingSetting[];
  }>) => SettingsSurface;
  importReport: (result: CoreImportResult) => readonly ImportReportRow[];
}>;

/** Runtime-assembled specifiers: missing modules are reported as missing behavior, not as resolution crashes. */
const CORE_SPECIFIER = ['..', '..', '..', '..', '..', '..', 'packages', 'core', 'src', 'settings', 'index.js'].join('/');
const SURFACE_SPECIFIER = ['.', 'settings-surface.js'].join('/');

async function loadCoreModule(): Promise<CoreModule> {
  const missing = (detail: string): never => assert.fail(
    'F03 required settings behavior is not implemented yet: packages/core/src/settings/index.ts must '
    + `export createSettingsStore({ schema, layers, storage }). ${detail}`,
  );
  let loaded: Record<string, unknown>;
  try {
    loaded = (await import(CORE_SPECIFIER)) as unknown as Record<string, unknown>;
  } catch (error) {
    return missing(`importing ${CORE_SPECIFIER} failed: ${(error as Error).message}`);
  }
  if (typeof loaded.createSettingsStore !== 'function') return missing('createSettingsStore is not exported as a function');
  return loaded as unknown as CoreModule;
}

async function loadSurfaceModule(): Promise<SurfaceModule> {
  const missing = (detail: string): never => assert.fail(
    'F03 required Mission Control behavior is not implemented yet: '
    + 'apps/desktop/src/renderer/control/settings/settings-surface.ts must export '
    + `projectSettingsSurface({ effective, pending }) and importReport(result). ${detail}`,
  );
  let loaded: Record<string, unknown>;
  try {
    loaded = (await import(SURFACE_SPECIFIER)) as unknown as Record<string, unknown>;
  } catch (error) {
    return missing(`importing ${SURFACE_SPECIFIER} failed: ${(error as Error).message}`);
  }
  if (typeof loaded.projectSettingsSurface !== 'function') return missing('projectSettingsSurface is not exported as a function');
  if (typeof loaded.importReport !== 'function') return missing('importReport is not exported as a function');
  return loaded as unknown as SurfaceModule;
}

const core = await loadCoreModule();
const surfaceModule = await loadSurfaceModule();

const R02_ATTENTION_PRESETS = ['focused-work', 'hands-free', 'critical-only', 'presentation'] as const;

/** The §4.3 families this oracle drives, including the four settings the ticket names explicitly. */
const SCHEMA: readonly CoreSchemaEntry[] = [
  {
    key: 'persona.preset',
    family: 'persona',
    label: 'Persona',
    default: 'balanced-partner',
    values: ['balanced-partner', 'brief', 'soft-natural', 'engineering-direct', 'patient-explainer'],
  },
  {
    key: 'verbosity.level',
    family: 'verbosity',
    label: 'Verbosity',
    default: 'balanced',
    values: [...NARRATION_VERBOSITIES],
  },
  {
    key: 'attention.preset',
    family: 'attention',
    label: 'Attention',
    default: 'focused-work',
    values: [...R02_ATTENTION_PRESETS],
  },
  {
    key: 'context.captureScope',
    family: 'context',
    label: 'Capture scope',
    default: 'permitted-window',
    values: ['selected-text', 'permitted-window', 'project-windows'],
  },
  {
    key: 'widget.reducedMotion',
    family: 'widget',
    label: 'Reduced motion',
    default: 'system',
    values: ['system', 'reduce', 'full'],
  },
  {
    key: 'context.cloudExport',
    family: 'context',
    label: 'Cloud export',
    default: 'off',
    values: ['off', 'project-export'],
    privileged: true,
  },
];

const WIDGET_KEYS = ['persona.preset', 'verbosity.level', 'context.captureScope', 'attention.preset'] as const;

function fixtures(): CoreStore {
  return core.createSettingsStore({
    schema: SCHEMA,
    layers: [
      { scope: 'profile', values: { 'persona.preset': 'patient-explainer', 'verbosity.level': 'detailed' } },
      { scope: 'project', values: { 'verbosity.level': 'thorough' } },
      { scope: 'session', values: { 'attention.preset': 'critical-only' } },
    ],
  });
}

function surfaceFor(store: CoreStore): SettingsSurface {
  return surfaceModule.projectSettingsSurface({ effective: store.effective(), pending: store.pending() });
}

function rowsOf(surface: SettingsSurface): readonly ControlRow[] {
  return surface.pages.flatMap((page) => page.rows);
}

test('F03-C1 every effective setting is displayed with the value in force and the scope it came from', () => {
  const store = fixtures();
  const effective = store.effective();
  const surface = surfaceFor(store);
  const rows = rowsOf(surface);

  assert.equal(rows.length, effective.length, 'every effective setting is displayed exactly once');
  assert.equal(new Set(rows.map((row) => row.key)).size, rows.length, 'no setting is displayed twice');

  const pageIds = surface.pages.map((page) => page.id);
  assert.equal(new Set(pageIds).size, pageIds.length, 'page ids are unique');
  for (const page of surface.pages) {
    assert.ok(page.id.length > 0 && page.title.length > 0, 'every page is identified and titled');
    assert.ok(page.rows.length > 0, `${page.id} lists its settings`);
    assert.equal(
      new Set(page.rows.map((row) => row.accessibleName)).size,
      page.rows.length,
      `the controls on ${page.id} are named uniquely for VoiceOver`,
    );
  }

  const byKey = new Map(rows.map((row) => [row.key, row]));
  for (const setting of effective) {
    const row = byKey.get(setting.key);
    assert.ok(row, `no control row for ${setting.key}`);
    assert.equal(row.id, `setting:${setting.key}`, 'the row id identifies the setting it edits');
    assert.equal(row.label, setting.label, 'the control shows the label the policy carries');
    assert.equal(row.value, setting.value, 'the control displays the value in force');
    assert.equal(row.source, setting.source, 'the control shows the scope that supplied the value');
    assert.ok(row.sourceLabel.length > 0, `the control names the source of ${setting.key}`);
    assert.ok(row.accessibleName.includes(row.label), 'the accessible name contains the visible label');
    assert.equal(row.pending, false, 'nothing is pending yet');
    assert.equal(row.primary, true, 'a setting is a primary control');
    assert.deepEqual(
      row.shadowed.map(({ scope, value }) => [scope, value]),
      setting.shadowed.map(({ scope, value }) => [scope, value]),
      `the conflict ${setting.key} resolved is not hidden`,
    );
  }

  const sourceLabels = new Map(rows.map((row) => [row.source, row.sourceLabel]));
  assert.equal(sourceLabels.size, 4, 'the fixture exercises default, profile, project and session');
  assert.equal(new Set(sourceLabels.values()).size, 4, 'each scope has its own label, so the displayed source is unambiguous');

  const verbosity = byKey.get('verbosity.level');
  assert.ok(verbosity);
  assert.equal(verbosity.value, 'thorough');
  assert.deepEqual(
    verbosity.shadowed.map(({ scope, value }) => [scope, value]),
    [['profile', 'detailed'], ['default', 'balanced']],
    'the explanation names the profile value and the default the project override replaced',
  );

  for (const family of new Set(effective.map((setting) => setting.family))) {
    const pages = surface.pages.filter((page) => page.rows.some((row) => row.family === family));
    assert.equal(pages.length, 1, `the ${family} settings live on exactly one Mission Control page`);
  }
});

test('F03-C2 verbosity, persona, capture scope and attention change at the safe boundary and appear in the widget', () => {
  const store = fixtures();
  const initial = surfaceFor(store);

  assert.deepEqual(initial.widget.map((row) => row.key), [...WIDGET_KEYS], 'the widget reflects the four runtime settings in order');
  for (const row of initial.widget) {
    assert.equal(row.value, store.effectiveFor(row.key).value, `the widget shows the effective ${row.key}`);
    assert.ok(row.sourceLabel.length > 0, `the widget names the source of ${row.key}`);
  }
  assert.equal(initial.widget.find((row) => row.key === 'verbosity.level')?.value, 'thorough');
  const initialWidgetState = initial.widget.map((row) => [row.key, row.value] as const);

  const changes: readonly PendingSetting[] = [
    { scope: 'project', key: 'persona.preset', value: 'engineering-direct' },
    { scope: 'session', key: 'verbosity.level', value: 'concise' },
    { scope: 'project', key: 'context.captureScope', value: 'project-windows' },
    { scope: 'session', key: 'attention.preset', value: 'hands-free' },
  ];
  for (const change of changes) store.stageChange(change);

  const staged = surfaceFor(store);
  assert.deepEqual(
    staged.widget.map((row) => [row.key, row.value] as const),
    initialWidgetState,
    'the widget keeps showing the values in force until the safe boundary',
  );
  assert.deepEqual(
    staged.pending.map((change) => change.key),
    changes.map((change) => change.key),
    'the staged changes are carried for display in stage order',
  );

  const stagedRows = new Map(rowsOf(staged).map((row) => [row.key, row]));
  for (const change of changes) {
    const row = stagedRows.get(change.key);
    assert.ok(row, `no pending row for ${change.key}`);
    assert.equal(row.pending, true, 'Mission Control marks the change as waiting for the safe boundary');
    assert.equal(row.value, store.effectiveFor(change.key).value, 'a pending row still displays the value in force');
  }
  assert.equal(stagedRows.get('verbosity.level')?.value, 'thorough', 'the staged value is not shown early');

  store.applyAtSafeBoundary();
  const after = surfaceFor(store);
  assert.deepEqual(after.pending, [], 'the boundary empties the pending queue');
  const afterRows = new Map(rowsOf(after).map((row) => [row.key, row]));
  const afterWidget = new Map(after.widget.map((row) => [row.key, row]));
  for (const change of changes) {
    const widget = afterWidget.get(change.key);
    assert.ok(widget, `${change.key} is reflected in the widget`);
    assert.equal(widget.value, change.value, 'the widget shows the value now in force');
    assert.equal(widget.sourceLabel, afterRows.get(change.key)?.sourceLabel, 'the widget and Mission Control agree on the source');
    assert.equal(afterRows.get(change.key)?.pending, false, 'the row is no longer waiting for a boundary');
  }
  assert.equal(afterWidget.get('context.captureScope')?.value, 'project-windows');
  assert.ok(
    (NARRATION_VERBOSITIES as readonly string[]).includes(String(afterWidget.get('verbosity.level')?.value)),
    'the verbosity the widget now reflects is a budget the narration compiler accepts',
  );
});

test('F03-C3 keyboard and VoiceOver reach every primary control, and a rejected import is never shown as a grant', () => {
  const store = fixtures();
  const surface = surfaceFor(store);
  const navigation = surface.navigation;
  const firstPage = surface.pages[0];

  assert.ok(navigation.length > 0, 'the surface exposes a keyboard navigation order');
  assert.ok(firstPage, 'the surface has at least one page');
  assert.equal(navigation[0]?.id, `page:${firstPage.id}`, 'keyboard traversal starts at the first page tab');
  const ids = navigation.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, 'no control appears twice in the keyboard order');

  const interactiveRoles = ['tab', 'combobox', 'listbox', 'switch', 'radiogroup', 'slider', 'checkbox', 'button'];
  let checked = 0;
  for (const page of surface.pages) {
    assert.ok(ids.includes(`page:${page.id}`), `the ${page.id} tab is reachable`);
    for (const row of page.rows) {
      if (!row.primary) continue;
      checked += 1;
      assert.ok(ids.includes(row.id), `${row.id} is reachable without a pointer`);
      const entry = navigation.find((candidate) => candidate.id === row.id);
      assert.ok(entry, `no navigation entry for ${row.id}`);
      assert.equal(entry.accessibleName, row.accessibleName, 'the announced name is the row name');
      assert.ok(entry.accessibleName.trim().length > 0, 'every reachable control has an accessible name');
      assert.ok(interactiveRoles.includes(entry.role), `${row.key} exposes an interactive role, not a static one`);
    }
  }
  assert.equal(checked, rowsOf(surface).length, 'every displayed setting is a primary control this oracle checked');

  const document = JSON.stringify({
    version: 1,
    values: {
      'verbosity.level': 'concise',
      'context.cloudExport': 'project-export',
      'permissions.desktopControl': 'granted',
    },
  });
  const result = store.importDocument(document, { scope: 'project' });
  const report = surfaceModule.importReport(result);

  assert.deepEqual(
    report.filter((row) => row.kind === 'staged').map((row) => row.key),
    ['verbosity.level'],
    'an ordinary setting is shown as a change for the next boundary',
  );
  assert.deepEqual(
    report.filter((row) => row.kind === 'proposal').map((row) => row.key),
    ['context.cloudExport'],
    'a privileged setting is shown as a proposal, not as a change in force',
  );
  const rejected = report.filter((row) => row.kind === 'rejected');
  assert.deepEqual(rejected.map((row) => row.key), ['permissions.desktopControl'], 'the unknown privileged key is shown as rejected');
  for (const row of report) {
    assert.ok(row.message.trim().length > 0, `the ${row.kind} report for ${row.key} explains itself`);
  }
  assert.ok((rejected[0]?.message ?? '').includes('permissions.desktopControl'), 'the rejection names the key it refused');
  assert.equal(
    report.some((row) => row.key === 'permissions.desktopControl' && row.kind !== 'rejected'),
    false,
    'a rejected grant is never announced as staged or proposed',
  );
  assert.equal(
    report.some((row) => row.key === 'context.cloudExport' && row.kind === 'staged'),
    false,
    'a proposal is not an active change',
  );

  const refreshed = surfaceFor(store);
  assert.equal(
    rowsOf(refreshed).some((row) => row.key === 'permissions.desktopControl'),
    false,
    'a rejected key never becomes a displayed setting',
  );
});
