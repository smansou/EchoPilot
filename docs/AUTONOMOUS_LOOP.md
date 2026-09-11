# Autonomous implementation handoff

The project is implemented from `BACKLOG.json` by `scripts/loop.mjs`. Do not give one long-lived model the entire implementation plan and ask it to remember progress. The loop creates a fresh context per bounded role and keeps durable state in Git plus `.loop/state.json`.

## Before the first run

1. Review and commit the current orchestration cleanup. The integration checkout must be clean because accepted ticket branches are fast-forwarded into it.
2. Install dependencies with `pnpm install --frozen-lockfile`.
3. Configure the Codex CLI to use the desired provider and verify that `codex exec -m deepseek-flash "Reply with ready"` succeeds. The loop intentionally reads normal CLI configuration so a non-OpenAI provider can be used.
4. Run `pnpm loop:self-test`, `pnpm check`, and `pnpm smoke`.
5. Inspect the schedule with `LOOP_MODEL=deepseek-flash pnpm loop:dry`.

## Run

```sh
LOOP_MODEL=deepseek-flash LOOP_MAX_AGENTS=10 pnpm loop
```

Open `http://127.0.0.1:4318` for read-only status. Stop with Ctrl-C; the next run recovers tickets that were active when the process stopped.

`LOOP_MAX_AGENTS=0` removes the policy cap. The dependency graph and declared file ownership still prevent conflicting tickets from running together. Full checks and merges are serialized. Start with 10 and lower it only if API throttling, memory pressure, or local installation contention reduces throughput.

## Useful controls

- `LOOP_MODEL`: default model for test, implementation, and review roles; defaults to `deepseek-flash`.
- `LOOP_TEST_MODEL`, `LOOP_WORKER_MODEL`, `LOOP_REVIEW_MODEL`: optional per-role overrides.
- `LOOP_TEST_EFFORT`, `LOOP_WORKER_EFFORT`, `LOOP_REVIEW_EFFORT`: optional reasoning-effort overrides.
- `LOOP_MAX_AGENTS`: maximum simultaneous ticket workers; `0` means uncapped.
- `LOOP_MAX_TRANSIENT_FAILURES`: infrastructure retries before blocking; default `3`.
- `LOOP_MAX_SUBSTANTIVE_FAILURES`: failed implementation/review attempts before blocking; default `3`.
- `LOOP_AGENT_BIN`: Codex-compatible CLI executable; defaults to `codex`.

## Operator contract

- `done` means the candidate passed deterministic checks, blind review, integration, and publication when enabled.
- `blocked` is terminal for unattended execution. Read the ticket's `lastFailure` in `.loop/state.json`; do not reset it blindly.
- A rejected test oracle blocks the ticket instead of letting an implementation agent rewrite its own acceptance gate.
- EchoPilot's OpenAI Realtime and managed Codex tickets are product requirements. They are unrelated to which model implements the backlog and must not be removed during provider configuration.
