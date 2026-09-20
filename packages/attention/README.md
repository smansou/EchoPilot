# @echopilot/attention

One attention policy for proactive speech (IMPLEMENTATION_PLAN.md §5.7): events from any pillar —
`capture`, `harness`, `memory`, `narration`, `desktop`, `gaze`, `voice`, … — enter as speech
candidates and leave as receipts that say *spoken*, *suppressed*, *deferred* or *visual*.

```ts
import { createAttentionPolicy } from './src/index.js';

const policy = createAttentionPolicy({ now: () => clock(), settings: { preset: 'focused-work' } });

const [receipt] = policy.submit({
  candidateId: 'turn-1-summary',
  sourceId: 'narration',
  eventClass: 'turn-complete',
  eventId: 'ev-turn-1',
  turnId: 'turn-1',
});
if (receipt?.outcome === 'deferred') {
  // later, once the gaps open:
  for (const decision of policy.tick()) startPlayback(decision);
}
```

## Rules

- **Only a lease authorizes audio.** A `spoken` receipt carries the `SpeechLease` the §5.3 seam
  checks (`canSpeak`); a producer holding the durable event id can ask for the same grant with
  `requestSpeech(eventId, expiresAt)`. Grants are bounded (30 s), and `muted`, explicit
  `outputSilence`, `revokeSpeech`, expiry and preemption all revoke live grants immediately, so a
  playback adapter that re-checks `canSpeak` per chunk drops late audio instead of talking on.
- **Silence is absolute.** `muted` (the stop control) and `outputSilence` suppress every class,
  blocking events included; mute additionally drops anything queued, because a stop is not a queue.
- **Nothing talks over the user.** While an utterance is open every candidate waits; blocking and
  important-failure events speak at the next safe gap (immediately when the user is not speaking,
  within 3 s of the utterance ending, observed by ticking), and preempt routine speech with an
  `interrupted` receipt while the earlier `spoken` receipt stays in the append-only trail.
  Turn-complete summaries wait for the 750 ms quiet gap and are replaced per turn before they speak.
- **Routine digests pace themselves.** They obey the preset cooldown (focused-work 120 s,
  hands-free 30 s, or the `cooldownSeconds` override) and are suppressed, never queued, inside it.
- **Receipts explain themselves.** Every receipt carries an `explanation` and the `setting` that
  governed it (`preset`, `outputSilence`, `muted`, `eventPriorities`, `cooldownSeconds`) or `null`,
  so the settings surface can say why an update spoke or stayed silent. `settings()` exposes the
  resolved values, and the renderer half lives in
  `apps/desktop/src/renderer/control/attention/attention-surface.ts`.
- **Deterministic.** Time comes only from the injected clock, so the same event stream yields the
  same receipts on every replay.

The versioned stream `fixtures/attention/r02-pillar-stream.json` and its oracle
`packages/attention/test/r02.acceptance.test.ts` pin these rules; real TTS, audio devices,
microphone capture and duplex barge-in belong to their own tickets.
