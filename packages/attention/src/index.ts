/**
 * R02 — events from any pillar → one attention policy → speech / suppression / resumption receipt
 * (IMPLEMENTATION_PLAN.md §5.7; the frozen oracle is
 * `packages/attention/test/r02.acceptance.test.ts`, the event stream is
 * `fixtures/attention/r02-pillar-stream.json`).
 *
 * Pillars (`capture`, `harness`, `memory`, `narration`, `desktop`, `gaze`, `voice`, …) submit
 * candidates; this policy is the only granter of proactive speech and no source is special-cased.
 * The invariants it owns:
 *
 *   - Audio needs a §5.3 `SpeechLease`. A `spoken` receipt carries one, and `requestSpeech` hands
 *     the same grant back to a producer that holds the durable event id. `canSpeak` accepts only
 *     the exact lease object this policy issued, so a reconstructed or fabricated lease is inert.
 *   - Silence is absolute: `muted` and `outputSilence` suppress every class (blocking included),
 *     mute revokes live grants immediately, `revokeSpeech` and lease expiry behave the same, and a
 *     playback adapter that re-checks `canSpeak` before every chunk therefore drops late audio.
 *   - Blocking and important-failure events speak at the next safe gap: immediately when the user
 *     is not speaking, otherwise as soon as the utterance ends, and at the latest within the 3 s
 *     safe gap a caller observes by ticking. They preempt live routine-class speech (turn-complete,
 *     routine-progress, background-session) with an `interrupted` receipt; the earlier `spoken`
 *     receipt stays in the append-only trail.
 *   - Nothing talks over the user's open utterance. Turn-complete summaries additionally wait for
 *     the 750 ms quiet gap, a newer summary for the same turn replaces one that has not spoken yet,
 *     and routine digests obey the preset cooldown (focused-work 120 s, hands-free 30 s, or the
 *     `cooldownSeconds` override). A digest inside its cooldown is suppressed, never queued.
 *   - Every receipt cites the setting that governed it (`setting`) or `null`, and carries a
 *     human-readable `explanation` naming the preset, cooldown, silence rule or override, so the UI
 *     can explain why an update was spoken, suppressed, deferred or resumed.
 *
 * Determinism: the policy reads time only from the injected clock, never from the ambient clock,
 * and every receipt's `decidedAt` is the injected instant — the same event stream produces the same
 * receipts on every replay. `'coalesced'` remains reserved for the queue-arbitration ticket; this
 * policy does not fuse candidates.
 */
import type { SpeechLease } from '../../contracts/src/index.js';

export type AttentionPreset = 'focused-work' | 'hands-free' | 'critical-only' | 'presentation';

export type AttentionEventClass =
  | 'user-requested'
  | 'blocking'
  | 'important-failure'
  | 'turn-complete'
  | 'routine-progress'
  | 'background-session';

export type AttentionPriority = 'blocking' | 'important' | 'routine' | 'visual';

export type AttentionSettingKey = 'preset' | 'outputSilence' | 'muted' | 'eventPriorities' | 'cooldownSeconds';

export type AttentionSettings = Readonly<{
  preset: AttentionPreset;
  /** Explicit output silence; independent of `muted`; never bypassed by any event class. */
  outputSilence: boolean;
  /** The stop/mute control: nothing speaks and nothing queues while it is on. */
  muted: boolean;
  /** User raise/lower of one class; `'visual'` means that class is never spoken. */
  eventPriorities?: Readonly<Partial<Record<AttentionEventClass, AttentionPriority>>>;
  /** User override of the routine-progress digest cooldown. */
  cooldownSeconds?: number;
}>;

export type SpeechCandidate = Readonly<{
  candidateId: string;
  sourceId: string;
  eventClass: AttentionEventClass;
  eventId: string;
  sessionId?: string;
  turnId?: string;
  contentKey?: string;
}>;

export type AttentionOutcome =
  | 'spoken'
  | 'deferred'
  | 'suppressed'
  | 'visual'
  | 'coalesced'
  | 'replaced'
  | 'interrupted';

