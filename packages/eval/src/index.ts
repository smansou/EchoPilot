/**
 * Q01 fixture replay driver — recorded scenario → deterministic app replay → scored outcome report.
 *
 * Recorded fixtures are untrusted data: `parseScenario` validates the checked-in v1 scenario
 * contract before anything runs, and `replayScenario` replays a validated scenario against fake
 * time, a fake NativeHost, and injected fake providers only. Imported (screenshot/log) content is
 * redacted and quarantined, so it can never reach a tool or alter a grant.
 *
 * The report keeps deterministic correctness, model quality, and human ratings in separate
 * sections. Every deterministic finding cites the exact recorded source events it scored, and the
 * replay never performs a paid or network call.
 */

export const SCENARIO_CONTRACT_VERSION = 1 as const;
export const CONTRACT_VERSION = SCENARIO_CONTRACT_VERSION;

/** Scoring hooks the evaluator must cover, in report order. */
export const REQUIRED_CHECKS = [
  'dictation_edit',
  'factual_claim',
  'routing',
  'attention',
  'memory_evidence',
  'action_receipt',
] as const;
export type CheckId = (typeof REQUIRED_CHECKS)[number];
const CHECK_IDS: ReadonlySet<string> = new Set(REQUIRED_CHECKS);

export type ScenarioTrust = 'user_explicit' | 'tool_observed' | 'agent_reported' | 'imported';
const TRUSTS: readonly ScenarioTrust[] = ['user_explicit', 'tool_observed', 'agent_reported', 'imported'];

export type ScenarioEvent = Readonly<{
  eventId: string;
  at: string;
  kind: string;
  trust: ScenarioTrust;
  text: string;
  data?: Readonly<Record<string, unknown>>;
}>;

export type ScenarioExpectation = Readonly<{
  checkId: CheckId;
  sourceEventId: string;
  expect: Readonly<Record<string, unknown>>;
}>;

export type EvalScenario = Readonly<{
  contractVersion: typeof CONTRACT_VERSION;
  scenarioId: string;
  seed: string;
  consent: string;
  events: readonly ScenarioEvent[];
  expectations: readonly ScenarioExpectation[];
}>;

export type Finding = Readonly<{
  checkId: CheckId;
  status: 'pass' | 'fail';
  sourceEventIds: readonly string[];
  detail: string;
}>;

export type DeterministicReport = Readonly<{
  passed: boolean;
  findings: readonly Finding[];
  toolInvocations: number;
  grantChanges: number;
}>;

export type ModelQualityReport = Readonly<{
  providerIds: readonly string[];
  providerCallCount: number;
  networkCalls: number;
  method: 'injected-fake-providers';
}>;

export type HumanRatingsReport = Readonly<{
  ratings: readonly unknown[];
  source: string;
  note: string;
}>;

export type CostReport = Readonly<{ currency: string; paidCalls: number; providerCallCount: number }>;

export type EvalReport = Readonly<{
  deterministic: DeterministicReport;
  modelQuality: ModelQualityReport;
  humanRatings: HumanRatingsReport;
  costs: CostReport;
}>;

export type EvalRun = Readonly<{
  scenarioId: string;
  seed: string;
  eventTrace: readonly Record<string, unknown>[];
  policyTrace: readonly Record<string, unknown>[];
  report: EvalReport;
}>;

export type ProviderRequest = Readonly<Record<string, unknown>>;
export type EvalProvider = Readonly<{
  providerId: string;
  kind?: string;
  complete(request: ProviderRequest): Promise<{ text: string }>;
}>;

export type ReplayOptions = Readonly<{
  now?: () => Date;
  nativeHost?: unknown;
  providers?: readonly EvalProvider[];
  grants?: readonly Readonly<Record<string, unknown>>[];
}>;

// ---------------------------------------------------------------------------------------------
// Contract validation. Recorded fixtures are data, so malformed or newer revisions are rejected.
// ---------------------------------------------------------------------------------------------

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Expected an object');
  }
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new TypeError('Unexpected property in recorded fixture');
  }
}

