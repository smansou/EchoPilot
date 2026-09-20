/**
 * A04 held-out dictation corpus and signed-app compatibility matrix — deterministic fixture plus
 * the CLI that proves the fixture is reproducible and internally consistent.
 *
 * Nothing here touches the network, the clock, the filesystem, or user data: every utterance is
 * built from index-derived values only, so `node check-a04-corpus.mjs --json` is byte-stable. The
 * A04 acceptance oracle (`packages/eval/src/dictation/a04.acceptance.test.ts`) freezes the digest of
 * that output before it drives the held-out scoring seam and the insertion matrix, so the corpus
 * cannot be reshaped to fit an implementation.
 *
 * A corpus case carries what the system under test may see and the labels only the scorer may read:
 *
 *   rawTranscript   the committed ASR text as the microphone path heard it (the only input)
 *   goldTranscript  the transcript a correct dictation system should produce
 *   technicalTerms  [{ spoken, canonical, start, end }] — one evaluation slot per technical term;
 *                   `start`/`end` are offsets into rawTranscript. A slot is an error in a text when
 *                   that text does not contain `canonical` verbatim, so a slot whose spoken form is
 *                   already correct (a `clean` case) can only stay correct or become an error.
 *   glossary        the prior project glossary entries (A03) the correction request may cite; each
 *                   entry carries the canonical term plus the spoken variant, so an evidence-backed
 *                   substitution can be corroborated. Never the gold transcript as a whole.
 *   protectedTokens numbers, paths, flags, negation and quoted literals that must survive
 *                   character for character.
 *   trap            a substitution a plausible model proposes on a protected token (only on
 *                   `protected_trap` cases). It is a live harmful proposal: the corrector must
 *                   block it, and the scorer must count the substituted text as harmful if it
 *                   ever reaches the inserted text.
 *   kind            'technical_error' (the term was misheard), 'clean' (already correct), or
 *                   'protected_trap' (technical error plus a harmful protected-token proposal).
 *
 * The `surfaces` section is the signed-app compatibility matrix from the ticket scope: terminals,
 * browsers, IDEs, secure fields, multiple displays, IME state, app switching, and revoked
 * permissions. `simulatedLatencyMs` is the deterministic native-double cost model the oracle uses
 * to measure capture/insertion timing; it is a fixture property so the measurements are
 * reproducible rather than wall-clock dependent.
 * `userCopiesDuringPaste` marks the surface where the user replaces the clipboard while the paste
 * keystroke is in flight, so `clipboard changes by the user are preserved` is decidable in a test.
 *
 * Usage: node fixtures/dictation/check-a04-corpus.mjs [--json|--summary]
 *   --json     print the corpus document (cases, surfaces, digest) for the oracle to consume
 *   --summary  print counts and the digest (default)
 * Exit code 1 when the corpus fails self-validation.
 */
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const CORPUS_CONTRACT_VERSION = 1;
export const CORPUS_FIXTURE_ID = 'dictation-a04-held-out-1000';
export const CORPUS_CONSENT = 'synthetic';
export const CORPUS_SEED = 'a04-held-out-2026-09-21';
export const CORPUS_CASE_COUNT = 1000;

/** Technical terms, each with the way the microphone path tends to mishear it. */
const TERMS = [
  { canonical: 'SQLite', spoken: 'sequel lite' },
  { canonical: 'JSON', spoken: 'jason' },
  { canonical: 'URL', spoken: 'you are ell' },
  { canonical: 'TypeScript', spoken: 'type script' },
  { canonical: 'Postgres', spoken: 'post gress' },
  { canonical: 'kubectl', spoken: 'kube control' },
  { canonical: 'PyTorch', spoken: 'pie torch' },
  { canonical: 'webpack', spoken: 'web pack' },
  { canonical: 'ESLint', spoken: 'es lint' },
  { canonical: 'Redis', spoken: 'red iss' },
  { canonical: 'Grafana', spoken: 'grafana' },
  { canonical: 'OAuth', spoken: 'oh auth' },
  { canonical: 'Nginx', spoken: 'engine x' },
  { canonical: 'Kafka', spoken: 'kaf ka' },
];

