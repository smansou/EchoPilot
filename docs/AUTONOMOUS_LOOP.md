# Autonomous implementation handoff

The project is implemented from `BACKLOG.json` by `scripts/loop.mjs`. Do not give one long-lived model the entire implementation plan and ask it to remember progress. The loop creates a fresh context per bounded role and keeps durable state in Git plus `.loop/state.json`.

## Before the first run

1. Review and commit the current orchestration cleanup. The integration checkout must be clean because accepted ticket branches are fast-forwarded into it.
2. Confirm the tools in your own Terminal, not only inside the desktop app:

   ```sh
   command -v node npm
   command -v pnpm codex
   ```

3. If `pnpm` is missing and Node was installed through nvm, run `corepack enable` and `corepack prepare pnpm@11.19.0 --activate`.
4. If `codex` is missing, install the CLI with `npm install -g @openai/codex`. With nvm's standard shell setup, no additional PATH line is needed; open a new Terminal afterward.
5. Configure the Codex CLI to use the desired provider and verify that `codex exec -m deepseek-flash "Reply with ready"` succeeds. The loop reads normal CLI configuration so a non-OpenAI provider can be used.
6. Install dependencies with `pnpm install --frozen-lockfile` and run `pnpm loop:self-test`, `pnpm check`, and `pnpm smoke`.
7. Run `pnpm loop:init`; it should report `42 tickets: 1 done, 41 remaining` and identify F01's integrated commit.
8. Inspect model routing with `LOOP_MODEL=deepseek-flash pnpm loop:dry`.

## Run

```sh
LOOP_MODEL=deepseek-flash LOOP_MAX_AGENTS=10 pnpm loop
```

Open `http://127.0.0.1:4318` for read-only status. Stop with Ctrl-C; the next run recovers tickets that were active when the process stopped.

If a ticket is blocked after an infrastructure interruption, requeue only the affected tickets while preserving their worktrees and test evidence:

```sh
pnpm loop:retry -- F02 Q01 S01
```

The normal terminal mode is direct subprocess execution. Set `LOOP_TERMINALS=cmux` only when an on-screen cmux workspace and supervisor surface are intentionally available.

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