function string(value: unknown, field: string, limit: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > limit) {
    throw new TypeError(`Invalid ${field}`);
  }
  return value;
}

function utcTimestamp(value: unknown, field: string): string {
  const timestamp = string(value, field, 32);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp)
    || !Number.isFinite(Date.parse(timestamp))
    || new Date(timestamp).toISOString() !== timestamp) {
    throw new TypeError(`Expected a valid UTC ISO ${field}`);
  }
  return timestamp;
}

function parseScenarioEvent(value: unknown): ScenarioEvent {
  const input = object(value);
  keys(input, ['eventId', 'at', 'kind', 'trust', 'text', 'data']);
  const trust = string(input.trust, 'trust', 32) as ScenarioTrust;
  if (!TRUSTS.includes(trust)) throw new TypeError('Invalid trust');
  const event: ScenarioEvent = {
    eventId: string(input.eventId, 'eventId', 128),
    at: utcTimestamp(input.at, 'at'),
    kind: string(input.kind, 'kind', 64),
    trust,
    text: string(input.text, 'text', 8_192),
  };
  return input.data === undefined ? event : { ...event, data: object(input.data) };
}

function parseExpectation(value: unknown): ScenarioExpectation {
  const input = object(value);
  keys(input, ['checkId', 'sourceEventId', 'expect']);
  const checkId = string(input.checkId, 'checkId', 64);
  if (!CHECK_IDS.has(checkId)) throw new TypeError(`Unknown scoring hook ${checkId}`);
  return {
    checkId: checkId as CheckId,
    sourceEventId: string(input.sourceEventId, 'sourceEventId', 128),
    expect: object(input.expect),
  };
}

/** Validate a recorded fixture against the checked-in v1 scenario contract. */
export function parseScenario(value: unknown): EvalScenario {
  const input = object(value);
  keys(input, ['contractVersion', 'scenarioId', 'seed', 'consent', 'events', 'expectations']);
  if (input.contractVersion !== CONTRACT_VERSION) {
    throw new TypeError(`Unsupported scenario contract version: ${String(input.contractVersion)}`);
  }
  if (!Array.isArray(input.events) || input.events.length === 0) {
    throw new TypeError('A recorded scenario must contain events');
  }
  const events = input.events.map((event) => parseScenarioEvent(event));
  const knownEventIds = new Set<string>();
  for (const event of events) {
    if (knownEventIds.has(event.eventId)) throw new TypeError(`Duplicate scenario event id: ${event.eventId}`);
    knownEventIds.add(event.eventId);
  }
  if (!Array.isArray(input.expectations)) throw new TypeError('Invalid expectations');
  const expectations = input.expectations.map((expectation) => parseExpectation(expectation));
  for (const expectation of expectations) {
    if (!knownEventIds.has(expectation.sourceEventId)) {
      throw new TypeError(`Expectation ${expectation.checkId} cites unknown source event ${expectation.sourceEventId}`);
    }
  }
  return {
    contractVersion: CONTRACT_VERSION,
    scenarioId: string(input.scenarioId, 'scenarioId', 128),
    seed: string(input.seed, 'seed', 128),
    consent: input.consent === undefined ? 'synthetic' : string(input.consent, 'consent', 64),
    events,
    expectations,
  };
}

// ---------------------------------------------------------------------------------------------
// Deterministic replay.
// ---------------------------------------------------------------------------------------------

type NativeHostLike = Readonly<{
  insertText?(transaction: Readonly<{ transactionId: string; text: string }>): Promise<{ transactionId: string; inserted: boolean }>;
  execute?(capability: string, action: Readonly<Record<string, unknown>>): Promise<unknown>;
}>;

type RouteDecision = Readonly<{ destination: string; basis: string }>;
type ClaimScore = Readonly<{ grounded: boolean; evidenceIds: readonly string[]; unsupportedTerms: readonly string[] }>;

