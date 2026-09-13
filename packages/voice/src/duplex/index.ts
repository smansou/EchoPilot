/**
 * V03 — narration + overlapping user speech → backchannel or interruption → correct continuation.
 *
 * This controller is the duplex policy between the V02 playback session (what is audible) and the
 * user's overlapping speech. The native pipeline (VAD → AEC → ASR → prosody) reports one event pair
 * per overlapping utterance: a non-echo acoustic onset as soon as the microphone hears speech over
 * the narration, and the classification evidence once ASR has a stable result. The Section 4.4
 * budgets are measured on the same monotonic clock as those events, so the controller never reads
 * wall time: a device switch invalidates one calibration, not the policy.
 *
 * Policy (Section 5.5), verified by the frozen oracle `acceptance.test.ts` against the held-out
 * subset in `fixtures/duplex/`:
 *   1. Onset — duck the audible narration by 18 dB inside 100 ms without moving the playback cursor,
 *      and keep the generation epoch. Only non-echo onsets reach this method, and every duck is
 *      resolved by the evidence submitted for that utterance.
 *   2. Explicit stop — a local stop phrase, or `stopSpeaking()` from the hotkey/local spotter,
 *      silences the narration inside 200 ms and cancels the generation epoch. The utterance is
 *      committed for routing, but managed agent work is untouched: only `submitAgentControl` from
 *      the addressee router reaches the harness.
 *   3. Backchannel — a brief acknowledgement while no confirmation is pending and no new request
 *      follows restores the narration over a 40 ms fade from the preserved cursor and is never
 *      committed as a request.
 *   4. Interruption and uncertainty — pause the narration inside 350 ms and commit the utterance for
 *      routing. Uncertainty is the conservative default for low-confidence, empty or truncated
 *      evidence; pausing keeps the cursor and the epoch so the turn continues at the next complete
 *      relevant segment.
 *
 * Section 4.4 hardware numbers (AEC, microphone, speaker/headphone route) remain a reference-machine
 * qualification measurement; this module owns and keeps deterministic the decision half of them.
 */

export type DuplexRoute = 'speaker' | 'headphones';
export type BargeInOutcome = 'backchannel' | 'interruption' | 'explicit_stop' | 'uncertain';
export type DuplexOutputState = 'idle' | 'speaking' | 'ducked' | 'paused' | 'stopped';

/** One committed overlapping utterance as the native VAD/ASR/prosody pipeline observed it. */
export type UserSpeechEvidence = Readonly<{
  utteranceId: string;
  route: DuplexRoute;
  durationMs: number;
  transcript: string;
  asrConfidence: number;
  prosody: Readonly<{ energyDb: number; voicedRatio: number; pitchSpanSemitones: number }>;
  confirmationPending: boolean;
  newRequestFollows: boolean;
}>;

/** What the duplex policy decided for one utterance, and what the device was told. */
export type DuplexDecision = Readonly<{
  utteranceId: string;
  outcome: BargeInOutcome;
  decidedAtMs: number;
  /** A backchannel is heard, not routed; every other outcome is committed for routing. */
  committed: boolean;
  output: DuplexOutputState;
  /** Where narration continues; `null` when the generation epoch was cancelled. */
  resumeCursorMs: number | null;
}>;

/** One separately routed agent-control request (Section 5.6), at most once per `requestId`. */
export type AgentControlRequest = Readonly<{ requestId: string; turnId: string; reason: string }>;

export type AgentControlReceipt = Readonly<{
  requestId: string;
  turnId: string;
  /** Only what the adapter observed: a timed-out or failed delivery is explicitly `unknown`. */
  status: 'acknowledged' | 'unknown';
}>;

/** The audible narration boundary (native playback graph / V02 playback session). */
export type DuplexOutputPort = Readonly<{
  speaking(): boolean;
  cursorMs(): number;
  duck(levelDb: number): void;
  restore(fadeMs: number): void;
  pause(): void;
  stop(): void;
}>;

/** The managed-harness control port (the Section 5.3 adapter boundary). */
export type DuplexAgentPort = Readonly<{
  interrupt(request: Readonly<{ turnId: string; reason: string }>): Promise<'acknowledged' | 'unknown'>;
}>;