export type AttentionReason =
  | 'turn-complete-quiet-gap'
  | 'routine-digest'
  | 'important-failure-decision'
  | 'blocking-safe-gap'
  | 'user-requested-reply'
  | 'user-speaking-safe-gap'
  | 'quiet-gap-not-elapsed'
  | 'cooldown-active'
  | 'explicit-output-silence'
  | 'muted'
  | 'preset-visual-only'
  | 'priority-override-visual'
  | 'replaced-stale-completion'
  | `interrupted-by-${AttentionEventClass}`;

export type AttentionDecision = Readonly<{
  candidateId: string;
  eventId: string;
  sourceId: string;
  eventClass: AttentionEventClass;
  outcome: AttentionOutcome;
  reason: AttentionReason;
  explanation: string;
  setting: AttentionSettingKey | null;
  decidedAt: string;
  lease?: SpeechLease;
}>;

export type PendingCandidate = Readonly<{
  candidateId: string;
  eventId: string;
  eventClass: AttentionEventClass;
  reason: AttentionReason;
  /** When the candidate entered the queue; stable while it stays deferred. */
  deferredAt: string;
}>;

export type CreateAttentionPolicyOptions = Readonly<{
  /** Deterministic clock; defaults to the system clock. */
  now?: () => Date;
  settings?: Partial<AttentionSettings>;
}>;

export type AttentionPolicy = Readonly<{
  /**
   * Read-only snapshot of the resolved settings. Surfaces that must explain a decision (the
   * renderer's attention/settings view) read the governing values here instead of re-deriving the
   * preset defaults, so there is exactly one source of truth.
   */
  settings(): AttentionSettings;
  updateSettings(patch: Partial<AttentionSettings>): void;
  submit(candidate: SpeechCandidate): ReadonlyArray<AttentionDecision>;
  tick(): ReadonlyArray<AttentionDecision>;
  userSpeechStarted(): void;
  userSpeechEnded(): void;
  /**
   * The §5.3 seam for a producer holding a durable event id. `expiresAt` is the caller's requested
   * bound; authority stays with the grant this policy minted, which is what the playback layer
   * re-checks, so the returned lease is the live grant itself (or `null`).
   */
  requestSpeech(eventId: string, expiresAt: string): SpeechLease | null;
  canSpeak(lease: SpeechLease): boolean;
  revokeSpeech(reason: string): void;
  decisions(): ReadonlyArray<AttentionDecision>;
  pending(): ReadonlyArray<PendingCandidate>;
}>;

/* ------------------------------------------------------------------ settings tables --- */

/** §5.7: every grant is bounded — 30 s is the coordinator's default lease window. */
export const MAX_LEASE_MS = 30_000;
/** Turn-complete summaries wait for this much quiet after the user's utterance. */
export const QUIET_GAP_MS = 750;
/** Blocking and important-failure events speak at the next safe gap, at the latest 3 s after it. */
export const SAFE_GAP_MS = 3_000;

const BUCKET_RANK: Readonly<Record<AttentionPriority, number>> = {
  visual: 0,
  routine: 1,
  important: 2,
  blocking: 3,
};

/**
 * Base priority per preset. The preset decides which classes may speak at all and how the routine
 * lane is paced; `eventPriorities` raises or lowers one class on top of it.
 */
const PRESET_PRIORITIES: Readonly<Record<AttentionPreset, Readonly<Record<AttentionEventClass, AttentionPriority>>>> = {
  'focused-work': {
    'user-requested': 'important',
    blocking: 'blocking',
    'important-failure': 'important',
    'turn-complete': 'routine',
    'routine-progress': 'routine',
    'background-session': 'visual',
  },
  'hands-free': {
    'user-requested': 'important',
    blocking: 'blocking',
    'important-failure': 'important',
    'turn-complete': 'routine',
    'routine-progress': 'routine',
    'background-session': 'routine',
  },
  'critical-only': {
    'user-requested': 'important',
    blocking: 'blocking',
    'important-failure': 'important',
    'turn-complete': 'visual',
    'routine-progress': 'visual',
    'background-session': 'visual',
  },
  presentation: {
    'user-requested': 'visual',
    blocking: 'visual',
    'important-failure': 'visual',
    'turn-complete': 'visual',
    'routine-progress': 'visual',
    'background-session': 'visual',
  },
};