type DerivedOutcome = {
  routing: Map<string, RouteDecision | null>;
  dictation: Map<string, Readonly<{ insertedText: string; providerId: string }>>;
  claims: Map<string, ClaimScore>;
  memory: Map<string, Readonly<{ evidenceIds: readonly string[] }>>;
  attention: Map<string, Readonly<{ spoken: boolean }>>;
  receipts: Map<string, Readonly<{ status: string; evidenceIds: readonly string[] }>>;
};

/** Synthetic default authority: a single local-write grant for dictation inserts. */
const DEFAULT_GRANTS: readonly Readonly<Record<string, unknown>>[] = Object.freeze([
  Object.freeze({ grantId: 'grant-synthetic-001', capability: 'insert_text', effect: 'local_write' }),
]);

const ROUTE_PREFIXES: ReadonlyMap<string, string> = new Map([
  ['dictate:', 'dictation'],
  ['companion:', 'companion'],
  ['harness:', 'harness'],
  ['desktop:', 'desktop'],
  ['control:', 'control'],
]);

const STOPWORDS: ReadonlySet<string> = new Set([
  'about', 'after', 'all', 'also', 'and', 'any', 'are', 'because', 'been', 'before', 'being',
  'both', 'but', 'can', 'could', 'each', 'every', 'for', 'from', 'had', 'has', 'have', 'including',
  'into', 'its', 'may', 'might', 'more', 'most', 'must', 'nor', 'not', 'only', 'other', 'our',
  'over', 'should', 'some', 'such', 'than', 'that', 'the', 'their', 'them', 'then', 'these',
  'they', 'this', 'those', 'too', 'very', 'was', 'were', 'what', 'when', 'which', 'while', 'will',
  'with', 'would', 'your',
]);

function normalizeTerm(term: string): string {
  return term.length > 4 && term.endsWith('s') ? term.slice(0, -1) : term;
}

