# Local build runner

The runner is development tooling, not part of the shipped Electron application. Workers cannot edit the runner, its dashboard, configuration, backlog, or agent policy files. Configuration and the ticket graph live with the project; the engine can be extracted later.

## Start

From the EchoPilot repository on `codex/bootstrap` (or another implementation branch), with Node 24+, pnpm 11.19.0, and an authenticated Codex CLI:

```sh
pnpm install
pnpm runner:build
pnpm runner
```

Open http://127.0.0.1:4318. The loop starts paused. Click **Start loop** to authorize the bounded run. To start immediately instead, use `pnpm runner --run`. `pnpm runner --dry-run` prints ticket/model assignments without calling a model.

In another terminal:

```sh
pnpm runner --status
pnpm runner --pause
pnpm runner --resume
pnpm runner --stop
```

Pause prevents new tickets while current ones finish. Stop cancels workers; interrupted attempts need attention. Ctrl-C stops the server and its workers. Keep this terminal running and the computer awake. This is not a background scheduler or an automatic usage-reset service.

## What the loop does

The deterministic scheduler selects dependency-ready tickets, reserves overlapping paths and blocks, and runs up to two tickets concurrently. Every attempt gets a separate Git worktree and a fresh Codex context. Workers produce structured acceptance evidence. Changes are checked for ownership, committed in the isolated branch, rebased onto the current integration head, tested, and reviewed by a fresh read-only reviewer. The verification/review/integration lane is serialized. Approved changes are cherry-picked and pushed to the checked-out implementation branch in smansou/EchoPilot. Main/master and unrelated remotes are refused.

Sandboxed workers must not launch Electron or other macOS GUI applications. GUI smoke tests run only in the coordinator check lane, where they can register with the active macOS window server without inheriting the worker sandbox.

The ledger broadcasts every status change over server-sent events. Agent activity updates heartbeat text; agents cannot self-mark a ticket complete. The dashboard shows all 42 tickets, dependencies, per-ticket model assignments, current phases, and recent activity. F01 correctly starts pending because the existing bootstrap does not complete its full scope.

The parent checkout must be clean before starting and integrating. Do not edit or switch that checkout during a run. Work on a separate worktree if needed. Failed candidates remain under `.runner/worktrees` for diagnosis. Nothing automatically deletes them.

## Models and limits

Edit `runner.config.json`, then restart the server to apply settings. Initial routing is an engineering hypothesis, not a benchmark result:

- GPT-5.6 Luna, medium: bounded UI/docs/fixture work.
- GPT-5.6 Terra, medium: ordinary implementation and integration.
- GPT-5.6 Terra, high: native, shared contracts, voice, memory, gaze, routing.
- GPT-5.6 Sol, high: security-sensitive implementation and independent reviews.
- GPT-6 Astra: never selected by default; a deliberate config override is required.

Defaults: two active tickets, one verification/review lane, two attempts per ticket, six starts per server run, 30-minute model invocation timeout, five-minute command timeout. Failed code checks or review can trigger one fresh-context repair. Authentication, unavailable models, permissions, ownership violations, Git conflicts, and publication failures stop scheduling for inspection. No silent model substitution occurs.

The token ceiling is a scheduling control, not a dollar cap. Usage events can arrive late; concurrent/in-flight calls can overshoot it. Totals include cached input tokens and output tokens, and do not represent subscription usage percentages or an API bill. The runner uses your local Codex authentication. Account model availability is established only when a real invocation runs.

Compare accepted tickets per model against total tokens, duration, attempts, and review findings. After several comparable accepted tickets, lower the model or effort for a category that rarely needs repair; raise effort or model when repeated substantive review failures warrant it. Change one variable at a time. Do not pay for duplicate benchmark implementations by default. The runner records evidence but does not automatically retune policy from a tiny sample.

Model guidance sources: [Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna), [Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra), [Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol). CLI behavior follows [non-interactive Codex documentation](https://learn.chatgpt.com/docs/non-interactive-mode) and the installed CLI help. Exact model/effort assignments above are our project-specific choices.

## Evidence and recovery

`.runner/state.json` is the atomic current snapshot; `.runner/events.jsonl` records transitions. `.runner/runs/TICKET-ATTEMPT/` contains structured worker/reviewer results, bounded CLI/check logs, and the task prompt. These files are local, ignored by Git, and must be treated as private. The server binds only to loopback, rejects cross-site requests, and requires a random control token for mutations. Never expose it through a public tunnel.

Restart always pauses scheduling and marks interrupted phases as needing attention. A hard process kill can leave an orphaned Codex process: inspect the retained worker process before requeueing; do not assume restart cancelled it. Normal Stop/Ctrl-C cancels process groups.

Ordinary worker, dependency-setup, ownership, check, and review failures are automatically retried in a fresh context without pausing unrelated tickets. The second attempt is a coordinator repair lane and may change only the paths listed in `repairPaths` (currently the root dependency manifest and lockfile). A ticket is escalated only for a genuine human blocker such as authentication/credentials, unavailable hardware or user interaction, unsafe or dirty Git state, publication recovery, or a protected decision. Exhausted retries leave that ticket in **Needs attention** while independent work continues; they do not stop the scheduler.

Use **Requeue within attempt limit** only after resolving the reason. If a commit integrated locally but failed to push, do not rerun the implementation: inspect `record.commit`, publish the existing branch, then reconcile the local state with that evidence while the server is stopped. Never mark done without verifying the recorded commit and review. Root schema validation forbids jumping straight to done through the control API.

`repairPaths` is a deliberately small coordinator-owned repair allowance, not general worker ownership. Configure `ticketChecks[TICKET_ID]` as argv arrays for additional focused tests. Do not add interactive hardware/signing steps to unattended checks.

No live paid worker invocation was used to validate this tooling. Verification covered typechecking, dashboard build, seven focused tests including fake Codex output and real temporary Git worktree integration, and local HTTP controls. End-to-end model quality and hardware-dependent product acceptance remain future run evidence.
