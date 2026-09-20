/**
 * A03 durable dictation glossary — the store behind "a corrected name is learned once and later
 * dictation is better for it".
 *
 * What the user confirms is what gets learned, and it is learned narrowly:
 *
 *   - a correction names a *span* (the spoken variant) and the term it should have been, so the
 *     store never learns a whole utterance as a term;
 *   - a correction is learned into the project that heard it. Learning never widens visibility:
 *     `promoteToGlobal` is the only path that makes an entry visible to other projects without a
 *     grant, `grantProjectAccess` records one explicit share while the entry stays project-scoped,
 *     and every other project keeps correcting exactly as it did before;
 *   - a rejection records the case-sensitive span the user refused on the entry the wrong
 *     replacement matched, so that reading stays untouched while the technical reading still
 *     corrects, and a rejection never changes a scope.
 *
 * The store is one file under `directory`, written atomically (temp file + rename, mode 0600) the
 * way the rest of the app's durable state is written, and reads are served only from state that was
 * durably written: a failed save rejects the call and leaves the next one with the previous state.
 * Every operation names its project explicitly, so one store serves the whole app without an
 * ambient project.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { correctionSpans, applyGlossaryCorrections } from './correction.js';
import {
  isGlossaryScope,
  type CorrectionApplication,
  type DictationGlossaryEntry,
  type GlossaryScope,
} from './model.js';

export const DICTATION_GLOSSARY_FILE = 'dictation-glossary.json';

export interface DictationGlossaryOptions {
  readonly directory: string;
}

export interface CorrectionInput {
  readonly projectId: string;
  /** The span as it was said / the wrong text as it was produced. */
  readonly raw: string;
  /** The term the user corrected it to / the text that was wrongly produced. */
  readonly corrected: string;
}

export interface GrantProjectAccessInput {
  readonly projectId: string;
  readonly term: string;
}

export interface DictationGlossary {
  learnCorrection(input: CorrectionInput): Promise<DictationGlossaryEntry>;
  rejectCorrection(input: CorrectionInput): Promise<readonly DictationGlossaryEntry[]>;
  promoteToGlobal(term: string): Promise<DictationGlossaryEntry>;
  grantProjectAccess(input: GrantProjectAccessInput): Promise<DictationGlossaryEntry>;
  glossaryForProject(projectId: string): Promise<readonly DictationGlossaryEntry[]>;
  entries(): Promise<readonly DictationGlossaryEntry[]>;
  correctTranscript(text: string, options: Readonly<{ projectId: string }>): Promise<CorrectionApplication>;
  close(): Promise<void>;
}

/** The persisted shape. Arrays are plain; the store hands out readonly copies of them. */
interface StoredEntry {
  term: string;
  variants: string[];
  scope: GlossaryScope;
  userConfirmed: boolean;
  positiveExamples: string[];
  ownerProjectId: string | null;
  grantedTo: string[];
  negativeExamples: string[];
}

interface DurableGlossaryState {
  version: 1;
  entries: StoredEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];
}

export function dictationGlossaryPath(directory: string): string {
  return join(directory, DICTATION_GLOSSARY_FILE);
}

function normalizeState(parsed: unknown): DurableGlossaryState {
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
    throw new Error('the dictation glossary state is corrupt (unsupported schema)');
  }
  const entries: StoredEntry[] = [];
  for (const candidate of parsed.entries) {
    if (!isRecord(candidate)) continue;
    const term = typeof candidate.term === 'string' ? candidate.term.trim() : '';
    if (term.length === 0) continue;
    const owner = typeof candidate.ownerProjectId === 'string' && candidate.ownerProjectId.length > 0
      ? candidate.ownerProjectId
      : null;
    const scope = isGlossaryScope(candidate.scope) ? candidate.scope : 'project';
    entries.push({
      term,
      variants: strings(candidate.variants),
      scope: scope === 'global' ? 'global' : 'project',
      userConfirmed: candidate.userConfirmed === true,
      positiveExamples: strings(candidate.positiveExamples),
      // A global entry has no single owner; a project entry always names the project it was
      // learned in, so an entry can never be silently visible to everyone.
      ownerProjectId: scope === 'global' ? null : owner,
      grantedTo: owner === null ? [] : strings(candidate.grantedTo),
      negativeExamples: strings(candidate.negativeExamples),
    });
  }
  return { version: 1, entries };
}

async function loadState(path: string): Promise<DurableGlossaryState> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return { version: 1, entries: [] };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('the dictation glossary state is corrupt (invalid JSON)');
  }
  return normalizeState(parsed);
}