/** Routine-digest cooldown per preset, in seconds. */
const PRESET_COOLDOWN_SECONDS: Readonly<Record<AttentionPreset, number>> = {
  'focused-work': 120,
  'hands-free': 30,
  'critical-only': 120,
  presentation: 120,
};

type MutableSettings = {
  preset: AttentionPreset;
  outputSilence: boolean;
  muted: boolean;
  eventPriorities: Readonly<Partial<Record<AttentionEventClass, AttentionPriority>>> | undefined;
  cooldownSeconds: number | undefined;
};

function resolveSettings(patch: Partial<AttentionSettings> | undefined): MutableSettings {
  const defaults: MutableSettings = {
    preset: 'focused-work',
    outputSilence: false,
    muted: false,
    eventPriorities: undefined,
    cooldownSeconds: undefined,
  };
  if (patch === undefined) return defaults;
  return {
    preset: patch.preset ?? defaults.preset,
    outputSilence: patch.outputSilence ?? defaults.outputSilence,
    muted: patch.muted ?? defaults.muted,
    eventPriorities: patch.eventPriorities === undefined ? undefined : { ...patch.eventPriorities },
    cooldownSeconds: patch.cooldownSeconds ?? undefined,
  };
}

function applySettingsPatch(current: MutableSettings, patch: Partial<AttentionSettings>): MutableSettings {
  return {
    preset: patch.preset ?? current.preset,
    outputSilence: patch.outputSilence ?? current.outputSilence,
    muted: patch.muted ?? current.muted,
    eventPriorities: patch.eventPriorities === undefined ? current.eventPriorities : { ...patch.eventPriorities },
    cooldownSeconds: patch.cooldownSeconds === undefined ? current.cooldownSeconds : patch.cooldownSeconds,
  };
}

function normalizeCandidate(candidate: SpeechCandidate): SpeechCandidate {
  return {
    candidateId: candidate.candidateId,
    sourceId: candidate.sourceId,
    eventClass: candidate.eventClass,
    eventId: candidate.eventId,
    ...(candidate.sessionId === undefined ? {} : { sessionId: candidate.sessionId }),
    ...(candidate.turnId === undefined ? {} : { turnId: candidate.turnId }),
    ...(candidate.contentKey === undefined ? {} : { contentKey: candidate.contentKey }),
  };
}

/** Two candidates describe the same turn when both carry the same turn id in the same session. */
function sameTurn(left: SpeechCandidate, right: SpeechCandidate): boolean {
  if (left.turnId === undefined || right.turnId === undefined) return false;
  if (left.turnId !== right.turnId) return false;
  if (left.sessionId !== undefined && right.sessionId !== undefined && left.sessionId !== right.sessionId) return false;
  return true;
}

/** The lane a class speaks in: turn summaries wait for quiet, digests pace themselves, urgent speaks now. */
function spokenReason(eventClass: AttentionEventClass): AttentionReason {
  switch (eventClass) {
    case 'user-requested':
      return 'user-requested-reply';
    case 'blocking':
      return 'blocking-safe-gap';
    case 'important-failure':
      return 'important-failure-decision';
    case 'turn-complete':
      return 'turn-complete-quiet-gap';
    case 'routine-progress':
    case 'background-session':
      return 'routine-digest';
  }
}

type Evaluation =
  | Readonly<{ outcome: 'spoken'; reason: AttentionReason; explanation: string; setting: AttentionSettingKey | null }>
  | Readonly<{ outcome: 'deferred'; reason: AttentionReason; explanation: string }>
  | Readonly<{ outcome: 'suppressed'; reason: AttentionReason; explanation: string; setting: AttentionSettingKey }>
  | Readonly<{ outcome: 'visual'; reason: AttentionReason; explanation: string; setting: AttentionSettingKey }>;

type PendingEntry = {
  candidate: SpeechCandidate;
  reason: AttentionReason;
  deferredAt: string;
};

