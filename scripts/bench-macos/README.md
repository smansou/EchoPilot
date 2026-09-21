# Eight-hour macOS replay qualification

Run the same realistic replay twice, once on an M4/24 GB Mac and once on an M2/16 GB Mac. The
runner keeps samples and the final report separate so a failed or interrupted qualification still
preserves evidence.

```sh
ECHOPILOT_BENCH_TARGET=M4_24_GB \
ECHOPILOT_REPLAY_COMMAND='pnpm replay:realistic' \
ECHOPILOT_REPLAY_COUNTERS=/tmp/echopilot-replay-counters.json \
ECHOPILOT_COLD_START_MS_FILE=/tmp/echopilot-cold-start-ms \
bun scripts/bench-macos/eight-hour-replay.mjs
```

Repeat with `ECHOPILOT_BENCH_TARGET=M2_16_GB`. The replay process updates the counters JSON with
`droppedFrames`, `gappedBytes`, `audioQueueDepth`, `eventQueueDepth`, and `spoolBytes`. Reports also
record cold-start time, resident memory, swap behavior, early exits, and failed hardware
qualification; missing measurements fail rather than being reported as passes.