async function writeState(path: string, state: DurableGlossaryState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, path);
}

function sameTerm(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function requireProjectId(value: unknown): string {
  const projectId = typeof value === 'string' ? value.trim() : '';
  if (projectId.length === 0) throw new TypeError('the dictation glossary requires the project id');
  return projectId;
}

function requireTerm(value: unknown): string {
  const term = typeof value === 'string' ? value.trim() : '';
  if (term.length === 0) throw new TypeError('the dictation glossary requires a non-empty term');
  return term;
}

function requireText(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`the dictation glossary requires ${what}`);
  }
  return value;
}

export async function createDictationGlossary(options: DictationGlossaryOptions): Promise<DictationGlossary> {
  if (!isRecord(options)) {
    throw new TypeError('createDictationGlossary requires { directory }');
  }
  const directory = typeof options.directory === 'string' ? options.directory.trim() : '';
  if (directory.length === 0) throw new TypeError('createDictationGlossary requires a durable directory');

  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = dictationGlossaryPath(directory);
  let state = await loadState(path);
  let pending: Promise<unknown> = Promise.resolve();
  let closed = false;

  const view = (entry: StoredEntry): DictationGlossaryEntry => ({
    term: entry.term,
    variants: [...entry.variants],
    scope: entry.scope,
    userConfirmed: entry.userConfirmed,
    positiveExamples: [...entry.positiveExamples],
    ownerProjectId: entry.ownerProjectId,
    grantedTo: [...entry.grantedTo],
    negativeExamples: [...entry.negativeExamples],
  });

  const cloneEntries = (): StoredEntry[] => state.entries.map((entry) => ({
    term: entry.term,
    variants: [...entry.variants],
    scope: entry.scope,
    userConfirmed: entry.userConfirmed,
    positiveExamples: [...entry.positiveExamples],
    ownerProjectId: entry.ownerProjectId,
    grantedTo: [...entry.grantedTo],
    negativeExamples: [...entry.negativeExamples],
  }));

  /** Disk first, memory second: state that was never durably written is never served. */
  const persist = async (entries: StoredEntry[]): Promise<void> => {
    const next: DurableGlossaryState = { version: 1, entries };
    await writeState(path, next);
    state = next;
  };

  /**
   * One operation at a time. Mutations are refused once the store is closed; reads still answer,
   * because they describe state that was durably committed before the close.
   */
  const schedule = <T>(run: () => T | Promise<T>, options?: { requireOpen?: boolean }): Promise<T> => {
    const requireOpen = options?.requireOpen ?? false;
    const result = pending.then(() => {
      if (requireOpen && closed) throw new Error('this dictation glossary is closed');
      return run();
    });
    pending = result.then(() => undefined, () => undefined);
    return result;
  };

  const isVisibleTo = (entry: StoredEntry, projectId: string): boolean => (
    entry.scope === 'global'
    || entry.ownerProjectId === projectId
    || entry.grantedTo.includes(projectId)
  );

  const learnCorrection = (input: CorrectionInput): Promise<DictationGlossaryEntry> => schedule(async () => {
    const projectId = requireProjectId(input?.projectId);
    const raw = requireText(input?.raw, 'the spoken text a correction was made in');
    const corrected = requireText(input?.corrected, 'the corrected text');
    const spans = correctionSpans(raw, corrected);
    const variant = spans.variant.trim();
    const term = spans.term.trim();
    if (variant.length === 0 && term.length === 0) {
      throw new TypeError('learnCorrection requires a correction that changed the spoken text');
    }
    if (term.length === 0) {
      throw new TypeError('learnCorrection requires the corrected span to name a term (a deletion names none)');
    }

    const entries = cloneEntries();
    // A correction merges into the project's own entry for that term; vocabulary another project
    // owns (including global vocabulary) is not rewritten by a project's local correction.
    const owned = entries.find((entry) => (
      entry.scope === 'project' && entry.ownerProjectId === projectId && sameTerm(entry.term, term)
    ));
    if (owned) {
      if (variant.length > 0 && !owned.variants.some((candidate) => sameTerm(candidate, variant))) {
        owned.variants.push(variant);
      }
      if (!owned.positiveExamples.includes(corrected)) owned.positiveExamples.push(corrected);
      await persist(entries);
      return view(owned);
    }

    const created: StoredEntry = {
      term,
      variants: variant.length > 0 ? [variant] : [],
      scope: 'project',
      userConfirmed: true,
      positiveExamples: [corrected],
      ownerProjectId: projectId,
      grantedTo: [],
      negativeExamples: [],
    };
    entries.push(created);
    await persist(entries);
    return view(created);
  }, { requireOpen: true });

  const rejectCorrection = (input: CorrectionInput): Promise<readonly DictationGlossaryEntry[]> =>
    schedule(async () => {
      const projectId = requireProjectId(input?.projectId);
      const raw = requireText(input?.raw, 'the text the wrong correction produced');
      const corrected = requireText(input?.corrected, 'the wrongly produced text');
      const spans = correctionSpans(raw, corrected);
      const protectedSpan = spans.variant.trim();
      const wrongTerm = spans.term.trim();
      if (protectedSpan.length === 0 || wrongTerm.length === 0) {
        throw new TypeError('rejectCorrection requires the span that must stay untouched and the term the wrong replacement produced');
      }
      // Only vocabulary this project can see may be corrected by a rejection: a refusal must never
      // reach into another project's entry that was never shared with it.
      const index = state.entries.findIndex((entry) => (
        isVisibleTo(entry, projectId) && sameTerm(entry.term, wrongTerm)
      ));
      const fallback = index >= 0
        ? index
        : state.entries.findIndex((entry) => (
          isVisibleTo(entry, projectId) && entry.variants.some((candidate) => sameTerm(candidate, wrongTerm))
        ));
      if (fallback < 0) {
        throw new Error(`rejectCorrection found no glossary entry for "${wrongTerm}" visible to ${projectId}`);
      }

      const entries = cloneEntries();
      const entry = entries[fallback] as StoredEntry;
      // Case-sensitive on purpose: the exact reading the user refused is what stays untouched.
      if (!entry.negativeExamples.includes(protectedSpan)) entry.negativeExamples.push(protectedSpan);
      await persist(entries);
      return [view(entry)];
    }, { requireOpen: true });

  const promoteToGlobal = (term: string): Promise<DictationGlossaryEntry> => schedule(async () => {
    const wanted = requireTerm(term);
    const index = state.entries.findIndex((entry) => sameTerm(entry.term, wanted));
    if (index < 0) throw new Error(`promoteToGlobal found no glossary entry named "${wanted}"`);
    const entries = cloneEntries();
    const entry = entries[index] as StoredEntry;
    if (entry.scope === 'global') return view(entry);
    if (entry.userConfirmed !== true) {
      throw new Error(`promoteToGlobal refuses "${wanted}": only a user-confirmed entry becomes global vocabulary`);
    }
    entry.scope = 'global';
    entry.ownerProjectId = null;
    await persist(entries);
    return view(entry);
  }, { requireOpen: true });

  const grantProjectAccess = (input: GrantProjectAccessInput): Promise<DictationGlossaryEntry> =>
    schedule(async () => {
      const projectId = requireProjectId(input?.projectId);
      const term = requireTerm(input?.term);
      const index = state.entries.findIndex((entry) => sameTerm(entry.term, term));
      if (index < 0) throw new Error(`grantProjectAccess found no glossary entry named "${term}"`);
      const entries = cloneEntries();
      const entry = entries[index] as StoredEntry;
      if (entry.scope === 'global' || entry.ownerProjectId === projectId || entry.grantedTo.includes(projectId)) {
        return view(entry);
      }
      entry.grantedTo.push(projectId);
      await persist(entries);
      return view(entry);
    }, { requireOpen: true });

  const glossaryForProject = (projectId: string): Promise<readonly DictationGlossaryEntry[]> =>
    schedule(() => {
      const wanted = requireProjectId(projectId);
      return state.entries.filter((entry) => isVisibleTo(entry, wanted)).map(view);
    });

  const entries = (): Promise<readonly DictationGlossaryEntry[]> =>
    schedule(() => state.entries.map(view));

  const correctTranscript = (
    text: string,
    options: Readonly<{ projectId: string }>,
  ): Promise<CorrectionApplication> => schedule(() => {
    if (typeof text !== 'string') throw new TypeError('correctTranscript requires the committed transcript text');
    const projectId = requireProjectId(options?.projectId);
    const visible = state.entries.filter((entry) => isVisibleTo(entry, projectId)).map(view);
    return applyGlossaryCorrections(text, visible);
  });

  const close = async (): Promise<void> => {
    closed = true;
    try {
      await pending;
    } catch {
      // A failed operation was already reported to its own caller; closing still completes.
    }
  };

  return {
    learnCorrection,
    rejectCorrection,
    promoteToGlobal,
    grantProjectAccess,
    glossaryForProject,
    entries,
    correctTranscript,
    close,
  };
}