type Grant = {
  candidate: SpeechCandidate;
  bucket: AttentionPriority;
  lease: SpeechLease;
  revoked: boolean;
};

type ReceiptBase = {
  candidateId: string;
  eventId: string;
  sourceId: string;
  eventClass: AttentionEventClass;
  outcome: AttentionOutcome;
  reason: AttentionReason;
  explanation: string;
  setting: AttentionSettingKey | null;
  decidedAt: string;
};

function decision(base: ReceiptBase, lease?: SpeechLease): AttentionDecision {
  return lease === undefined ? base : { ...base, lease };
}

/* ------------------------------------------------------------------ the policy --- */

export function createAttentionPolicy(options: CreateAttentionPolicyOptions = {}): AttentionPolicy {
  const clock = options.now ?? ((): Date => new Date());
  const clockMs = (): number => clock().getTime();

  let settings = resolveSettings(options.settings);
  let userSpeaking = false;
  /** End of the user's last utterance; the quiet-gap and safe-gap clocks start there. */
  let quietGapStartMs: number | null = null;
  /** When the last routine digest actually spoke; the cooldown is measured from it. */
  let lastDigestSpokenMs: number | null = null;
  let epoch = 0;

  const trail: AttentionDecision[] = [];
  const pending = new Map<string, PendingEntry>();
  /** Live grants, by event and by candidate. One candidate holds at most one grant. */
  const grantsByEvent = new Map<string, Grant>();
  const grantsByCandidate = new Map<string, Grant>();

  const append = (receipt: AttentionDecision): AttentionDecision => {
    trail.push(receipt);
    return receipt;
  };

  const dropGrant = (candidateId: string): void => {
    const grant = grantsByCandidate.get(candidateId);
    if (grant === undefined) return;
    grant.revoked = true;
    grantsByCandidate.delete(candidateId);
    if (grantsByEvent.get(grant.lease.eventId) === grant) grantsByEvent.delete(grant.lease.eventId);
  };

  const revokeAllGrants = (): void => {
    for (const grant of grantsByCandidate.values()) grant.revoked = true;
    grantsByCandidate.clear();
    grantsByEvent.clear();
  };

  /** The live grant for an event, or `null` when it is revoked, superseded, expired or silenced. */
  const liveGrant = (eventId: string, nowMs: number): Grant | null => {
    const grant = grantsByEvent.get(eventId);
    if (grant === undefined || grant.revoked) return null;
    if (settings.muted || settings.outputSilence) return null;
    const expiry = Date.parse(grant.lease.expiresAt);
    if (!Number.isFinite(expiry) || expiry <= nowMs) return null;
    return grant;
  };

  const quietGapRemainingMs = (nowMs: number): number => {
    if (quietGapStartMs === null) return 0;
    return Math.max(0, QUIET_GAP_MS - (nowMs - quietGapStartMs));
  };

  const effectiveBucket = (eventClass: AttentionEventClass): Readonly<{ bucket: AttentionPriority; overrideApplied: boolean }> => {
    const override = settings.eventPriorities?.[eventClass];
    if (override !== undefined) return { bucket: override, overrideApplied: true };
    return { bucket: PRESET_PRIORITIES[settings.preset][eventClass], overrideApplied: false };
  };

  const withOverride = (explanation: string, eventClass: AttentionEventClass, bucket: AttentionPriority, overrideApplied: boolean): string => {
    if (!overrideApplied) return explanation;
    return `${explanation} The eventPriorities override moves ${eventClass} to ${bucket} priority.`;
  };

  const evaluate = (
    candidate: SpeechCandidate,
    bucket: AttentionPriority,
    overrideApplied: boolean,
    nowMs: number,
  ): Evaluation => {
    if (bucket === 'visual') {
      if (overrideApplied) {
        return {
          outcome: 'visual',
          reason: 'priority-override-visual',
          explanation: `The eventPriorities override marks ${candidate.eventClass} as visual, so it is shown without audio.`,
          setting: 'eventPriorities',
        };
      }
      return {
        outcome: 'visual',
        reason: 'preset-visual-only',
        explanation: `The ${settings.preset} preset keeps ${candidate.eventClass} updates visual instead of speaking them.`,
        setting: 'preset',
      };
    }
    if (settings.muted) {
      return {
        outcome: 'suppressed',
        reason: 'muted',
        explanation: 'The assistant is muted, so this update is neither spoken nor queued.',
        setting: 'muted',
      };
    }
    if (settings.outputSilence) {
      return {
        outcome: 'suppressed',
        reason: 'explicit-output-silence',
        explanation: 'Explicit output silence is on, so this update is suppressed and never spoken.',
        setting: 'outputSilence',
      };
    }
    if (userSpeaking) {
      return {
        outcome: 'deferred',
        reason: 'user-speaking-safe-gap',
        explanation: 'The user is speaking, so this update waits for the safe gap before it can be spoken.',
      };
    }
    if (candidate.eventClass === 'turn-complete' && quietGapRemainingMs(nowMs) > 0) {
      return {
        outcome: 'deferred',
        reason: 'quiet-gap-not-elapsed',
        explanation: `The user's utterance ended less than ${QUIET_GAP_MS} ms ago, so this turn summary waits for the quiet gap.`,
      };
    }
    const reason = spokenReason(candidate.eventClass);
    if (reason === 'routine-digest' && bucket === 'routine') {
      const overrideSeconds = settings.cooldownSeconds;
      const seconds = overrideSeconds ?? PRESET_COOLDOWN_SECONDS[settings.preset];
      const setting: AttentionSettingKey = overrideSeconds === undefined ? 'preset' : 'cooldownSeconds';
      if (lastDigestSpokenMs !== null && nowMs - lastDigestSpokenMs < seconds * 1_000) {
        const sinceSeconds = Math.round((nowMs - lastDigestSpokenMs) / 1_000);
        const rule = overrideSeconds === undefined
          ? `The ${settings.preset} preset holds routine digests on a ${seconds} s cooldown`
          : `The cooldownSeconds override sets a ${seconds} s routine-digest cooldown`;
        return {
          outcome: 'suppressed',
          reason: 'cooldown-active',
          explanation: `${rule}; the last digest spoke ${sinceSeconds} s ago, so this one stays visual instead of being queued.`,
          setting,
        };
      }
    }
    return {
      outcome: 'spoken',
      reason,
      explanation: withOverride(spokenExplanation(candidate, reason), candidate.eventClass, bucket, overrideApplied),
      setting: overrideApplied ? 'eventPriorities' : null,
    };
  };

  function spokenExplanation(candidate: SpeechCandidate, reason: AttentionReason): string {
    switch (reason) {
      case 'turn-complete-quiet-gap':
        return 'The turn finished and the user has been quiet for the 750 ms quiet gap, so the summary is spoken.';
      case 'routine-digest':
        return 'The floor is free and no routine digest has spoken inside the cooldown window, so this digest is spoken.';
      case 'blocking-safe-gap':
        return 'A blocking request speaks at the next safe gap, and the user is not speaking.';
      case 'important-failure-decision':
        return 'An important failure that needs a decision speaks at the next safe gap.';
      case 'user-requested-reply':
        return 'The user asked for this reply and the floor is free, so it is spoken.';
      default:
        return `${candidate.eventClass} is authorized to speak and the floor is free.`;
    }
  }

  /** A newer summary for the same turn replaces a stale one that has not spoken yet. */
  const replaceStaleCompletions = (candidate: SpeechCandidate, nowMs: number, decidedAt: string): AttentionDecision[] => {
    if (candidate.eventClass !== 'turn-complete') return [];
    const replaced: AttentionDecision[] = [];
    for (const [candidateId, entry] of [...pending]) {
      if (candidateId === candidate.candidateId) continue;
      if (!sameTurn(entry.candidate, candidate)) continue;
      pending.delete(candidateId);
      replaced.push(append(decision({
        candidateId: entry.candidate.candidateId,
        eventId: entry.candidate.eventId,
        sourceId: entry.candidate.sourceId,
        eventClass: entry.candidate.eventClass,
        outcome: 'replaced',
        reason: 'replaced-stale-completion',
        explanation: `A newer summary for turn ${candidate.turnId ?? 'unknown'} arrived before this one was spoken, so the stale completion was replaced.`,
        setting: null,
        decidedAt,
      })));
    }
    for (const [candidateId, grant] of [...grantsByCandidate]) {
      if (candidateId === candidate.candidateId) continue;
      if (!sameTurn(grant.candidate, candidate)) continue;
      if (liveGrant(grant.lease.eventId, nowMs) === null) {
        dropGrant(candidateId);
        continue;
      }
      dropGrant(candidateId);
      replaced.push(append(decision({
        candidateId: grant.candidate.candidateId,
        eventId: grant.candidate.eventId,
        sourceId: grant.candidate.sourceId,
        eventClass: grant.candidate.eventClass,
        outcome: 'replaced',
        reason: 'replaced-stale-completion',
        explanation: `A newer summary for turn ${candidate.turnId ?? 'unknown'} replaced the stale completion while it was speaking.`,
        setting: null,
        decidedAt,
      })));
    }
    return replaced;
  };

  /** Speaking a higher-priority update revokes the live routine-class grants it preempts. */
  const interruptLowerPriority = (
    candidate: SpeechCandidate,
    bucket: AttentionPriority,
    nowMs: number,
    decidedAt: string,
  ): AttentionDecision[] => {
    const interrupted: AttentionDecision[] = [];
    for (const [candidateId, grant] of [...grantsByCandidate]) {
      if (BUCKET_RANK[grant.bucket] >= BUCKET_RANK[bucket]) continue;
      if (liveGrant(grant.lease.eventId, nowMs) === null) {
        dropGrant(candidateId);
        continue;
      }
      dropGrant(candidateId);
      interrupted.push(append(decision({
        candidateId: grant.candidate.candidateId,
        eventId: grant.candidate.eventId,
        sourceId: grant.candidate.sourceId,
        eventClass: grant.candidate.eventClass,
        outcome: 'interrupted',
        reason: `interrupted-by-${candidate.eventClass}`,
        explanation: `A ${candidate.eventClass} update preempted this ${grant.candidate.eventClass} update before it finished speaking.`,
        setting: null,
        decidedAt,
      })));
    }
    return interrupted;
  };

  const speak = (
    candidate: SpeechCandidate,
    bucket: AttentionPriority,
    evaluation: Extract<Evaluation, { outcome: 'spoken' }>,
    nowMs: number,
    decidedAt: string,
  ): AttentionDecision[] => {
    const interrupted = interruptLowerPriority(candidate, bucket, nowMs, decidedAt);
    dropGrant(candidate.candidateId);
    epoch += 1;
    const lease: SpeechLease = {
      eventId: candidate.eventId,
      epoch,
      expiresAt: new Date(nowMs + MAX_LEASE_MS).toISOString(),
    };
    const receipt = append(decision({
      candidateId: candidate.candidateId,
      eventId: candidate.eventId,
      sourceId: candidate.sourceId,
      eventClass: candidate.eventClass,
      outcome: 'spoken',
      reason: evaluation.reason,
      explanation: evaluation.explanation,
      setting: evaluation.setting,
      decidedAt,
    }, lease));
    const grant: Grant = { candidate, bucket, lease, revoked: false };
    grantsByCandidate.set(candidate.candidateId, grant);
    grantsByEvent.set(candidate.eventId, grant);
    pending.delete(candidate.candidateId);
    if (evaluation.reason === 'routine-digest') lastDigestSpokenMs = nowMs;
    return [...interrupted, receipt];
  };

  const settle = (
    candidate: SpeechCandidate,
    bucket: AttentionPriority,
    evaluation: Exclude<Evaluation, { outcome: 'spoken' }>,
    decidedAt: string,
  ): AttentionDecision[] => {
    dropGrant(candidate.candidateId);
    if (evaluation.outcome === 'deferred') {
      pending.set(candidate.candidateId, { candidate, reason: evaluation.reason, deferredAt: decidedAt });
      return [append(decision({
        candidateId: candidate.candidateId,
        eventId: candidate.eventId,
        sourceId: candidate.sourceId,
        eventClass: candidate.eventClass,
        outcome: 'deferred',
        reason: evaluation.reason,
        explanation: evaluation.explanation,
        setting: null,
        decidedAt,
      }))];
    }
    pending.delete(candidate.candidateId);
    return [append(decision({
      candidateId: candidate.candidateId,
      eventId: candidate.eventId,
      sourceId: candidate.sourceId,
      eventClass: candidate.eventClass,
      outcome: evaluation.outcome,
      reason: evaluation.reason,
      explanation: evaluation.explanation,
      setting: evaluation.setting,
      decidedAt,
    }))];
  };

  const measure = (candidate: SpeechCandidate, nowMs: number, decidedAt: string): AttentionDecision[] => {
    const { bucket, overrideApplied } = effectiveBucket(candidate.eventClass);
    const evaluation = evaluate(candidate, bucket, overrideApplied, nowMs);
    if (evaluation.outcome === 'spoken') return speak(candidate, bucket, evaluation, nowMs, decidedAt);
    return settle(candidate, bucket, evaluation, decidedAt);
  };

  return Object.freeze({
    settings(): AttentionSettings {
      return {
        preset: settings.preset,
        outputSilence: settings.outputSilence,
        muted: settings.muted,
        ...(settings.eventPriorities === undefined
          ? {}
          : { eventPriorities: { ...settings.eventPriorities } }),
        ...(settings.cooldownSeconds === undefined ? {} : { cooldownSeconds: settings.cooldownSeconds }),
      };
    },

    updateSettings(patch: Partial<AttentionSettings>): void {
      const next = applySettingsPatch(settings, patch);
      const muteEngaged = !settings.muted && next.muted;
      const silenceEngaged = !settings.outputSilence && next.outputSilence;
      settings = next;
      if (muteEngaged) {
        revokeAllGrants();
        pending.clear();
      } else if (silenceEngaged) {
        revokeAllGrants();
      }
    },

    submit(candidate: SpeechCandidate): ReadonlyArray<AttentionDecision> {
      const normalized = normalizeCandidate(candidate);
      const nowMs = clockMs();
      const decidedAt = new Date(nowMs).toISOString();
      const produced = replaceStaleCompletions(normalized, nowMs, decidedAt);
      produced.push(...measure(normalized, nowMs, decidedAt));
      return produced;
    },

    tick(): ReadonlyArray<AttentionDecision> {
      const nowMs = clockMs();
      if (settings.muted || settings.outputSilence) return [];
      const decidedAt = new Date(nowMs).toISOString();
      const produced: AttentionDecision[] = [];
      for (const [candidateId, entry] of [...pending]) {
        const { bucket, overrideApplied } = effectiveBucket(entry.candidate.eventClass);
        const evaluation = evaluate(entry.candidate, bucket, overrideApplied, nowMs);
        if (evaluation.outcome === 'deferred') {
          entry.reason = evaluation.reason;
          continue;
        }
        produced.push(...measure(entry.candidate, nowMs, decidedAt));
      }
      return produced;
    },

    userSpeechStarted(): void {
      userSpeaking = true;
      revokeAllGrants();
    },

    userSpeechEnded(): void {
      userSpeaking = false;
      quietGapStartMs = clockMs();
    },

    requestSpeech(eventId: string): SpeechLease | null {
      const grant = liveGrant(eventId, clockMs());
      return grant === null ? null : grant.lease;
    },

    canSpeak(lease: SpeechLease): boolean {
      const grant = liveGrant(lease.eventId, clockMs());
      return grant !== null && grant.lease === lease;
    },

    revokeSpeech(_reason: string): void {
      revokeAllGrants();
    },

    decisions(): ReadonlyArray<AttentionDecision> {
      return [...trail];
    },

    pending(): ReadonlyArray<PendingCandidate> {
      return [...pending.values()].map((entry) => ({
        candidateId: entry.candidate.candidateId,
        eventId: entry.candidate.eventId,
        eventClass: entry.candidate.eventClass,
        reason: entry.reason,
        deferredAt: entry.deferredAt,
      }));
    },
  });
}
