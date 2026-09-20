/**
 * Renderer-side view of the A03 dictation glossary controls (ticket A03; plan §5.4 glossary row,
 * judgment A-F6: "promote to global vocabulary only by explicit selection").
 *
 * The renderer never invents glossary state: it renders the entry views the durable capture store
 * already produced and keeps the two UI invariants visible.
 *
 *   - Only vocabulary this project owns and the user confirmed offers promotion. An entry that is
 *     already global, or that reached this project through a grant, offers none: another project's
 *     identifier is not promotable from here, and a project cannot re-promote what it does not own.
 *   - A promotion travels only through an explicit, confirmed user request. `promotionRequest`
 *     refuses to build one without it, so no derived or silent path promotes a project preference
 *     into global vocabulary.
 *
 * `scopeLabel` is the visible distinction between project and global vocabulary, so a user can see
 * which scope a term belongs to before deciding anything about it.
 */
import type { DictationGlossaryEntry, GlossaryScope } from '../../../../../../packages/capture/src/glossary/index.js';

export type GlossaryPromotionAction = Readonly<{
  kind: 'promote_to_global';
  term: string;
  /** Always true: the action exists only behind an explicit confirmation. */
  requiresExplicitConfirmation: true;
}>;

export type GlossaryControlRow = Readonly<{
  term: string;
  scope: GlossaryScope;
  scopeLabel: string;
  variants: readonly string[];
  canPromoteToGlobal: boolean;
  promoteAction: GlossaryPromotionAction | null;
}>;

export type GlossaryControlInput = Readonly<{
  projectId: string;
  entries: readonly DictationGlossaryEntry[];
}>;

export type GlossaryPromotionRequestInput = Readonly<{
  projectId: string;
  term: string;
  /** Only `true` — an explicit user selection — builds a promotion. */
  confirmed?: boolean;
}>;

export type GlossaryPromotionRequest = Readonly<{
  projectId: string;
  term: string;
  scope: 'global';
}>;

const SCOPE_LABELS: Readonly<Record<GlossaryScope, string>> = Object.freeze({
  project: 'Project vocabulary',
  global: 'Global vocabulary',
});

function requireProjectId(value: unknown): string {
  const projectId = typeof value === 'string' ? value.trim() : '';
  if (projectId.length === 0) throw new TypeError('the glossary controls require the project id');
  return projectId;
}

function requireTerm(value: unknown): string {
  const term = typeof value === 'string' ? value.trim() : '';
  if (term.length === 0) throw new TypeError('the glossary controls require a non-empty term');
  return term;
}

/**
 * One row per already-retrieved entry, in the given order. Promotion is offered exactly when the
 * entry is this project's own, project-scoped, user-confirmed vocabulary.
 */
export function glossaryControlRows(input: GlossaryControlInput): readonly GlossaryControlRow[] {
  const projectId = requireProjectId(input?.projectId);
  const entries = input?.entries;
  if (!Array.isArray(entries)) {
    throw new TypeError('glossaryControlRows requires { projectId, entries }');
  }
  return entries.map((entry) => {
    // Fail closed: a scope the UI does not recognise is treated as the non-promotable one, so a
    // malformed entry can never be offered as this project's own vocabulary to promote.
    const scope: GlossaryScope = entry.scope === 'project' ? 'project' : 'global';
    const canPromoteToGlobal = scope === 'project'
      && entry.ownerProjectId === projectId
      && entry.userConfirmed === true;
    return {
      term: entry.term,
      scope,
      scopeLabel: SCOPE_LABELS[scope],
      variants: [...entry.variants],
      canPromoteToGlobal,
      promoteAction: canPromoteToGlobal
        ? { kind: 'promote_to_global', term: entry.term, requiresExplicitConfirmation: true }
        : null,
    };
  });
}

/**
 * The explicit user promotion. It throws unless the caller brings the user's confirmation, so an
 * agent, a derived preference, or an unconfirmed project entry cannot promote anything.
 */
export function promotionRequest(input: GlossaryPromotionRequestInput): GlossaryPromotionRequest {
  const projectId = requireProjectId(input?.projectId);
  const term = requireTerm(input?.term);
  if (input?.confirmed !== true) {
    throw new Error(
      `promoting "${term}" to global vocabulary requires an explicit user confirmation `
      + '(pass { confirmed: true } only for the user\'s own selection)',
    );
  }
  return { projectId, term, scope: 'global' };
}
