# fixtures/duplex — V03 held-out overlapping-speech subset

`v03-held-out-exchanges.json` is the frozen synthetic corpus behind the V03 acceptance oracle
(`packages/voice/src/duplex/acceptance.test.ts`). It stores no user audio and no personal data:
every exchange is evidence in the shape the native VAD / ASR / prosody pipeline reports while
narration is audible (Section 5.5), stamped with the timing of a warm Section 4.4 reference run.

The oracle expands the spec into exactly 200 exchanges — 25 repetitions of the 8-exchange
`pattern` — alternating the `speaker` and `headphones` routes of the reference machine. Ground
truth lives in `classes`; the oracle rebuilds the evidence field by field and hands the controller
only `utteranceId`, `route`, `durationMs`, `transcript`, `asrConfidence`, `prosody`,
`confirmationPending` and `newRequestFollows`, so no label is visible to the implementation.

`classificationPolicy` is what the labels encode (Section 5.5 step 3): a brief acknowledgment is a
backchannel only while no confirmation is pending and no new request follows; low-confidence,
empty or truncated evidence is uncertain and pauses output; stop phrases are explicit stops;
everything else — negations, corrections, confirmation answers, speech that continues into a new
request — is an interruption. `prosody` samples are deterministic values inside the declared
ranges and are deliberately not label-bearing.