/** Sentence frames. `{spoken}` never contains a digit, a slash, a flag, a negation or a quote. */
const TEMPLATES = [
  { id: 'store-events', raw: 'we should store the events in {spoken} before the migration runs', gold: 'we should store the events in {canonical} before the migration runs' },
  { id: 'serialize-response', raw: 'serialize the response as {spoken} and log the request id', gold: 'serialize the response as {canonical} and log the request id' },
  { id: 'pin-version', raw: 'pin the {spoken} version in the lockfile before we ship', gold: 'pin the {canonical} version in the lockfile before we ship' },
  { id: 'run-apply', raw: 'run {spoken} apply before the deploy window closes', gold: 'run {canonical} apply before the deploy window closes' },
  { id: 'import-client', raw: 'import the {spoken} client from the shared package', gold: 'import the {canonical} client from the shared package' },
  { id: 'cache-cold', raw: 'the {spoken} cache is cold after the restart', gold: 'the {canonical} cache is cold after the restart' },
  { id: 'lint-rule', raw: 'add the {spoken} rule to the shared config', gold: 'add the {canonical} rule to the shared config' },
  { id: 'span-slow', raw: 'the {spoken} span shows the slow request', gold: 'the {canonical} span shows the slow request' },
  { id: 'dashboard', raw: 'open the {spoken} dashboard during the incident review', gold: 'open the {canonical} dashboard during the incident review' },
  { id: 'queue-lag', raw: 'the {spoken} queue lag is growing on the primary broker', gold: 'the {canonical} queue lag is growing on the primary broker' },
];

/** Protected-token clauses. Each trap is a substitution a plausible model would propose. */
const CLAUSES = [
  { id: 'number', text: 'retry 3 times at 250 ms', trap: { original: '3', replacement: '5' } },
  { id: 'path', text: 'then update src/compiler/index.ts', trap: { original: 'src/compiler/index.ts', replacement: 'src/main.ts' } },
  { id: 'flag', text: 'and run it with --verbose next time', trap: { original: '--verbose', replacement: '--quiet' } },
  { id: 'negation', text: 'but do not commit the lockfile change', trap: { original: 'do not', replacement: 'do' } },
  { id: 'quoted', text: 'keep the literal "raw text" untouched', trap: { original: '"raw text"', replacement: '"empty"' } },
];

const APP_BY_INDEX = ['terminal', 'browser', 'ide', 'editor'];

/**
 * The signed-app compatibility matrix. `expect` is the behavior the A04 runner must derive and
 * report: 'insert' for supported surfaces, 'preview_only' when no write may occur (secure field,
 * active IME composition, revoked Accessibility trust), and 'focus_changed' for the app-switch
 * surface, where the insert attempt must write nothing because focus moved.
 *
 * `userCopiesDuringPaste` is the one surface where the deterministic native double replaces the
 * clipboard while the paste keystroke is in flight, so the oracle can prove the user's copy
 * survives instead of being overwritten by a restoration; every other clipboard surface keeps the
 * clipboard untouched and must get its previous contents back.
 */
