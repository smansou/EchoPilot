# C04 day-replay fixture (`c04-day-replay.json`)

Synthetic corpus for the C04 acceptance tests:

- `packages/desktop-tools/src/history/c04.acceptance.test.ts` (service-level day replay)
- `packages/capture/src/sampling/c04.sampling.test.ts` (frequency/energy/stop probe)

## Provenance

Every application name, bundle id, window title, document reference, summary sentence, question,
answer and preloaded memory entry is written by hand for this fixture. Nothing was captured from a
real screen, window, application, account or credential, and no real user text or screenshot
belongs here. `rawCanary` exists only so a test can assert that no raw-frame bytes were persisted;
it is not real content.

## Replay model

The desktop test expands each `phases[]` entry into observations at `stepMs` from `beginsAt`
(exclusive of `endsAt`), grouping every `changeEveryTicks` observations into one content revision:

- The observation identity (change signature) is
  `app.bundleId | documentRef | focusedControl | windowTitle | contentRevision`, so a new revision
  is a change and a repeated revision inside one phase is a no-change observation.
- `workSession` is the only window in which history is on. `editor-evening-session` lies after
  `endsAt` and pins "off by default outside an explicit work session".
- `excludedBundleIds` are refused before capture. `vault-lunch` (40 observations of 1Password)
  pins "an excluded application never reaches the raw boundary, the model or memory".
- `checkpoints` are the three flush instants of the replay; the desktop test ingests everything
  pending at each checkpoint plus once at the end of the day, which is what produces one memory
  batch per checkpoint rather than one per observation.
- `questions[]` are the later-recall probes. Each answer carries one deliberately invented
  evidence id (`mem-helios-1`), and that id belongs to `preloadedMemory` under another project
  (`helios`). The desktop test first proves that an unscoped memory query returns that note, then
  proves the scoped recall path never lets it survive into an answer.

## Sampling policy

| field | value | why |
| --- | --- | --- |
| `minIntervalMs` | 60000 | no two captures closer than a minute |
| `maxCapturesPerHour` | 8 | rolling hour cap |
| `maxEnergyMsPerDay` | 8000 | rolling 24 h energy budget |
| `captureCostMs` | 400 | modelled cost of one capture/segment |

Busy phases (`changeEveryTicks` 1-4) would yield 102 unthrottled change groups inside the work
session, which is why the day must show throttling; `browser-midday-read` changes once and then
holds still for two hours, so the tests can pin a window with zero captures and zero model calls.

`samplerProbe` are isolated, timestamp-offset cases with the same policy shape (the energy case
uses a smaller day budget so the budget binds quickly):

- `frequencyCase` — min interval twice and the rolling hour cap once produce `throttled/frequency`;
  the change blocked by the min interval is retried and admitted at exactly 60 s, and the change
  blocked by the hour cap is admitted once the rolling window moves past the old captures.
- `energyCase` — two admitted captures exhaust the 800 ms day budget, the next two changes report
  `throttled/energy`, and the same signature is admitted after the 24 h window frees the budget.
- `stopCase` — `stop()` is permanent and idempotent: even a changed signature afterwards reports
  `stopped`.

## Limitations

These tests drive in-process fakes of the capture boundary, the memory store, the model boundary
and the replay clock. They do not exercise real ScreenCaptureKit/Accessibility capture, TCC
permission prompts, OS-level energy metering, or live model calls; those need the signed helper and
a manual qualification pass on a real Mac and are not claimed by this fixture. The fixture is a
deterministic, hardware-free oracle for the scoping, throttling, purge and recall semantics only.

Regenerating: the corpus is byte-stable by construction (UTC instants, integer steps). Any edit to
the phase table or policy must keep the invariants above true, and both acceptance test files must
be re-run.
