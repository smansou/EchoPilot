# A04 dictation qualification

Run the held-out accuracy and insertion matrix with:

```sh
node --import tsx --test packages/eval/src/dictation/a04.acceptance.test.ts
node fixtures/dictation/check-a04-corpus.mjs --summary
```

The checked-in fixture is synthetic and deterministic: 1,000 utterances, 1,267 technical-term
slots, 100 clean cases and 100 protected-token traps. Its frozen digest is
`sha256:d397be76b0f47a84c95ba1b2143e92a2bcc94242aaee720f137ae5bab22bef16`. The acceptance oracle
recomputes the scores from raw and inserted text. On this fixture it requires all 1,167 baseline
term errors to be corrected (100% reduction), zero harmful protected-token edits (0% of cases), and
no edits to the clean cases. These are synthetic held-out results, not a microphone or model-weight
qualification.

## Reproducible insertion measurements

The compatibility matrix uses an injected monotonic clock and fixed per-surface native-double costs
from the corpus. The frozen oracle derives measurements from `beginUtterance()` and the actual
controller write call; it does not use wall-clock timing:

| Measurement | Samples | p50 | p95 | Maximum | Gate |
| --- | ---: | ---: | ---: | ---: | --- |
| Capture bundle | 12 surfaces | 95 ms | 640 ms | 640 ms | p95 ≤ 500 ms; one over-budget surface is reported |
| Insertion write | 8 successful writes | 45 ms | 80 ms | 80 ms | p50 ≤ 1,500 ms and p95 ≤ 3,000 ms |

Percentiles use nearest rank: `sorted[min(n − 1, ceil(q·n) − 1)]`. Insertion measures the write
operation only (Accessibility write, or clipboard paste plus paste chord); it excludes ASR and
correction-model time. These numbers describe deterministic doubles, not desktop latency.

When Screen Recording is denied, dictation produces a transcript-only preview with no screenshot or
context bundle and can still insert into the revalidated focused target. The report gives one
missing-context measurement per matrix surface, including preview mode, insertion result and
redaction counts where a bundle exists. Secure fields, active IME composition, revoked Accessibility
trust, and focus changes preserve the draft and do not write or synthesize keys. The controller
enforces the first three directly on `insert()`, rather than relying on its caller to skip insertion.

Undo is single-level. The measured first undo restores the pre-insertion snapshot, so text typed
after dictation is also discarded; a second undo has no effect. Undo covers only this insertion
transaction, while the application maintains its own separate undo stack. The matrix report records
these outcomes and limitations for every relevant surface.

The signed macOS helper, real TCC permission prompts, real IME behavior, microphone/ASR, model
latency, and physical multi-display behavior still require qualification on a signed desktop build.
