# @echopilot/routing

Deterministic addressee routing for spoken follow-ups (IMPLEMENTATION_PLAN.md §5.6): the front
door every utterance passes through before anything dispatches.

```ts
import { AUTO_DISPATCH_MIN_CONFIDENCE, createAddresseeRouter } from './src/index.js';

const router = createAddresseeRouter({ sessions });
const decision = router.route({ utteranceId, text, asrConfidence, partial });
```

## Rules

- `"tell/ask/message <addressee> to <task>"` resolves the addressee against the active sessions by
  label, session id, or a harness name that matches exactly one active session, and returns
  `destination: 'harness'` with `basis: 'explicit_prefix'` and
  `confidence >= AUTO_DISPATCH_MIN_CONFIDENCE` (0.95).
- Anything less specific — a harness with two matching sessions, "the session", a pronoun, a
  dangling referent — returns `requiresClarification: true` with candidate session ids and no
  target, so the companion can ask and nothing dispatches.
- Questions that name no addressee stay with the companion. Dictation, desktop, and control
  intents route to their own destinations, and the `dictate:`/`companion:`/`harness:`/`desktop:`/
  `control:` prefixes declare a destination explicitly.
- Partial transcripts and ambient acknowledgments ("yes", "okay", "go ahead") are returned as
  holds (`hold: 'partial_asr' | 'ambient_acknowledgment'`): not actionable, never auto-dispatched.

The task clause is never scanned for a destination, so `"tell Codex tests to rerun the failing
parser test"` reaches codex-tests. Held-out auto-dispatch precision is measured by
`fixtures/routing/r01-held-out-utterances.json` through the R01 acceptance oracle.
