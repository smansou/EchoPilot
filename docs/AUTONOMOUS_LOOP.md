# Autonomous implementation loop

## Start

From the EchoPilot control checkout:

```sh
pnpm install --frozen-lockfile
pnpm loop:policy-test
pnpm loop:start
```

The launcher uses a dedicated integration worktree on `codex/autonomous`, preserves the original `.loop` state and candidates, and shows progress at http://127.0.0.1:4318. The control checkout can hold maintenance changes without dirtying the product integration checkout. Do not edit candidate worktrees while their agents run.

Default test/implementation provider: `deepseek-flash`, max effort, with `CODEX_HOME=/Users/sobhi/.codex-deepseek-worker` and automatic approval review. Default independent reviewer: `gpt-5.6-sol`, high effort, with its separate OpenAI home `/Users/sobhi/.codex`. Credentials remain in those homes, not in this repository. No expensive model continuously supervises the scheduler.

Two active tickets is the default. File ownership and shared manifest reservations can reduce concurrency; that is preferable to repeatedly repairing races. Override `LOOP_MAX_AGENTS` only after observing actual throughput. `LOOP_WORKER_MODEL`, `LOOP_WORKER_EFFORT`, `LOOP_REVIEW_MODEL`, `LOOP_REVIEW_EFFORT`, and the corresponding provider-home variables are explicit controls.

Ctrl-C stops the controller. The next run reconciles retained evidence. Do not launch a second loop against the same state directory. The controller owns a process lock; the dashboard port alone is not the lock.

## Tickets and evidence

`BACKLOG.json` describes product scope. `loop-contracts.json` specifies owned paths, acceptance criteria, check overrides, and non-blocking follow-up boundaries. Broad root manifest access is not implicit: declared shared paths participate in reservations.

Each candidate receives an independent test oracle, implementation, deterministic gates, and independent review. Ordinary repair reuses the frozen oracle. Defective oracles have a separate bounded test-author repair phase with retained prior hashes. Review findings are durable records with stable IDs and explicit resolution evidence. A commit title is never sufficient completion evidence.

After rebase, dependencies are reconciled before checking the candidate. Gates discover all app/package tests rather than only core tests, rerun the frozen ticket command, check generated contracts, typecheck, and build. Changed Swift sources require actual package wiring and native build coverage. Missing native test wiring is reported, not replaced with a mock-success claim.

Provider failures, dependency failures, oracle defects, implementation defects, review findings, and integration failures have distinct recovery paths. Retry delays and attempt limits are bounded. An exhausted ticket is parked while independent work can continue. Auth/credential failures and unresolved safety-critical ambiguity cannot be fabricated away. Quiet reasoning is not a fatal failure; overall invocation deadlines still apply.

## Existing work and release readiness

Six legacy tickets were marked done before this audit. The all-project Node audit passed 43 tests in 14 files, but that alone does not retroactively prove every acceptance criterion. Existing done records without exact-head gate/review evidence are labeled unverified rather than silently reimplemented or rubber-stamped. See `docs/LOOP_REVIEW.md` for known native wiring and memory-encryption deviations.

Run `pnpm release:validate` from the integration checkout for a distinct release gate. It records clean dependency installation, complete discovered tests, contracts/typecheck/build, native coverage, desktop smoke, packaging availability, and ticket-evidence gaps under `.loop/release/report.json`. Missing packaging or native evidence means incomplete, even if every ticket has a commit.

The loop aims for useful unattended progress. It cannot honestly promise that this entire native, voice, gaze, memory, and agent product will be implemented and hardware-qualified in a few hours.

## Local evidence

- `.loop/state.json`: atomic current state.
- `.loop/events.jsonl`: transition history.
- `.loop/runs/`: role output, gate logs, and review evidence.
- `.loop/worktrees/`: retained ticket candidates.
- `.loop/integration/`: clean integration checkout.
- `.loop/audits/`: independent audit output.

All are local and Git-ignored. Do not publicly expose the local dashboard. Publishing follows the existing state setting; accepted commits may remain local when `publish` is false.
