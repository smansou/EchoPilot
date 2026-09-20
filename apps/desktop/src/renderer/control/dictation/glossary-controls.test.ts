/**
 * A03 renderer oracle — the dictation glossary controls (ticket A03; plan §5.4 glossary row,
 * judgment A-F6: "promote to global vocabulary only by explicit selection").
 *
 * The renderer never invents glossary state: it renders the entry views the glossary store already
 * produced and keeps the two UI invariants visible:
 *
 *   - only an entry this project owns and the user confirmed offers promotion; an entry that is
 *     already global, or that reached this project through a grant, offers none — another project's
 *     identifier is not promotable from here;
 *   - a promotion travels only through an explicit, confirmed user request: the request builder
 *     refuses to build a global promotion without it, so no derived or silent path can promote a
 *     project preference to global vocabulary.
 *
 * `apps/desktop/src/renderer/control/dictation/glossary-controls.ts` must export (this file pins
 * these names; they are the frozen A03 UI seam):
 *
 *   glossaryControlRows({ projectId, entries }) → GlossaryControlRow[]
 *     One row per already-retrieved entry, in the given order:
 *       { term, scope, scopeLabel, variants, canPromoteToGlobal,
 *         promoteAction: null | { kind: 'promote_to_global', term, requiresExplicitConfirmation: true } }
 *     `scopeLabel` is the visible distinction between project and global vocabulary (the exact copy
 *     is not pinned here); `canPromoteToGlobal` is true only when entry.scope === 'project' &&
 *     entry.ownerProjectId === projectId && entry.userConfirmed, and only then is `promoteAction`
 *     non-null.
 *
 *   promotionRequest({ projectId, term, confirmed }) → { projectId, term, scope: 'global' }
 *     Builds the explicit user promotion. It throws unless `confirmed === true`; there is no
 *     implicit/default promotion path.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

type Scope = 'project' | 'global';

/** The A03 glossary entry view, as the capture store hands it to the renderer. */
type EntryView = Readonly<{
  term: string;
  variants: readonly string[];
  scope: Scope;
  userConfirmed: boolean;
  ownerProjectId: string | null;
  grantedTo: readonly string[];
  negativeExamples: readonly string[];
}>;

type ControlRow = Readonly<{
  term: string;
  scope: Scope;
  scopeLabel: string;
  variants: readonly string[];
  canPromoteToGlobal: boolean;
  promoteAction: null | Readonly<{
    kind: 'promote_to_global';
    term: string;
    requiresExplicitConfirmation: true;
  }>;
}>;

type GlossaryControlsModule = Readonly<{
  glossaryControlRows(input: Readonly<{projectId: string; entries: readonly EntryView[]}>): readonly ControlRow[];
  promotionRequest(input: Readonly<{projectId: string; term: string; confirmed?: boolean}>): Readonly<{
    projectId: string;
    term: string;
    scope: 'global';
  }>;
}>;

async function loadControlsModule(): Promise<GlossaryControlsModule> {
  const fail = (detail: string): never => assert.fail(
    'A03 required glossary-control behavior is not implemented yet: '
    + 'apps/desktop/src/renderer/control/dictation/glossary-controls.ts must export '
    + `glossaryControlRows({ projectId, entries }) and promotionRequest({ projectId, term, confirmed }). ${detail}`,
  );
  // Runtime-assembled specifier: the missing module is reported as missing behavior, not as a
  // resolution crash that hides what the oracle is waiting for.
  const specifier = ['.', 'glossary-controls.js'].join('/');
  let loaded: Record<string, unknown>;
  try {
    loaded = (await import(specifier)) as unknown as Record<string, unknown>;
  } catch (error) {
    return fail(`importing ${specifier} failed: ${(error as Error).message}`);
  }
  if (typeof loaded.glossaryControlRows !== 'function') {
    return fail('glossaryControlRows is not exported as a function');
  }
  if (typeof loaded.promotionRequest !== 'function') {
    return fail('promotionRequest is not exported as a function');
  }
  return loaded as unknown as GlossaryControlsModule;
}

const controls = await loadControlsModule();

const ATLAS = 'atlas';
const BEACON = 'beacon';

function entry(overrides: Partial<EntryView> & Pick<EntryView, 'term' | 'scope' | 'ownerProjectId'>): EntryView {
  return {
    variants: ['echo pilot'],
    userConfirmed: true,
    grantedTo: [],
    negativeExamples: [],
    ...overrides,
  };
}

const PROJECT_ENTRY = entry({term: 'EchoPilot', scope: 'project', ownerProjectId: ATLAS});
const GLOBAL_ENTRY = entry({term: 'SQLite', scope: 'global', ownerProjectId: null, variants: ['sequel lite']});
const GRANTED_ENTRY = entry({term: 'BeaconTerm', scope: 'project', ownerProjectId: BEACON, grantedTo: [ATLAS], variants: ['beacon term']});

function row(term: string): ControlRow {
  const rows = controls.glossaryControlRows({
    projectId: ATLAS,
    entries: [PROJECT_ENTRY, GLOBAL_ENTRY, GRANTED_ENTRY],
  });
  const found = rows.find((candidate) => candidate.term === term);
  assert.ok(found, `the controls must render a row for ${term}`);
  return found;
}

test('A03-C2 the glossary controls offer global promotion only for a confirmed project entry', () => {
  const project = row('EchoPilot');
  assert.equal(project.scope, 'project');
  assert.equal(project.canPromoteToGlobal, true, 'a confirmed entry this project owns can be promoted');
  assert.ok(project.promoteAction, 'the promotable row carries the promotion action');
  assert.equal(project.promoteAction.kind, 'promote_to_global');
  assert.equal(project.promoteAction.term, 'EchoPilot');
  assert.equal(project.promoteAction.requiresExplicitConfirmation, true, 'promotion always requires explicit confirmation');

  const global = row('SQLite');
  assert.equal(global.scope, 'global');
  assert.equal(global.canPromoteToGlobal, false, 'an already-global term offers no second promotion');
  assert.equal(global.promoteAction, null, 'an already-global term carries no promotion action');
  assert.notEqual(global.scopeLabel, project.scopeLabel, 'the UI must show which scope an entry belongs to');

  const granted = row('BeaconTerm');
  assert.equal(granted.canPromoteToGlobal, false, "another project's identifier is not promotable from here");
  assert.equal(granted.promoteAction, null, 'a granted entry offers no promotion action for the receiving project');
});

test('A03-C2 a global promotion exists only as an explicit confirmed user request', () => {
  assert.throws(
    () => controls.promotionRequest({projectId: ATLAS, term: 'EchoPilot'}),
    'a promotion without explicit user confirmation is refused',
  );
  assert.throws(
    () => controls.promotionRequest({projectId: ATLAS, term: 'EchoPilot', confirmed: false}),
    'confirmed: false is refused too',
  );
  assert.deepEqual(
    {...controls.promotionRequest({projectId: ATLAS, term: 'EchoPilot', confirmed: true})},
    {projectId: ATLAS, term: 'EchoPilot', scope: 'global'},
    'an explicit confirmation builds the global promotion for that term',
  );
});
