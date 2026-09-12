# @echopilot/eval — fixture replay driver (Q01)

`src/index.ts` replays a recorded v1 scenario (see `fixtures/q01/`) with fake time, a fake
NativeHost, and injected fake providers, then emits a report whose deterministic correctness, model
quality, and human ratings stay in separate sections.

## Read this before trusting a report

- **Deterministic default clock.** `replayScenario` with no `options.now` uses a clock anchored to
  the scenario's earliest recorded event timestamp, so the same seed/fixture always produces the
  same event and policy traces. An injected clock (`options.now`) is used verbatim and is the
  caller's responsibility to keep deterministic.
- **`grantChanges` is a computed diff.** It is the number of authority entries added, removed, or
  modified in the grant set the replay consulted, snapshotted before and after the run. `0` means
  the run genuinely left the grant set untouched.
- **The reference scenario intentionally fails one check.** `fixtures/q01/dictation-to-result.json`
  records an `agent_message` (`claim-001`) whose claimed grounding is stronger than its cited
  evidence, and the `factual_claim` expectation is set to fail it. With the injected fake provider
  used by the acceptance test, `factual_claim` is the only failing hook and
  `deterministic.passed === false` is the expected, correct outcome. (Without a provider the
  `dictation_edit` hook also fails, because the correction is skipped.) A model grading its own
  ungrounded answer is never treated as sufficient validation.
