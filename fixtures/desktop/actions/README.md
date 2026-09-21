# Desktop action fixtures (C02)

`c02-actions.json` is the deterministic scenario corpus for the C02 voice-action tracer
(`packages/desktop-tools/src/actions/`). It describes one synthetic fixture app whose AX controls
are replayed through the frozen C02 seam, so every property the oracle pins is decidable offline:

- `profileId`, `project` — the explicit project association the action service is configured with.
  Every proposal the oracle drives carries this scope.
- `authorizationTtlMs` — §5.9 confirmation expiry: an authorization is live for at most 30 s.
- `app`, `controls[]` — the synthetic window and its controls: AX `role`, `label`, current `value`,
  `enabled`, `focused`, and the `fingerprint` the resolver captured. The fingerprint stands for the
  bound target identity (app, window, role, label); a replaced control or window changes it.
- `voiceRequest` — the recognized request (`text`) and the affirmative grant utterance
  (`grantText`) that authorize the proposal. The text is a plain label for the oracle; no ASR runs.
- `edit` — the reversible text edit: the action the voice request becomes, the intended field
  (`targetRef`), the requested `value`, and the `untouchedRef` that must keep its value.
- `multiStep` — the same granted field edited in two steps (clear, then retype). Focus stays on the
  step's target, so the second step is preflighted like the first; cancelling between them reports
  the completed and the unexecuted steps and leaves the cleared-but-not-retyped value visible.
- `guards[]` — the mutations applied after the grant and before the next step is preflighted, each
  with the deterministic `reason` the receipt must name:
  - `focus-changed` — focus moved to another control.
  - `target-identity-changed` — the live fingerprint/label no longer match the granted target.
  - `target-disabled` — the granted control reports itself disabled.
  - `grant-expired` — the clock moved one millisecond past the 30 s authorization.
- `verification` — the read-back contract: an AX write the app does not apply is not a completed
  action.

Consumers:

- `packages/desktop-tools/src/actions/c02.acceptance.test.ts` — the C02 acceptance oracle. It loads
  this file, drives the frozen `createDesktopActionService` seam with deterministic doubles, and
  reports the missing behavior while no implementation exists.

Provenance: fully synthetic. No Accessibility traversal, screen recording, application control,
permission prompt, user data, or network call is involved. Times are fixed UTC millisecond values
so replays are byte-stable.

Limitations: this corpus pins the seam, not the hardware. Real AX read/navigate/click/type/select
scope, per-application control trees, the signed helper, and the macOS permission prompts need a
manual qualification pass against TextEdit and the fixture application; that work is recorded by the
tickets that own it and is never claimed from these doubles. The corpus also does not exercise a
consequential (external/destructive) action or a gaze-derived target: those arrive with C03/G02 and
must keep the same grant, fingerprint, and verification rules.