const RAW_MATRIX_SURFACES = [
  {
    key: 'ide-vscode',
    app: 'Visual Studio Code',
    bundleId: 'com.microsoft.VSCode',
    role: 'AXTextArea',
    displayId: 1,
    secure: false,
    editable: true,
    imeComposing: false,
    accessibilityTrust: 'granted',
    screenRecording: 'granted',
    insertMethod: 'accessibility',
    expect: 'insert',
    switchesAwayAfterCommit: false,
    userEditsAfterInsert: false,
    simulatedLatencyMs: { capture: 120, insert: 45, keyStroke: 0 },
    note: 'IDE editor: Accessibility write, no key synthesis, no clipboard involvement',
  },
  {
    key: 'editor-textedit',
    app: 'TextEdit',
    bundleId: 'com.apple.TextEdit',
    role: 'AXTextArea',
    displayId: 1,
    secure: false,
    editable: true,
    imeComposing: false,
    accessibilityTrust: 'granted',
    screenRecording: 'granted',
    insertMethod: 'accessibility',
    expect: 'insert',
    switchesAwayAfterCommit: false,
    userEditsAfterInsert: false,
    simulatedLatencyMs: { capture: 90, insert: 30, keyStroke: 0 },
    note: 'plain macOS editor: Accessibility write',
  },
  {
    key: 'terminal-iterm',
    app: 'iTerm2',
    bundleId: 'com.googlecode.iterm2',
    role: 'AXTextArea',
    displayId: 1,
    secure: false,
    editable: true,
    imeComposing: false,
    accessibilityTrust: 'granted',
    screenRecording: 'granted',
    insertMethod: 'clipboard',
    expect: 'insert',
    switchesAwayAfterCommit: false,
    userEditsAfterInsert: false,
    simulatedLatencyMs: { capture: 110, insert: 20, keyStroke: 60 },
    note: 'terminal: AX insert unsupported, transactional clipboard paste fallback',
  },
  {
    key: 'browser-safari-field',
    app: 'Safari',
    bundleId: 'com.apple.Safari',
    role: 'AXTextField',
    displayId: 1,
    secure: false,
    editable: true,
    imeComposing: false,
    accessibilityTrust: 'granted',
    screenRecording: 'granted',
    insertMethod: 'clipboard',
    expect: 'insert',
    switchesAwayAfterCommit: false,
    userEditsAfterInsert: false,
    simulatedLatencyMs: { capture: 100, insert: 25, keyStroke: 55 },
    note: 'browser text field: clipboard paste fallback with the previous clipboard restored',
  },
  {
    key: 'terminal-large-scrollback',
    app: 'iTerm2 (large scrollback)',
    bundleId: 'com.googlecode.iterm2',
    role: 'AXTextArea',
    displayId: 1,
    secure: false,
    editable: true,
    imeComposing: false,
    accessibilityTrust: 'granted',
    screenRecording: 'granted',
    insertMethod: 'accessibility',
    expect: 'insert',
    switchesAwayAfterCommit: false,
    userEditsAfterInsert: false,
    simulatedLatencyMs: { capture: 640, insert: 40, keyStroke: 0 },
    note: 'over-budget capture: the measurement must be documented as a budget violation, never hidden',
  },
  {
    key: 'browser-secondary-display',
    app: 'Safari on the second display',
    bundleId: 'com.apple.Safari',
    role: 'AXTextField',
    displayId: 2,
    secure: false,
    editable: true,
    imeComposing: false,
    accessibilityTrust: 'granted',
    screenRecording: 'granted',
    insertMethod: 'clipboard',
    expect: 'insert',
    switchesAwayAfterCommit: false,
    userEditsAfterInsert: false,
    simulatedLatencyMs: { capture: 130, insert: 25, keyStroke: 50 },
    note: 'multiple displays: capture and insertion follow the focused element on display 2',
  },
  {
    key: 'secure-field-login',
    app: 'Safari (login form)',
    bundleId: 'com.apple.Safari',
    role: 'AXSecureTextField',
    displayId: 1,
    secure: true,
    editable: true,
    imeComposing: false,
    accessibilityTrust: 'granted',
    screenRecording: 'granted',
    insertMethod: 'accessibility',
    expect: 'preview_only',
    switchesAwayAfterCommit: false,
    userEditsAfterInsert: false,
    simulatedLatencyMs: { capture: 85, insert: 20, keyStroke: 0 },
    note: 'secure field: preview-only, no write, no screenshot, no clipboard',
  },
  {
    key: 'ime-japanese-composition',
    app: 'Notes (Japanese IME composing)',
    bundleId: 'com.apple.Notes',
    role: 'AXTextArea',
    displayId: 1,
    secure: false,
    editable: true,
    imeComposing: true,
    accessibilityTrust: 'granted',
    screenRecording: 'granted',
    insertMethod: 'accessibility',
    expect: 'preview_only',
    switchesAwayAfterCommit: false,
    userEditsAfterInsert: false,
    simulatedLatencyMs: { capture: 95, insert: 30, keyStroke: 0 },
    note: 'IME state: insertion during an active composition is preview-only until it ends',
  },
  {
    key: 'browser-accessibility-revoked',
    app: 'Safari (Accessibility trust revoked)',
    bundleId: 'com.apple.Safari',
    role: 'AXTextField',
    displayId: 1,
    secure: false,
    editable: true,
    imeComposing: false,
    accessibilityTrust: 'revoked',
    screenRecording: 'granted',
    insertMethod: 'unsupported',
    expect: 'preview_only',
    switchesAwayAfterCommit: false,
    userEditsAfterInsert: false,
    simulatedLatencyMs: { capture: 105, insert: 15, keyStroke: 0 },
    note: 'revoked Accessibility permission: no write attempt at all; report preview-only',
  },
  {
    key: 'crm-screen-recording-denied',
    app: 'Safari (Screen Recording denied)',
    bundleId: 'com.apple.Safari',
    role: 'AXTextField',
    displayId: 1,
    secure: false,
    editable: true,
    imeComposing: false,
    accessibilityTrust: 'granted',
    screenRecording: 'denied',
    insertMethod: 'clipboard',
    expect: 'insert',
    switchesAwayAfterCommit: false,
    userEditsAfterInsert: false,
    simulatedLatencyMs: { capture: 30, insert: 25, keyStroke: 55 },
    note: 'missing context: denied capture is transcript-only, insertion still works',
  },
  {
    key: 'editor-app-switch',
    app: 'TextEdit, then the user switches away',
    bundleId: 'com.apple.TextEdit',
    role: 'AXTextArea',
    displayId: 1,
    secure: false,
    editable: true,
    imeComposing: false,
    accessibilityTrust: 'granted',
    screenRecording: 'granted',
    insertMethod: 'accessibility',
    expect: 'focus_changed',
    switchesAwayAfterCommit: true,
    userEditsAfterInsert: false,
    simulatedLatencyMs: { capture: 95, insert: 35, keyStroke: 0 },
    note: 'app switching: focus moved, so nothing may be written into the new application',
  },
  {
    key: 'editor-user-edit-after-insert',
    app: 'TextEdit (user keeps typing)',
    bundleId: 'com.apple.TextEdit',
    role: 'AXTextArea',
    displayId: 1,
    secure: false,
    editable: true,
    imeComposing: false,
    accessibilityTrust: 'granted',
    screenRecording: 'granted',
    insertMethod: 'accessibility',
    expect: 'insert',
    switchesAwayAfterCommit: false,
    userEditsAfterInsert: true,
    simulatedLatencyMs: { capture: 90, insert: 30, keyStroke: 0 },
    note: 'undo limitation: the user types after insertion, then undo restores the pre-insertion snapshot',
  },
];

