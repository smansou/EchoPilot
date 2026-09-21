# macOS replay qualification

Two qualifications share this runner. Both write the same fail-closed report shape; only the
measurement source differs.

## Accelerated (default, under ten minutes)

The repeatable qualification for day-to-day work and CI-like checks. It drives the real resource
scheduler (`packages/core/src/scheduler/index.ts`) through a deterministic, time-compressed replay:
eight virtual hours of long-session invariants plus 1,000 events/s bursts, a 100 MiB large-log
stream, a worker crash, simulated sleep/wake, and a network partition.

```sh
ECHOPILOT_BENCH_TARGET=M4_24_GB node scripts/bench-macos/eight-hour-replay.mjs
```

Repeat with `ECHOPILOT_BENCH_TARGET=M2_16_GB` to check the smaller memory profile. Useful overrides:

- `ECHOPILOT_BENCH_MODE` — `accelerated` (default) or `eight_hour`.
- `ECHOPILOT_BENCH_REPORT` — report path (default `artifacts/performance/eight-hour-replay.json`).
- `ECHOPILOT_ACCELERATED_MEASUREMENTS` — measurement file (default `artifacts/performance/accelerated-replay.json`).
- `ECHOPILOT_ACCELERATED_LOG` — driver stdout/stderr log (default `artifacts/performance/accelerated-replay.driver.log`).
- `ECHOPILOT_ALLOW_UNMEASURED_SWAP=1` — report swap as unmeasured instead of failing when the host
  refuses `sysctl -n vm.swapusage`. Unmeasured swap is never reported as a zero or as a pass.

The report records the host model, core count, and physical memory; the eight-hour simulated
duration; wall clock and cold-start time; peak resident memory; queue and spool high-water marks
against their budgets; dropped frames; gapped data by reason; per-scenario recovery outcomes; the
scenario checks behind the verdict; and a counter fingerprint over the deterministic measurements so
two runs of the same seed can be compared directly. Exit code 0 means `qualification: "passed"`.

## Eight-hour

The hardware qualification for a real overnight run. It launches `ECHOPILOT_REPLAY_COMMAND` and
polls `ECHOPILOT_REPLAY_COUNTERS` while it runs.

```sh
ECHOPILOT_BENCH_MODE=eight_hour \
ECHOPILOT_BENCH_TARGET=M4_24_GB \
ECHOPILOT_REPLAY_COMMAND='pnpm replay:realistic' \
ECHOPILOT_REPLAY_COUNTERS=/tmp/echopilot-replay-counters.json \
ECHOPILOT_COLD_START_MS_FILE=/tmp/echopilot-cold-start-ms \
node scripts/bench-macos/eight-hour-replay.mjs
```

The replay process updates the counters JSON with `droppedFrames`, `gappedBytes`,
`audioQueueDepth`, `eventQueueDepth`, and `spoolBytes`.

## Fail-closed rules

`qualification: "passed"` requires all of the following; anything else is `"failed"` with a reason.

- The accelerated measurement file exists and parses, and every counter, memory sample, gap reason,
  required scenario, and recovery outcome is present and well formed. Missing or malformed
  measurements fail the run; they are never read as zero.
- The accelerated driver reports `passed: true` with no scenario failures, all six required
  scenarios ran, and every recovery outcome is `recovered`.
- Every hard budget is inside its limit: duration ≤ 10 minutes (accelerated), audio queue ≤ 64,
  event queue ≤ 256, spool ≤ 512 MiB, resident memory ≤ the target profile, cold start ≤ 15 s.
- No audio callback ran JS/database work or returned a promise; the scheduler never offered the
  spool an over-quota record.
- The eight-hour mode requires a complete run that covers the full eight hours.

Swap is reported as an absolute system high-water mark plus the growth attributable to the run from
a baseline taken just before it. The budget is graded on the attributable growth, because a machine
that has been swapping for hours before the run would otherwise fail a budget for memory this
qualification never touched; the absolute figure and a note are kept in the report.
