/**
 * F03 acceptance oracle — user setting → effective project policy (policy half; ticket F03,
 * IMPLEMENTATION_PLAN.md §4.3 "Configuration and UI" and §5.3 shared contracts).
 *
 * Red baseline: `packages/core/src/settings/index.ts` does not exist yet, so this file loads the
 * module at runtime and reports the missing behavior as explicit named assertions instead of
 * failing as a bare module-resolution crash. No model, network, hardware, or Electron call is made.
 *
 * The ticket path is "user setting → effective project policy → visible runtime change".
 * `apps/desktop/src/renderer/control/settings/f03.settings-surface.test.ts` freezes the visible half
 * of the same rows.
 *
 * Frozen seam — `packages/core/src/settings/index.ts` must export:
 *
 *   createSettingsStore({ schema, layers, storage }) → SettingsStore
 *
 *     schema — the ordered §4.3 settings definitions:
 *       { key, family, label, default, values?, privileged? }
 *       `key` is a dotted identifier (`verbosity.level`); `values` lists the allowed enumerations;
 *       `privileged` marks a setting that needs an explicit capability grant and can therefore only
 *       be proposed by an import, never silently activated.
 *
 *     layers — optional initial overrides, lowest precedence first:
 *       [{ scope: 'profile' | 'project' | 'session', values: { [key]: value } }]
 *       `default` values come from the schema itself; the precedence order is
 *       default < profile < project < session.
 *
 *     storage — optional durable port for project overrides:
 *       { read(): string | null; write(text: string): void }
 *       A store that can read a previously written document reloads it on construction, so a project
 *       override survives a restart. Session overrides are runtime state for one session and are
 *       deliberately not persisted: after a restart that setting resolves back to its default.
 *
 *   SettingsStore
 *
 *     effective() → one EffectiveSetting per schema entry, in schema order:
 *       { key, family, label, value, source: 'default' | 'profile' | 'project' | 'session',
 *         shadowed: [{ scope, value }], privileged }
 *       `source` is the scope that supplied the value in force — the provenance Mission Control
 *       displays next to the value. `shadowed` lists the overridden values from the next-lower scope
 *       down to the schema default, so the UI can explain the conflict it resolved.
 *
 *     effectiveFor(key) → the same row for one key.
 *
 *     pending() → the changes staged for the next safe boundary, in stage order.
 *
 *     stageChange({ scope: 'project' | 'session', key, value, confirmed? })
 *       · refuses an unknown key or a value outside the entry's `values`;
 *       · refuses a `privileged` setting unless `confirmed === true` (the explicit user action);
 *       · never changes what is in force: staged changes wait for the safe boundary.
 *
 *     applyAtSafeBoundary() → the effective settings now in force: pending changes applied in order,
 *       the queue drained, and project changes durably written to `storage`. With nothing staged it
 *       is a no-op that returns the same effective settings.
 *
 *     exportDocument() → the durable JSON document: { version: 1, values: { [key]: value } }
 *       (project overrides only; session state is not exported).
 *
 *     importDocument(text, { scope }) → { staged, proposals, rejected }
 *       · a known, non-privileged setting is staged for the next safe boundary;
 *       · a known `privileged` setting becomes a proposal only — import cannot mint the grant;
 *       · an unknown key is rejected with a reason that names the key, and leaves no trace in the
 *         effective settings, the pending queue or the durable document. A rejected key must never
 *         be silently granted just because the document asserted it.
 *
 *   defaultSettingsSchema() → the shipped §4.3 families. At minimum it contains the four settings
 *   this ticket names, with the §4.3 defaults:
 *     persona.preset      'balanced-partner'
 *     verbosity.level     'balanced'          (§5.7 budgets: concise/balanced/detailed/thorough)
 *     attention.preset    'focused-work'      (R02 presets: focused-work/hands-free/critical-only/presentation)
 *     context.captureScope 'permitted-window'
 *
 * Not covered here (manual qualification, reported with the oracle's evidence): real Electron
 * keyboard traversal and VoiceOver announcement in a running app; the renderer half of this oracle
 * asserts the strongest deterministic part of that criterion.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

type Scope = 'default' | 'profile' | 'project' | 'session';
type OverrideScope = Exclude<Scope, 'default'>;
type SettingsValue = string;

type SchemaEntry = Readonly<{
  key: string;
  family: string;
  label: string;
  default: SettingsValue;
  values?: readonly string[];
  privileged?: boolean;
}>;

type ShadowedValue = Readonly<{ scope: Scope; value: SettingsValue }>;

type EffectiveSetting = Readonly<{
  key: string;
  family: string;
  label: string;
  value: SettingsValue;
  source: Scope;
  shadowed: readonly ShadowedValue[];
  privileged: boolean;
}>;

type SettingsLayer = Readonly<{ scope: OverrideScope; values: Readonly<Record<string, SettingsValue>> }>;

type SettingsChange = Readonly<{
  scope: OverrideScope;
  key: string;
  value: SettingsValue;
  confirmed?: boolean;
}>;

type SettingsStorage = Readonly<{ read: () => string | null; write: (text: string) => void }>;

type SettingsImportResult = Readonly<{
  staged: readonly string[];
  proposals: readonly Readonly<{ key: string; value: SettingsValue; reason: string }>[];
  rejected: readonly Readonly<{ key: string; reason: string }>[];
}>;

type SettingsStore = Readonly<{
  effective: () => readonly EffectiveSetting[];
  effectiveFor: (key: string) => EffectiveSetting;
  pending: () => readonly SettingsChange[];
  stageChange: (change: SettingsChange) => void;
  applyAtSafeBoundary: () => readonly EffectiveSetting[];
  exportDocument: () => string;
  importDocument: (text: string, options: Readonly<{ scope: OverrideScope }>) => SettingsImportResult;
}>;

type SettingsModule = Readonly<{
  createSettingsStore: (input: Readonly<{
    schema: readonly SchemaEntry[];
    layers?: readonly SettingsLayer[];
    storage?: SettingsStorage;
  }>) => SettingsStore;
  defaultSettingsSchema: () => readonly SchemaEntry[];
}>;

/** Runtime-assembled specifier: the missing module is reported as missing behavior, not as a resolution crash. */
const STORE_SPECIFIER = ['.', 'index.js'].join('/');