export type DuplexController = Readonly<{
  noteSpeechOnset(onset: Readonly<{ utteranceId: string; route: DuplexRoute; atMs: number }>): void;
  submitUserSpeech(evidence: UserSpeechEvidence): Promise<DuplexDecision>;
  stopSpeaking(): Promise<void>;
  submitAgentControl(request: AgentControlRequest): Promise<AgentControlReceipt>;
  status(): Readonly<{ output: DuplexOutputState; cursorMs: number }>;
}>;

export type DuplexControllerOptions = Readonly<{
  clock: Readonly<{ now(): number }>;
  output: DuplexOutputPort;
  agent: DuplexAgentPort;
}>;

/** Section 5.5 step 1: attenuation applied to narration while the user speaks. */
export const DUCK_LEVEL_DB = -18;
/** Section 5.5 step 4: fade used to restore narration after a backchannel. */
export const RESTORE_FADE_MS = 40;

/**
 * Below this ASR confidence the evidence is not classifiable and the controller pauses instead of
 * guessing — the same floor a brief acknowledgement needs before it counts as a backchannel.
 */
export const MIN_CLASSIFIABLE_CONFIDENCE = 0.8;
/** A longer utterance is never a backchannel, whatever its transcript (Section 5.5 step 3). */
export const BACKCHANNEL_MAX_DURATION_MS = 900;
/** A brief utterance that is shouted is far more likely a real interruption than a backchannel. */
const AGITATED_ENERGY_DB = -18;
const AGITATED_PITCH_SPAN_SEMITONES = 8;

/**
 * A long conversation must not grow the controller without bound. Onsets are correlated with their
 * evidence and dropped then; the decision and receipt memories only need to cover a redelivery that
 * follows its original within the same session, so the oldest entries are retired past the limit.
 */
const MAX_TRACKED_ONSETS = 64;
const MAX_REMEMBERED_DECISIONS = 256;
const MAX_REMEMBERED_RECEIPTS = 512;

/**
 * Section 5.5 step 3: the acknowledgements the dialogue layer treats as backchannels, matched on the
 * normalized transcript. Short durational fillers ("mm", "hm") are included because the duration and
 * confirmation gates below reject the cases where they are instead a truncated start of speech.
 */
const BACKCHANNEL_PHRASES: ReadonlySet<string> = new Set([
  'mm',
  'mm hm',
  'mmhm',
  'mhm',
  'hm',
  'hmm',
  'uh huh',
  'uhuh',
  'okay',
  'ok',
  'right',
  'alright',
  'sure',
  'yeah',
  'yep',
  'yes',
  'got it',
  'i see',
  'go on',
  'nice',
]);

/**
 * The explicit local stop phrases of the spotter. They are exact phrases on purpose: "stop that" or
 * "stop the build" is an interruption or an instruction, not a request to silence the narration.
 */
const STOP_PHRASE_PATTERNS: ReadonlyArray<RegExp> = [
  /^(?:please )?stop(?: speaking| talking| the narration| narration)?$/,
  /^(?:be )?quiet(?: please)?$/,
  /^silence$/,
  /^hush$/,
  /^shut up$/,
];

/**
 * Trailing function words that cannot end a complete utterance: the ASR result was cut mid-phrase,
 * so acting on it would act on a fragment (Section 5.5 step 4 — truncated evidence is uncertain).
 */
const CONTINUATION_TAIL_TOKENS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'the',
  'we',
  'i',
  'to',
  'of',
  'and',
  'but',
  'so',
  'with',
  'for',
  'is',
  'was',
  'were',
  'are',
  'do',
  'does',
  'did',
  'be',
  'been',
  'have',
  'has',
  'had',
  'if',
  'when',
  'while',
  'because',
  'my',
  'your',
  'our',
  'their',
  'its',
  "don't",
  "doesn't",
  "didn't",
  "can't",
  "won't",
]);