/** Surfaces where the user's own clipboard write lands between our paste and any restoration. */
export const USER_CLIPBOARD_CHANGE_SURFACES = ['crm-screen-recording-denied'];

export const MATRIX_SURFACES = RAW_MATRIX_SURFACES.map((surface) => ({
  ...surface,
  userCopiesDuringPaste: USER_CLIPBOARD_CHANGE_SURFACES.includes(surface.key),
}));

const NUMBER_SCAN = /\d+(?:[.,:/-]\d+)*/g;
const FLAG_SCAN = /(?:^|\s)(-{1,2}[A-Za-z][\w-]*)/g;
const NEGATION_SCAN = /\b(?:not|never|no|none|without|except|cannot)\b|n't/gi;
const PATH_SCAN = /[\w.-]+\/[\w./-]+|[\w-]+\.(?:ts|tsx|js|mjs|cjs|json|md|ya?ml|toml|swift|py|sh|css|html|txt)\b/g;
const QUOTED_SCAN = /"[^"]*"|'[^']*'|`[^`]*`/g;

/** The protected-token inventory, mirroring the A02 rules module the implementation must use. */
export function protectedInventory(text) {
  const tokens = [];
  for (const match of text.match(NUMBER_SCAN) ?? []) tokens.push(`number:${match}`);
  for (const match of text.match(FLAG_SCAN) ?? []) tokens.push(`flag:${match.trim()}`);
  for (const match of text.match(NEGATION_SCAN) ?? []) tokens.push(`negation:${match.toLowerCase()}`);
  for (const match of text.match(PATH_SCAN) ?? []) tokens.push(`path:${match}`);
  for (const match of text.match(QUOTED_SCAN) ?? []) tokens.push(`quoted:${match}`);
  return tokens.sort();
}