async function loadSettingsModule(): Promise<SettingsModule> {
  const missing = (detail: string): never => assert.fail(
    'F03 required settings behavior is not implemented yet: packages/core/src/settings/index.ts must '
    + 'export createSettingsStore({ schema, layers, storage }) and defaultSettingsSchema(). '
    + detail,
  );
  let loaded: Record<string, unknown>;
  try {
    loaded = (await import(STORE_SPECIFIER)) as unknown as Record<string, unknown>;
  } catch (error) {
    return missing(`importing ${STORE_SPECIFIER} failed: ${(error as Error).message}`);
  }
  if (typeof loaded.createSettingsStore !== 'function') return missing('createSettingsStore is not exported as a function');
  if (typeof loaded.defaultSettingsSchema !== 'function') return missing('defaultSettingsSchema is not exported as a function');
  return loaded as unknown as SettingsModule;
}

const settings = await loadSettingsModule();

const R02_ATTENTION_PRESETS = ['focused-work', 'hands-free', 'critical-only', 'presentation'] as const;
const NARRATION_BUDGETS = ['concise', 'balanced', 'detailed', 'thorough'] as const;

/** The §4.3 families this oracle drives, including the four settings the ticket names explicitly. */
const SCHEMA: readonly SchemaEntry[] = [
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
    values: [...NARRATION_BUDGETS],
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

function fixtures(): SettingsStore {
  return settings.createSettingsStore({
    schema: SCHEMA,
    layers: [
      { scope: 'profile', values: { 'persona.preset': 'patient-explainer', 'verbosity.level': 'detailed' } },
      { scope: 'project', values: { 'verbosity.level': 'thorough' } },
      { scope: 'session', values: { 'attention.preset': 'critical-only' } },
    ],
  });
}

function memoryStorage(): Readonly<{ storage: SettingsStorage; text: () => string | null }> {
  let current: string | null = null;
  return {
    storage: { read: () => current, write: (text: string) => { current = text; } },
    text: () => current,
  };
}

/** The displayed half of a row: value in force plus the scope that supplied it. */
function state(store: SettingsStore): ReadonlyArray<readonly [string, SettingsValue, Scope]> {
  return store.effective().map((row) => [row.key, row.value, row.source] as const);
}

test('F03-C1 every setting resolves to one displayed effective value with the scope that supplied it', () => {
  const store = fixtures();
  const rows = store.effective();

  assert.deepEqual(
    rows.map((row) => row.key),
    SCHEMA.map((entry) => entry.key),
    'effective() reports every schema setting exactly once, in schema order',
  );
  assert.deepEqual(
    [...new Set(rows.map((row) => row.source))].sort(),
    ['default', 'profile', 'project', 'session'],
    'the fixture exercises all four precedence scopes',
  );

  for (const row of rows) {
    const entry = SCHEMA.find((candidate) => candidate.key === row.key);
    assert.ok(entry, `no schema entry for ${row.key}`);
    assert.equal(row.family, entry.family, 'the row carries the family Mission Control groups it under');
    assert.equal(row.label, entry.label, 'the row carries the label Mission Control displays');
    assert.ok(row.value.length > 0, `the displayed value of ${row.key} is never blank`);
    assert.ok(entry.values?.includes(row.value), `${row.key} resolves to a value the schema declares`);
    assert.equal(row.privileged, entry.privileged === true, 'privileged provenance survives resolution');
  }

  const verbosity = store.effectiveFor('verbosity.level');
  assert.equal(verbosity.value, 'thorough', 'the highest-precedence layer wins');
  assert.equal(verbosity.source, 'project');
  assert.deepEqual(
    verbosity.shadowed.map(({ scope, value }) => [scope, value]),
    [['profile', 'detailed'], ['default', 'balanced']],
    'the conflict explanation lists the lower-precedence values the effective value overrides',
  );

  const attention = store.effectiveFor('attention.preset');
  assert.equal(attention.value, 'critical-only');
  assert.equal(attention.source, 'session', 'a session override is the highest precedence');

  const persona = store.effectiveFor('persona.preset');
  assert.equal(persona.value, 'patient-explainer');
  assert.equal(persona.source, 'profile');

  const capture = store.effectiveFor('context.captureScope');
  assert.equal(capture.value, 'permitted-window');
  assert.equal(capture.source, 'default');
  assert.deepEqual(capture.shadowed, [], 'nothing is shadowed while the schema default is in force');

  assert.throws(
    () => store.stageChange({ scope: 'project', key: 'permissions.desktopControl', value: 'granted' }),
    'a key outside the schema is refused instead of becoming a setting',
  );
  assert.throws(
    () => store.stageChange({ scope: 'project', key: 'verbosity.level', value: 'extreme' }),
    'a value outside the schema entry is refused',
  );
});

test('F03-C1 a project override survives a restart while a session override stays runtime-only', () => {
  const disk = memoryStorage();
  const first = settings.createSettingsStore({ schema: SCHEMA, storage: disk.storage });

  first.stageChange({ scope: 'project', key: 'verbosity.level', value: 'thorough' });
  first.stageChange({ scope: 'session', key: 'attention.preset', value: 'hands-free' });
  assert.equal(first.effectiveFor('verbosity.level').value, 'balanced', 'a staged change is not yet in force');
  assert.equal(first.effectiveFor('verbosity.level').source, 'default');

  first.applyAtSafeBoundary();
  assert.equal(first.effectiveFor('verbosity.level').source, 'project');
  assert.equal(first.effectiveFor('attention.preset').source, 'session');

  const durable = disk.text();
  assert.ok(typeof durable === 'string' && durable.length > 0, 'the project override reached the durable port');
  assert.ok(durable.includes('verbosity.level'), 'the durable document carries the project override');
  assert.equal(durable.includes('attention.preset'), false, 'a session override is never persisted');

  const restarted = settings.createSettingsStore({ schema: SCHEMA, storage: disk.storage });
  const verbosity = restarted.effectiveFor('verbosity.level');
  assert.equal(verbosity.value, 'thorough', 'the project override is still in force after a restart');
  assert.equal(verbosity.source, 'project', 'and it is still attributed to the project scope');
  assert.equal(restarted.effectiveFor('attention.preset').value, 'focused-work');
  assert.equal(restarted.effectiveFor('attention.preset').source, 'default', 'session state does not survive a restart');
});

test('F03-C2 verbosity, persona, capture scope and attention apply only at the next safe boundary', () => {
  const store = fixtures();
  const before = state(store);
  const changes: readonly SettingsChange[] = [
    { scope: 'project', key: 'verbosity.level', value: 'concise' },
    { scope: 'project', key: 'persona.preset', value: 'engineering-direct' },
    { scope: 'project', key: 'context.captureScope', value: 'project-windows' },
    { scope: 'session', key: 'attention.preset', value: 'hands-free' },
  ];

  for (const change of changes) store.stageChange(change);

  assert.deepEqual(state(store), before, 'nothing in force changes before the boundary');
  assert.deepEqual(
    store.pending().map((change) => change.key),
    changes.map((change) => change.key),
    'the four runtime settings wait for the safe boundary in stage order',
  );

  const applied = store.applyAtSafeBoundary();
  assert.deepEqual(store.pending(), [], 'the boundary drains the staged changes');
  for (const change of changes) {
    const row = applied.find((candidate) => candidate.key === change.key);
    assert.ok(row, `${change.key} is reported as now in force`);
    assert.equal(row.value, change.value);
    assert.equal(row.source, change.scope, 'the boundary attributes each change to the scope that made it');
  }
  assert.deepEqual(
    store.effectiveFor('verbosity.level').shadowed.map(({ scope, value }) => [scope, value]),
    [['profile', 'detailed'], ['default', 'balanced']],
    'the overridden layers are preserved even after the override changed',
  );
  assert.deepEqual(
    store.applyAtSafeBoundary().map((row) => row.key),
    SCHEMA.map((entry) => entry.key),
    'a boundary with nothing staged is a no-op that still reports the effective settings',
  );
});

test('F03-C3 import stages ordinary settings, proposes privileged ones, and rejects unknown privileged keys', () => {
  const disk = memoryStorage();
  const store = settings.createSettingsStore({ schema: SCHEMA, storage: disk.storage });
  const document = JSON.stringify({
    version: 1,
    values: {
      'verbosity.level': 'concise',
      'context.captureScope': 'selected-text',
      'context.cloudExport': 'project-export',
      'permissions.desktopControl': 'granted',
      'autonomy.level': 'host-autonomy',
    },
  });

  const result = store.importDocument(document, { scope: 'project' });

  assert.deepEqual(
    [...result.staged].sort(),
    ['context.captureScope', 'verbosity.level'],
    'known, non-privileged settings are staged for the next safe boundary',
  );
  assert.deepEqual(
    result.proposals.map(({ key }) => key),
    ['context.cloudExport'],
    'a known privileged setting becomes a proposal that still needs explicit confirmation',
  );
  assert.deepEqual(
    result.rejected.map(({ key }) => key).sort(),
    ['autonomy.level', 'permissions.desktopControl'],
    'unknown privileged settings are rejected instead of silently granted',
  );
  for (const rejection of result.rejected) {
    assert.ok(rejection.reason.length > 0, `the rejection of ${rejection.key} carries a reason`);
    assert.ok(rejection.reason.includes(rejection.key), 'the rejection reason names the offending key');
  }

  assert.equal(store.effectiveFor('context.cloudExport').value, 'off', 'import cannot mint the privileged grant');
  assert.equal(store.effectiveFor('context.cloudExport').source, 'default');
  assert.equal(
    store.effective().some((row) => row.key === 'permissions.desktopControl'),
    false,
    'an unknown key never becomes a setting',
  );
  assert.equal(
    store.pending().some((change) => change.key === 'context.cloudExport'),
    false,
    'a proposal is not waiting for the safe boundary either',
  );

  const durable = disk.text() ?? '';
  assert.equal(durable.includes('desktopControl'), false, 'the rejected grant leaves no trace in the durable document');
  assert.equal(durable.includes('cloudExport'), false, 'and neither does the privileged proposal');

  assert.equal(store.effectiveFor('verbosity.level').value, 'balanced', 'import waits for the safe boundary like any change');
  store.applyAtSafeBoundary();
  assert.equal(store.effectiveFor('verbosity.level').value, 'concise');
  assert.equal(store.effectiveFor('verbosity.level').source, 'project', 'the imported value is attributed to the import scope');
  assert.equal(store.effectiveFor('context.captureScope').value, 'selected-text');

  assert.throws(
    () => store.stageChange({ scope: 'project', key: 'context.cloudExport', value: 'project-export' }),
    'a privileged setting cannot be changed without explicit confirmation',
  );
  store.stageChange({ scope: 'project', key: 'context.cloudExport', value: 'project-export', confirmed: true });
  store.applyAtSafeBoundary();
  assert.equal(store.effectiveFor('context.cloudExport').value, 'project-export', 'an explicit confirmation activates it');
});

test('F03-C1/C3 the durable document round-trips and a foreign version is refused wholesale', () => {
  const source = settings.createSettingsStore({ schema: SCHEMA, storage: memoryStorage().storage });
  source.stageChange({ scope: 'project', key: 'persona.preset', value: 'brief' });
  source.applyAtSafeBoundary();
  const document = source.exportDocument();
  assert.equal(JSON.parse(document).version, 1, 'the exported document is versioned JSON');

  const target = settings.createSettingsStore({ schema: SCHEMA, storage: memoryStorage().storage });
  const imported = target.importDocument(document, { scope: 'project' });
  assert.deepEqual(imported.rejected, [], 'an exported document imports cleanly');
  assert.deepEqual(imported.staged, ['persona.preset']);
  target.applyAtSafeBoundary();
  assert.equal(target.effectiveFor('persona.preset').value, 'brief');
  assert.equal(target.effectiveFor('persona.preset').source, 'project');

  const foreign = JSON.stringify({ version: 2, values: { 'verbosity.level': 'thorough' } });
  const refused = target.importDocument(foreign, { scope: 'project' });
  assert.equal(refused.staged.length, 0, 'an unsupported document version stages nothing');
  assert.equal(refused.rejected.length, 1, 'the whole document is refused with one reason');
  assert.equal(target.effectiveFor('verbosity.level').value, 'balanced', 'and nothing changed in force');
});

test('F03-C1 the shipped schema carries the four settings this ticket names with their §4.3 defaults', () => {
  const shipped = settings.defaultSettingsSchema();
  const byKey = new Map(shipped.map((entry) => [entry.key, entry]));

  const expected = [
    ['persona.preset', 'balanced-partner'],
    ['verbosity.level', 'balanced'],
    ['attention.preset', 'focused-work'],
    ['context.captureScope', 'permitted-window'],
  ] as const;
  for (const [key, value] of expected) {
    const entry = byKey.get(key);
    assert.ok(entry, `the shipped settings schema must define ${key}`);
    assert.equal(entry.default, value, `${key} keeps its §4.3 default`);
    assert.ok(entry.label.length > 0, `${key} is labelled for Mission Control`);
    assert.ok(entry.family.length > 0, `${key} belongs to a §4.3 family`);
  }

  assert.deepEqual(
    [...(byKey.get('attention.preset')?.values ?? [])],
    [...R02_ATTENTION_PRESETS],
    "the attention setting speaks R02's preset vocabulary",
  );
  assert.deepEqual(
    [...(byKey.get('verbosity.level')?.values ?? [])],
    [...NARRATION_BUDGETS],
    "the verbosity setting speaks §5.7's four budgets",
  );
  assert.ok(
    (byKey.get('context.captureScope')?.values?.length ?? 0) >= 2,
    'capture scope offers more than the default so the user can change it',
  );

  const keys = shipped.map((entry) => entry.key);
  assert.equal(new Set(keys).size, keys.length, 'no duplicate setting keys');
  for (const entry of shipped) {
    assert.ok(entry.key.includes('.'), `${entry.key} is a dotted family.name key`);
    if (entry.values) {
      assert.ok(entry.values.includes(entry.default), `${entry.key} default is one of its declared values`);
    }
  }
});