function significantTerms(text: string): string[] {
  const terms = new Set<string>();
  for (const raw of text.toLowerCase().match(/[a-z][a-z0-9_-]+/g) ?? []) {
    if (raw.length < 4 || STOPWORDS.has(raw)) continue;
    terms.add(normalizeTerm(raw));
  }
  return [...terms].sort();
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function explicitPrefix(event: ScenarioEvent): string | null {
  const declared = event.data?.prefix;
  if (typeof declared === 'string' && ROUTE_PREFIXES.has(declared)) return declared;
  const match = /^([a-z]+):/i.exec(event.text.trim());
  const candidate = match?.[1] === undefined ? null : `${match[1].toLowerCase()}:`;
  return candidate !== null && ROUTE_PREFIXES.has(candidate) ? candidate : null;
}

/** Only a user's own explicit utterance can route work or authorize a tool. */
function deriveRoute(event: ScenarioEvent): RouteDecision | null {
  if (event.kind !== 'user_utterance' || event.trust !== 'user_explicit') return null;
  const prefix = explicitPrefix(event);
  if (prefix === null) return null;
  return { destination: ROUTE_PREFIXES.get(prefix)! , basis: 'explicit_prefix' };
}

function evidenceCorpus(evidenceIds: readonly string[], eventsById: ReadonlyMap<string, ScenarioEvent>): string {
  const parts: string[] = [];
  for (const evidenceId of evidenceIds) {
    const evidence = eventsById.get(evidenceId);
    if (evidence === undefined) continue;
    parts.push(evidence.text, JSON.stringify(evidence.data ?? {}));
  }
  return parts.join(' ');
}

function scoreClaim(event: ScenarioEvent, eventsById: ReadonlyMap<string, ScenarioEvent>): ClaimScore {
  const evidenceIds = stringArray(event.data?.evidenceIds);
  const observed = evidenceIds.filter((evidenceId) => eventsById.get(evidenceId)?.trust === 'tool_observed');
  const corpus = new Set(significantTerms(evidenceCorpus(observed, eventsById)));
  const unsupportedTerms = significantTerms(event.text).filter((term) => !corpus.has(term));
  const grounded = observed.length > 0 && observed.length === evidenceIds.length && unsupportedTerms.length === 0;
  return { grounded, evidenceIds, unsupportedTerms };
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function finding(checkId: CheckId, status: 'pass' | 'fail', sourceEventIds: readonly string[], detail: string): Finding {
  return { checkId, status, sourceEventIds, detail };
}

function scoreExpectation(
  expectation: ScenarioExpectation,
  outcome: DerivedOutcome,
  knownEventIds: ReadonlySet<string>,
): Finding {
  const { sourceEventId, expect } = expectation;
  const cite = (...eventIds: readonly string[]): readonly string[] =>
    [...new Set([sourceEventId, ...eventIds.filter((eventId) => knownEventIds.has(eventId))])];

  switch (expectation.checkId) {
    case 'routing': {
      const decision = outcome.routing.get(sourceEventId) ?? null;
      const expectedDestination = typeof expect.destination === 'string' ? expect.destination : null;
      const expectedBasis = typeof expect.basis === 'string' ? expect.basis : null;
      const destination = decision?.destination ?? null;
      const basis = decision?.basis ?? null;
      const matched = destination === expectedDestination && basis === expectedBasis;
      return finding(
        'routing',
        matched ? 'pass' : 'fail',
        cite(),
        matched
          ? `routing matched (${destination ?? 'no route'}${basis === null ? '' : ` via ${basis}`})`
          : `routing expected ${expectedDestination ?? 'no route'}/${expectedBasis ?? 'none'} but derived ${destination ?? 'no route'}/${basis ?? 'none'}`,
      );
    }
    case 'dictation_edit': {
      const derived = outcome.dictation.get(sourceEventId);
      const expectedText = typeof expect.insertedText === 'string' ? expect.insertedText : null;
      const insertedText = derived?.insertedText ?? null;
      const matched = insertedText !== null && insertedText === expectedText;
      return finding(
        'dictation_edit',
        matched ? 'pass' : 'fail',
        cite(),
        matched
          ? 'inserted text matched the recorded correction'
          : `inserted text ${JSON.stringify(insertedText)} did not match ${JSON.stringify(expectedText)}`,
      );
    }
    case 'factual_claim': {
      const derived = outcome.claims.get(sourceEventId);
      const expectedGrounded = expect.grounded === true;
      const grounded = derived?.grounded ?? false;
      const matched = grounded === expectedGrounded;
      return finding(
        'factual_claim',
        matched ? 'pass' : 'fail',
        cite(...(derived?.evidenceIds ?? [])),
        matched
          ? `claim grounding matched (grounded=${grounded})`
          : grounded
            ? 'claim was grounded in observed evidence but the expectation required an ungrounded claim'
            : `claim is ungrounded: no observed evidence covers ${(derived?.unsupportedTerms ?? ['(no evidence cited)']).join(', ')}`,
      );
    }
    case 'memory_evidence': {
      const derived = outcome.memory.get(sourceEventId);
      const expectedIds = stringArray(expect.evidenceIds);
      const actualIds = derived?.evidenceIds ?? [];
      const matched = sameSet(actualIds, expectedIds);
      return finding(
        'memory_evidence',
        matched ? 'pass' : 'fail',
        cite(...actualIds),
        matched
          ? `memory evidence matched (${actualIds.join(', ')})`
          : `memory evidence expected [${expectedIds.join(', ')}] but derived [${actualIds.join(', ')}]`,
      );
    }
    case 'attention': {
      const derived = outcome.attention.get(sourceEventId);
      const expectedSpoken = expect.spoken === true;
      const spoken = derived?.spoken ?? false;
      return finding(
        'attention',
        spoken === expectedSpoken ? 'pass' : 'fail',
        cite(),
        spoken === expectedSpoken
          ? `attention matched (spoken=${spoken})`
          : `attention expected spoken=${expectedSpoken} but derived spoken=${spoken}`,
      );
    }
    case 'action_receipt': {
      const derived = outcome.receipts.get(sourceEventId);
      const expectedStatus = typeof expect.status === 'string' ? expect.status : 'none';
      const status = derived?.status ?? 'none';
      return finding(
        'action_receipt',
        status === expectedStatus ? 'pass' : 'fail',
        cite(...(derived?.evidenceIds ?? [])),
        status === expectedStatus
          ? `action receipt matched (${status})`
          : `action receipt expected ${expectedStatus} but derived ${status}`,
      );
    }
  }
}

/** Replay a validated scenario with fake time, a fake NativeHost, and injected fake providers. */
export async function replayScenario(scenario: EvalScenario, options: ReplayOptions = {}): Promise<EvalRun> {
  const now = options.now ?? (() => new Date());
  const host = (options.nativeHost ?? {}) as NativeHostLike;
  const providers = options.providers ?? [];
  const grants = options.grants ?? DEFAULT_GRANTS;

  const eventsById = new Map<string, ScenarioEvent>(scenario.events.map((event) => [event.eventId, event]));
  const knownEventIds: ReadonlySet<string> = new Set(eventsById.keys());
  const outcome: DerivedOutcome = {
    routing: new Map(),
    dictation: new Map(),
    claims: new Map(),
    memory: new Map(),
    attention: new Map(),
    receipts: new Map(),
  };
  const eventTrace: Record<string, unknown>[] = [];
  const policyTrace: Record<string, unknown>[] = [];
  const calledProviderIds: string[] = [];
  let toolInvocations = 0;
  let grantChanges = 0;

  const policy = (decision: string, subjectEventId: string, detail: string, extra: Record<string, unknown> = {}): void => {
    policyTrace.push({
      sequence: policyTrace.length + 1,
      decision,
      subjectEventId,
      detail,
      at: now().toISOString(),
      ...extra,
    });
  };

  // 1. Ingest: recorded events become a redacted trace. Imported content is data only.
  scenario.events.forEach((event, index) => {
    const redacted = event.trust === 'imported';
    eventTrace.push({
      sequence: index + 1,
      eventId: event.eventId,
      at: event.at,
      kind: event.kind,
      trust: event.trust,
      redacted,
      authorityForActions: event.trust === 'user_explicit',
      text: redacted ? `[redacted ${event.kind} content from ${event.trust} source]` : event.text,
    });
    policy(
      'ingest_event',
      event.eventId,
      redacted
        ? 'imported content quarantined as data; it carries no tool or grant authority'
        : 'recorded event admitted to the scenario trace',
      { trust: event.trust, redacted, authorityForActions: event.trust === 'user_explicit' },
    );
    if (redacted && /grant|tool|instruction/i.test(event.text)) {
      policy('quarantine_injection', event.eventId, 'untrusted content cannot issue grants or call tools', { action: 'ignored' });
    }
  });

  // 2. Routing: only a user's own explicit utterance with a known prefix routes anywhere.
  for (const event of scenario.events) {
    if (event.kind !== 'user_utterance') continue;
    const decision = deriveRoute(event);
    outcome.routing.set(event.eventId, decision);
    policy(
      'route_utterance',
      event.eventId,
      decision === null
        ? 'no explicit prefix; remains with the companion and requires clarification'
        : `routed to ${decision.destination} via ${decision.basis}`,
      { destination: decision?.destination ?? null, basis: decision?.basis ?? null },
    );
  }

  // 3. Dictation edits: provider correction, then a single authorized local insert.
  for (const event of scenario.events) {
    if (outcome.routing.get(event.eventId)?.destination !== 'dictation') continue;
    const provider = providers.find((candidate) => typeof candidate.complete === 'function');
    if (provider === undefined) {
      policy('dictation_correction', event.eventId, 'no injected provider available; correction skipped', { status: 'skipped' });
      continue;
    }
    const response = await provider.complete({ providerId: provider.providerId, purpose: 'dictation_correction', text: event.text });
    calledProviderIds.push(provider.providerId);
    const insertedText = response.text.trim();
    outcome.dictation.set(event.eventId, { insertedText, providerId: provider.providerId });
    policy('dictation_correction', event.eventId, 'corrected by injected fake provider', {
      providerId: provider.providerId,
      paid: false,
      insertedLength: insertedText.length,
    });

    const grant = grants.find((candidate) => candidate.capability === 'insert_text' && candidate.effect === 'local_write');
    if (grant === undefined) {
      policy('authorize_action', event.eventId, 'denied: no grant for insert_text local_write', { capability: 'insert_text', effect: 'local_write', status: 'denied' });
      continue;
    }
    if (typeof host.insertText !== 'function') {
      policy('authorize_action', event.eventId, 'denied: NativeHost cannot insert text', { capability: 'insert_text', status: 'unsupported' });
      continue;
    }
    const transactionId = `tx-${scenario.scenarioId}-${event.eventId}`;
    const receipt = await host.insertText({ transactionId, text: insertedText });
    toolInvocations += 1;
    policy('invoke_native_host', event.eventId, 'insert_text executed under an existing local_write grant', {
      capability: 'insert_text',
      effect: 'local_write',
      grantId: typeof grant.grantId === 'string' ? grant.grantId : null,
      status: receipt?.inserted === false ? 'denied' : 'completed',
    });
  }

  // 4. Claims, memory, attention, and receipts are derived from observed evidence only.
  for (const event of scenario.events) {
    if (event.kind === 'agent_message') {
      const claim = scoreClaim(event, eventsById);
      outcome.claims.set(event.eventId, claim);
      policy(
        'score_claim',
        event.eventId,
        claim.grounded
          ? 'claim grounded in observed evidence'
          : `claim lacks observed evidence for: ${claim.unsupportedTerms.join(', ') || '(no evidence cited)'}`,
        { grounded: claim.grounded, unsupportedTerms: [...claim.unsupportedTerms] },
      );
      const spoken = event.trust === 'agent_reported' && event.text.trim().length > 0;
      outcome.attention.set(event.eventId, { spoken });
      policy('attention_decision', event.eventId, spoken ? 'claim delivered to speech attention gate' : 'no speech requested', { spoken });
    }
    if (event.kind === 'memory') {
      const evidenceIds = stringArray(event.data?.evidenceIds);
      outcome.memory.set(event.eventId, { evidenceIds });
      policy('memory_query', event.eventId, `memory evidence resolved (${evidenceIds.join(', ')})`, {
        evidenceIds: [...evidenceIds],
        observed: evidenceIds.every((evidenceId) => eventsById.has(evidenceId)),
      });
    }
    if (event.kind === 'action' && event.trust === 'tool_observed') {
      const declared = event.data?.status;
      const status = declared === 'completed' || declared === 'denied' ? declared : 'unsupported';
      const evidenceIds = stringArray(event.data?.evidenceIds);
      outcome.receipts.set(event.eventId, { status, evidenceIds });
      policy('record_action_receipt', event.eventId, `recorded action receipt ${status}`, { status, evidenceIds: [...evidenceIds] });
    }
  }

  // 5. Score every expectation against the derived outcome; failures cite their source events.
  const findings = scenario.expectations.map((expectation) => scoreExpectation(expectation, outcome, knownEventIds));
  const failures = findings.filter((entry) => entry.status === 'fail');

  const report: EvalReport = {
    deterministic: {
      passed: failures.length === 0,
      findings,
      toolInvocations,
      grantChanges,
    },
    modelQuality: {
      providerIds: [...new Set(calledProviderIds)],
      providerCallCount: calledProviderIds.length,
      networkCalls: 0,
      method: 'injected-fake-providers',
    },
    humanRatings: {
      ratings: [],
      source: 'none',
      note: 'synthetic fixture: human ratings are collected separately and never inferred from model output',
    },
    costs: {
      currency: 'USD',
      paidCalls: 0,
      providerCallCount: calledProviderIds.length,
    },
  };

  return {
    scenarioId: scenario.scenarioId,
    seed: scenario.seed,
    eventTrace,
    policyTrace,
    report,
  };
}