/** Lower-cases, unifies apostrophes and hyphens, and drops punctuation the classifier ignores. */
function normalizeTranscript(transcript: string): string {
  return transcript
    .toLowerCase()
    .replace(/[\u2018\u2019]/gu, "'")
    .replace(/[^a-z0-9'\s-]/gu, ' ')
    .replace(/-+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function isLocalStopPhrase(normalized: string): boolean {
  return STOP_PHRASE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isTruncatedEvidence(normalized: string): boolean {
  const tokens = normalized.split(' ');
  const last = tokens[tokens.length - 1];
  return last !== undefined && CONTINUATION_TAIL_TOKENS.has(last);
}

function isBackchannelEvidence(evidence: UserSpeechEvidence, normalized: string): boolean {
  if (evidence.confirmationPending || evidence.newRequestFollows) return false;
  if (evidence.durationMs > BACKCHANNEL_MAX_DURATION_MS) return false;
  if (evidence.asrConfidence < MIN_CLASSIFIABLE_CONFIDENCE) return false;
  if (!BACKCHANNEL_PHRASES.has(normalized)) return false;
  if (evidence.prosody.energyDb > AGITATED_ENERGY_DB) return false;
  if (evidence.prosody.pitchSpanSemitones > AGITATED_PITCH_SPAN_SEMITONES) return false;
  return true;
}

/**
 * The classification of one overlapping utterance (Section 5.5 steps 3-4). Uncertainty is checked
 * before the stop spotter on purpose: a low-confidence "stop speaking" pauses narration — which the
 * user can repeat — instead of cancelling a generation that was never really asked to stop.
 */
export function classifyOverlappingSpeech(evidence: UserSpeechEvidence): BargeInOutcome {
  const transcript = normalizeTranscript(evidence.transcript);
  if (transcript.length === 0) return 'uncertain';
  if (evidence.asrConfidence < MIN_CLASSIFIABLE_CONFIDENCE) return 'uncertain';
  if (isTruncatedEvidence(transcript)) return 'uncertain';
  if (isLocalStopPhrase(transcript)) return 'explicit_stop';
  if (isBackchannelEvidence(evidence, transcript)) return 'backchannel';
  return 'interruption';
}

/** Everything a later redelivery of the same utterance must match before it is answered from cache. */
function evidenceSignature(evidence: UserSpeechEvidence): string {
  return JSON.stringify([
    evidence.route,
    evidence.durationMs,
    evidence.transcript,
    evidence.asrConfidence,
    evidence.prosody.energyDb,
    evidence.prosody.voicedRatio,
    evidence.prosody.pitchSpanSemitones,
    evidence.confirmationPending,
    evidence.newRequestFollows,
  ]);
}

/** Inserts into a bounded FIFO map: the oldest key is retired once the limit is exceeded. */
function rememberBounded<K, V>(map: Map<K, V>, key: K, value: V, limit: number): void {
  map.set(key, value);
  while (map.size > limit) {
    const [oldest] = map.keys();
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/**
 * Builds the duplex controller. The returned object never touches the managed agent except through
 * `submitAgentControl`, so overlapped speech — including a spoken "stop speaking" — cannot end or
 * cancel a turn on its own.
 */
export function createDuplexController(options: DuplexControllerOptions): DuplexController {
  const { clock, output, agent } = options;

  /** What this controller last told the device to do; reconciled with the port in `status()`. */
  let state: DuplexOutputState = 'idle';
  /** True while a duck is outstanding: the narration is audible but attenuated by this controller. */
  let ducked = false;
  const onsets = new Map<string, Readonly<{ route: DuplexRoute; atMs: number }>>();
  const decisions = new Map<string, Readonly<{ signature: string; decision: DuplexDecision }>>();
  const receipts = new Map<string, AgentControlReceipt>();
  const deliveriesInFlight = new Map<string, Promise<AgentControlReceipt>>();

  /**
   * The device port owns audibility: a plan that ended, or one this controller did not see start, is
   * reported as it actually is instead of as the last intent here.
   */
  const observedState = (): DuplexOutputState => {
    if (state === 'paused' || state === 'stopped') return state;
    if (!output.speaking()) return 'idle';
    return ducked ? 'ducked' : 'speaking';
  };

  const noteSpeechOnset = (onset: Readonly<{ utteranceId: string; route: DuplexRoute; atMs: number }>): void => {
    if (!onsets.has(onset.utteranceId)) {
      rememberBounded(
        onsets,
        onset.utteranceId,
        { route: onset.route, atMs: onset.atMs },
        MAX_TRACKED_ONSETS,
      );
    }
    // Ducking an already ducked or silent narration would report a second onset duck that never
    // happened, and ducking a paused/stopped plan would move audio the user is not hearing.
    if (ducked || !output.speaking()) return;
    output.duck(DUCK_LEVEL_DB);
    ducked = true;
    state = 'ducked';
    // The 100 ms budget is measured from `atMs`; a late event still ducks rather than leaking
    // narration at full volume, and the caller records the latency.
  };

  const silenceNarration = (): void => {
    // Pausing a cancelled epoch would resurrect narration the user already stopped.
    if (state === 'stopped') return;
    output.pause();
    ducked = false;
    state = 'paused';
  };

  const cancelNarration = (): void => {
    if (state === 'stopped') return;
    output.stop();
    ducked = false;
    state = 'stopped';
  };

  const submitUserSpeech = async (evidence: UserSpeechEvidence): Promise<DuplexDecision> => {
    const signature = evidenceSignature(evidence);
    const remembered = decisions.get(evidence.utteranceId);
    if (remembered !== undefined && remembered.signature === signature) {
      return remembered.decision;
    }
    // The onset and its evidence are correlated: the duck has been resolved by this decision.
    onsets.delete(evidence.utteranceId);

    const outcome = classifyOverlappingSpeech(evidence);
    let resumeCursorMs: number | null;
    if (outcome === 'backchannel') {
      // Restore from the preserved cursor: the cursor never moved while ducked, so narration
      // continues instead of restarting.
      resumeCursorMs = ducked ? output.cursorMs() : null;
      if (ducked) {
        output.restore(RESTORE_FADE_MS);
        ducked = false;
        state = 'speaking';
      }
    } else if (outcome === 'explicit_stop') {
      cancelNarration();
      resumeCursorMs = null;
    } else {
      silenceNarration();
      resumeCursorMs = state === 'paused' ? output.cursorMs() : null;
    }

    const decision: DuplexDecision = {
      utteranceId: evidence.utteranceId,
      outcome,
      decidedAtMs: clock.now(),
      committed: outcome !== 'backchannel',
      output: state,
      resumeCursorMs,
    };
    rememberBounded(decisions, evidence.utteranceId, { signature, decision }, MAX_REMEMBERED_DECISIONS);
    return decision;
  };

  /** The explicit local stop control (hotkey / local spotter); it never reaches the harness. */
  const stopSpeaking = async (): Promise<void> => {
    onsets.clear();
    cancelNarration();
  };

  /**
   * One routed agent-control request. Only this method interrupts managed work, a redelivered
   * `requestId` is delivered at most once, and the receipt reports only the observed result.
   */
  const submitAgentControl = async (request: AgentControlRequest): Promise<AgentControlReceipt> => {
    const delivered = receipts.get(request.requestId);
    if (delivered !== undefined) return delivered;
    const inFlight = deliveriesInFlight.get(request.requestId);
    if (inFlight !== undefined) return inFlight;

    const deliver = async (): Promise<AgentControlReceipt> => {
      let status: AgentControlReceipt['status'] = 'unknown';
      try {
        status = await agent.interrupt({ turnId: request.turnId, reason: request.reason });
      } catch {
        // A failed or timed-out delivery stays explicitly unknown, and the receipt is cached so a
        // redelivery cannot send the interrupt twice.
        status = 'unknown';
      }
      const receipt: AgentControlReceipt = {
        requestId: request.requestId,
        turnId: request.turnId,
        status,
      };
      rememberBounded(receipts, request.requestId, receipt, MAX_REMEMBERED_RECEIPTS);
      return receipt;
    };

    const delivery = deliver().finally(() => { deliveriesInFlight.delete(request.requestId); });
    deliveriesInFlight.set(request.requestId, delivery);
    return delivery;
  };

  const status = (): Readonly<{ output: DuplexOutputState; cursorMs: number }> => ({
    output: observedState(),
    cursorMs: output.cursorMs(),
  });

  return { noteSpeechOnset, submitUserSpeech, stopSpeaking, submitAgentControl, status };
}