export function sha256(text) {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

function clauseFor(index, kind) {
  // Trap cases are every tenth case (index % 10 === 3), so `index % CLAUSES.length` would
  // pin every trap to the same clause; the decile index cycles all five protected kinds.
  if (kind === 'protected_trap') return CLAUSES[Math.floor(index / 10) % CLAUSES.length];
  if (kind === 'technical_error' && index % 4 === 0) return CLAUSES[(index + 2) % CLAUSES.length];
  if (kind === 'clean' && index % 2 === 0) return CLAUSES[(index + 1) % CLAUSES.length];
  return null;
}

function caseKind(index) {
  if (index % 10 === 7) return 'clean';
  if (index % 10 === 3) return 'protected_trap';
  return 'technical_error';
}

function buildCase(index) {
  const kind = caseKind(index);
  const clause = clauseFor(index, kind);
  const primary = TERMS[index % TERMS.length];
  const secondary = TERMS[(index + 7) % TERMS.length];
  const primaryTemplate = TEMPLATES[index % TEMPLATES.length];
  const secondaryTemplate = TEMPLATES[(index + 4) % TEMPLATES.length];
  const spokenPrimary = kind === 'clean' ? primary.canonical : primary.spoken;
  const technicalTerms = [];
  const segments = [];

  const push = (rawPart, goldPart) => {
    const start = segments.length === 0 ? 0 : segments.reduce((total, segment) => total + segment.raw.length + 1, 0);
    segments.push({ raw: rawPart, gold: goldPart });
    return start;
  };
  const pushTerm = (term, spoken, template) => {
    const rawPart = template.raw.replace('{spoken}', spoken);
    const goldPart = template.gold.replace('{canonical}', term.canonical);
    const start = push(rawPart, goldPart);
    const spanStart = start + rawPart.indexOf(spoken);
    technicalTerms.push({
      spoken,
      canonical: term.canonical,
      start: spanStart,
      end: spanStart + spoken.length,
    });
  };

  pushTerm(primary, spokenPrimary, primaryTemplate);
  if (kind === 'technical_error' && index % 3 === 0) {
    pushTerm(secondary, secondary.spoken, secondaryTemplate);
  }
  if (clause !== null) push(clause.text, clause.text);

  const rawTranscript = segments.map((segment) => segment.raw).join(' ');
  const goldTranscript = segments.map((segment) => segment.gold).join(' ');
  const clauseStart = clause === null ? -1 : rawTranscript.lastIndexOf(clause.text);
  const trap = clause === null || kind !== 'protected_trap'
    ? null
    : {
      kind: clause.id,
      original: clause.trap.original,
      replacement: clause.trap.replacement,
      start: clauseStart + clause.text.indexOf(clause.trap.original),
      end: clauseStart + clause.text.indexOf(clause.trap.original) + clause.trap.original.length,
    };

  return {
    caseId: `a04-${String(index + 1).padStart(4, '0')}`,
    app: APP_BY_INDEX[index % APP_BY_INDEX.length],
    kind,
    rawTranscript,
    goldTranscript,
    technicalTerms,
    protectedTokens: clause === null ? [] : [clause.trap.original],
    glossary: technicalTerms.map((term) => ({
      term: term.canonical,
      variants: term.spoken === term.canonical ? [] : [term.spoken],
      scope: 'project',
      userConfirmed: true,
      positiveExamples: [goldTranscript],
    })),
    memoryEvidence: [],
    trap,
  };
}

export function buildCorpusDocument() {
  const cases = [];
  for (let index = 0; index < CORPUS_CASE_COUNT; index += 1) cases.push(buildCase(index));
  return {
    contractVersion: CORPUS_CONTRACT_VERSION,
    fixtureId: CORPUS_FIXTURE_ID,
    seed: CORPUS_SEED,
    consent: CORPUS_CONSENT,
    description:
      'Synthetic held-out dictation corpus: 1,000 technical utterances with misheard terms, clean '
      + 'utterances that must stay correct, and protected-token traps a plausible model proposes and '
      + 'the corrector must block. No real audio, no user text, no credentials.',
    caseCount: cases.length,
    surfaces: MATRIX_SURFACES,
    cases,
  };
}

export function corpusDigest(document) {
  return sha256(JSON.stringify({
    contractVersion: document.contractVersion,
    fixtureId: document.fixtureId,
    seed: document.seed,
    caseCount: document.caseCount,
    surfaces: document.surfaces,
    cases: document.cases,
  }));
}

export function loadCorpus() {
  const document = buildCorpusDocument();
  return { ...document, digest: corpusDigest(document) };
}

export function validateCorpus(document) {
  const problems = [];
  const stats = {
    cases: document.cases.length,
    technicalErrorCases: 0,
    cleanCases: 0,
    trapCases: 0,
    termSlots: 0,
    protectedTokenCases: 0,
    surfaces: document.surfaces.length,
  };
  if (document.caseCount !== CORPUS_CASE_COUNT) problems.push(`expected ${CORPUS_CASE_COUNT} cases, found ${document.caseCount}`);
  if (document.cases.length !== CORPUS_CASE_COUNT) problems.push(`expected ${CORPUS_CASE_COUNT} case records, found ${document.cases.length}`);
  const ids = new Set();
  for (const entry of document.cases) {
    if (ids.has(entry.caseId)) problems.push(`duplicate case id ${entry.caseId}`);
    ids.add(entry.caseId);
    stats.termSlots += entry.technicalTerms.length;
    if (entry.kind === 'technical_error') stats.technicalErrorCases += 1;
    if (entry.kind === 'clean') stats.cleanCases += 1;
    if (entry.kind === 'protected_trap') stats.trapCases += 1;
    if (entry.protectedTokens.length > 0) stats.protectedTokenCases += 1;

    if (typeof entry.rawTranscript !== 'string' || entry.rawTranscript.length === 0) problems.push(`${entry.caseId} has no raw transcript`);
    if (typeof entry.goldTranscript !== 'string' || entry.goldTranscript.length === 0) problems.push(`${entry.caseId} has no gold transcript`);
    if (entry.glossary.length !== entry.technicalTerms.length) problems.push(`${entry.caseId} glossary must mirror its term slots`);
    for (const term of entry.technicalTerms) {
      if (entry.rawTranscript.slice(term.start, term.end) !== term.spoken) {
        problems.push(`${entry.caseId} term span ${term.start}:${term.end} does not hold ${JSON.stringify(term.spoken)}`);
      }
      if (entry.kind !== 'clean' && term.spoken === term.canonical) problems.push(`${entry.caseId} expects an error but speaks the canonical form`);
      if (entry.kind !== 'clean' && entry.rawTranscript.includes(term.canonical)) {
        problems.push(`${entry.caseId} raw transcript already contains the canonical form ${term.canonical}`);
      }
      if (!entry.goldTranscript.includes(term.canonical)) problems.push(`${entry.caseId} gold transcript is missing ${term.canonical}`);
    }
    if (entry.kind === 'clean' && entry.rawTranscript !== entry.goldTranscript) {
      problems.push(`${entry.caseId} clean cases must have identical raw and gold transcripts`);
    }
    if (entry.kind !== 'clean' && entry.rawTranscript === entry.goldTranscript) {
      problems.push(`${entry.caseId} must differ from its gold transcript`);
    }
    const inventoryBefore = protectedInventory(entry.rawTranscript);
    const inventoryAfter = protectedInventory(entry.goldTranscript);
    if (inventoryBefore.join('|') !== inventoryAfter.join('|')) {
      problems.push(`${entry.caseId} gold transcript changes protected tokens: ${inventoryBefore.join(',')} -> ${inventoryAfter.join(',')}`);
    }
    for (const token of entry.protectedTokens) {
      if (!entry.rawTranscript.includes(token)) problems.push(`${entry.caseId} protected token ${token} is not in the raw transcript`);
      if (!entry.goldTranscript.includes(token)) problems.push(`${entry.caseId} protected token ${token} is not in the gold transcript`);
    }
    if (entry.kind === 'protected_trap') {
      if (entry.trap === null) {
        problems.push(`${entry.caseId} trap case has no trap`);
      } else {
        if (entry.rawTranscript.slice(entry.trap.start, entry.trap.end) !== entry.trap.original) {
          problems.push(`${entry.caseId} trap span does not hold ${JSON.stringify(entry.trap.original)}`);
        }
        if (entry.trap.original === entry.trap.replacement) problems.push(`${entry.caseId} trap must actually change text`);
        const trapped = `${entry.rawTranscript.slice(0, entry.trap.start)}${entry.trap.replacement}${entry.rawTranscript.slice(entry.trap.end)}`;
        if (protectedInventory(trapped).join('|') === inventoryBefore.join('|')) {
          problems.push(`${entry.caseId} trap is not a protected-token change`);
        }
      }
    } else if (entry.trap !== null) {
      problems.push(`${entry.caseId} only protected_trap cases may carry a trap`);
    }
  }
  const surfaceKeys = new Set();
  for (const surface of document.surfaces) {
    if (surfaceKeys.has(surface.key)) problems.push(`duplicate surface ${surface.key}`);
    surfaceKeys.add(surface.key);
    if (!['insert', 'preview_only', 'focus_changed'].includes(surface.expect)) problems.push(`surface ${surface.key} has an unknown expectation`);
    if (!['accessibility', 'clipboard', 'unsupported'].includes(surface.insertMethod)) problems.push(`surface ${surface.key} has an unknown insert method`);
    if (typeof surface.userCopiesDuringPaste !== 'boolean') problems.push(`surface ${surface.key} must declare whether the user replaces the clipboard during the paste`);
    if (surface.userCopiesDuringPaste === true && surface.insertMethod !== 'clipboard') {
      problems.push(`surface ${surface.key} cannot have a user clipboard change without the clipboard paste fallback`);
    }
  }
  if (!document.surfaces.some((surface) => surface.userCopiesDuringPaste === true)) {
    problems.push('compatibility matrix must model one user clipboard change during the paste fallback');
  }
  if (!document.surfaces.some((surface) => surface.insertMethod === 'clipboard' && surface.userCopiesDuringPaste === false)) {
    problems.push('compatibility matrix must model one clipboard surface whose previous contents are restored');
  }
  const requiredSurfaceTraits = [
    ['terminal', (surface) => surface.app.toLowerCase().includes('iterm')],
    ['browser', (surface) => surface.role.includes('TextField')],
    ['ide', (surface) => surface.bundleId === 'com.microsoft.VSCode'],
    ['secure field', (surface) => surface.secure === true],
    ['multiple displays', (surface) => surface.displayId > 1],
    ['IME state', (surface) => surface.imeComposing === true],
    ['app switching', (surface) => surface.switchesAwayAfterCommit === true],
    ['revoked permission', (surface) => surface.accessibilityTrust === 'revoked'],
    ['denied capture', (surface) => surface.screenRecording === 'denied'],
  ];
  for (const [label, predicate] of requiredSurfaceTraits) {
    if (!document.surfaces.some(predicate)) problems.push(`compatibility matrix has no ${label} surface`);
  }
  if (stats.trapCases < 90) problems.push(`expected at least 90 protected-token traps, found ${stats.trapCases}`);
  if (stats.cleanCases < 90) problems.push(`expected at least 90 clean cases, found ${stats.cleanCases}`);
  if (stats.technicalErrorCases < 700) problems.push(`expected at least 700 technical-error cases, found ${stats.technicalErrorCases}`);
  if (stats.protectedTokenCases < 200) problems.push(`expected at least 200 protected-token cases, found ${stats.protectedTokenCases}`);
  return { problems, stats };
}

function summarize(document, stats) {
  return [
    `a04 held-out corpus: ${stats.cases} cases (${stats.technicalErrorCases} technical-error, ${stats.cleanCases} clean, ${stats.trapCases} protected-token traps)`,
    `term slots: ${stats.termSlots}; cases with protected tokens: ${stats.protectedTokenCases}`,
    `compatibility matrix: ${stats.surfaces} surfaces`,
    `digest: ${document.digest}`,
  ].join('\n');
}

export function runCli(args) {
  const document = loadCorpus();
  const { problems, stats } = validateCorpus(document);
  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ ...document, stats })}\n`);
  } else {
    process.stdout.write(`${summarize(document, stats)}\n`);
    for (const problem of problems) process.stdout.write(`problem: ${problem}\n`);
  }
  return problems.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runCli(process.argv.slice(2));
}
