# Measured limits

EchoPilot publishes its quality targets rather than describing them as "high quality". The frozen
thresholds live in `scripts/release/quality-gates.json`; each gate names the command that measures
it and an evidence file (a held-out corpus or the frozen acceptance test) in this repository. These
are **measured** limits on held-out data, not marketing claims, and CI re-runs every gate command
and requires exit 0.

| Gate | Pillar | Target | What is measured |
| --- | --- | --- | --- |
| `dictation-technical-term-error-reduction` | A | ≥ 0.25 | technical-term error rate on the held-out dictation corpus |
| `dictation-harmful-semantic-edits` | A | ≤ 0.01 | harmful meaning changes on the same corpus |
| `narration-critical-event-recall` | B | ≥ 0.95 | critical events carried into spoken chapters |
| `narration-supported-factual-claims` | B | ≥ 0.98 | spoken claims with direct evidence support |
| `routing-auto-dispatch-precision` | B | ≥ 0.99 | auto-dispatches that reached the intended target |
| `backchannel-precision` | A+B | ≥ 0.95 | acknowledgment sounds emitted at a true backchannel opportunity |
| `temporal-memory-answer-accuracy` | B | ≥ 0.90 | temporal memory answers correct with source support |
| `adversarial-zero-violations` | A+B | = 0 | cross-project disclosures or unintended routes under adversarial input |
| `desktop-scoped-action-authorization` | C | = 0 | unauthorized, containment-smuggling or shell-string desktop command executions over the S04 scoped-execution suite |
| `gaze-read-only-target-precision` | D | ≥ 0.90 | gaze-resolved read-only targets that are the intended control |
| `gaze-deictic-improvement` | D | ≥ 0.10 | deictic improvement of the gaze layer over the same resolver without gaze |
| `gaze-unconfirmed-consequential-actions` | D | = 0 | consequential gaze actions executed without a fresh, target-and-effect-naming confirmation |
| `four-pillar-shared-voice-and-context-budget` | A+B+C+D | ≥ 1 | cross-pillar checks that A–D commit through the one voice layer and assemble inside the one context budget |

## Current measurements

- `routing-auto-dispatch-precision`: 300/300 = 1.000 on the held-out R01 utterance corpus.
- `temporal-memory-answer-accuracy`: 92/92 = 100% correct with source support over the 100-scenario
  memory corpus; degraded scenarios still report their gap rather than fabricating completeness.
- `adversarial-zero-violations`: 8/8 adversarial cases denied with zero disclosures, and no
  adversarial corpus case routes a quoted instruction into an unintended session.

## Limits you should still expect

Thresholds are floors, not guarantees on your own data. Very noisy audio, heavy accents, mixed
languages inside one utterance, and unusual proper nouns can push dictation below the corpus
target; the app flags low-confidence spans instead of guessing. Narration never invents a missing
event — it reports the gap, which can read as terse on sparse sessions. Memory answers are only as
good as what was recorded, and cross-project questions are denied by design even when you know the
answer yourself. Finally, real Developer ID signing, notarization and a clean-Mac run with the
multi-gigabyte vendored weights are human hardware steps performed at release time, not by these
gates.

## Crash-free beta target

The §4.4 reliability target is **crash-free ≥ 99.5% over at least 1,000 beta sessions**, measured
from the real beta session ledger (`{ ledgerVersion, sessions: [{ sessionId, crashed }] }`):

```
node --import tsx scripts/release/qualify-release.mjs reliability --sessions <ledger> --report <file>
```

When the ledger meets the target the leg prints `crash-free: <rate> over <n> sessions`; when it does
not it fails closed with a `problem:` line — a missing or malformed ledger, an empty or duplicate
session id, fewer than 1,000 sessions, or a rate below 0.995. The report records the session count,
the crash-free count, the measured rate, the target and the minimum population, so the measurement
can be re-audited without re-running it.

The synthetic ledger used by the release oracle proves the arithmetic (995 of 1,000 sessions clean =
0.995), but the published target is only ever claimed from the real beta population; a multi-day beta
session population is a human field qualification, not something the automated drill can invent.
