# @echopilot/harness-claude

Claude Code harness for EchoPilot (H02 tracer bullet). Everything it produces is a shared v1
`EventEnvelope`; nothing here invents a parallel event shape.

## Managed sessions — the only input path

`createClaudeManagedSession({ scope, sessionRoot, transport })` drives one Claude Code session
through the documented programmatic streaming (stream-json) interface. `transport` is the stdio
seam, so tests can replay output lines and record input frames.

Prompts and approval decisions are written as stream-json input frames:

- `send(instruction, deliveryId)` opens a turn (`turn-<deliveryId>`) and writes a `user` frame.
- `respondApproval(requestId, decision)` writes a `control_response` frame; Claude Code's own
  permission rules stay in force — EchoPilot only forwards an explicit decision.

Normalized output: `system` init → `session_state`, assistant text → `agent_message`, tool use →
`tool_started`, tool results → `tool_completed`, `can_use_tool` controls → `approval_requested`,
the response → `decision`, and turn `result` → a `session_state` event carrying the turn id.
Transcript paths feed `payloadRef`, and `trust` distinguishes agent narration from observed tools.

## Hook-only observation — no input path

`createClaudeHookObserver({ scope, installationId, spoolDir })` observes sessions EchoPilot does
not manage. It advertises `observe` and nothing else; `send()` reports `unsupported`, because a
hook is an observation channel, not an undocumented general input API. `collect()` normalizes
newly spooled deliveries and deduplicates retries of one source event.

`scripts/hooks/claude-enqueue.mjs` is the dependency-free enqueue-only hook command: it archives
one stdin payload under `ECHOPILOT_HOOK_SPOOL_DIR/incoming`, keyed by source event identity, and
exits 0 without ever contacting the companion (`ECHOPILOT_HOOK_INGRESS` may be absent or stopped
and is only recorded as a delivery hint).

## Reversible installation

`installClaudeObservationHooks({ settingsPath, hookScriptPath, spoolDir, installationId, ingressPath? })`
adds exactly one managed entry per event in `CLAUDE_OBSERVED_HOOK_EVENTS`, preserving every
unrelated hook and setting; retries are idempotent. `removeClaudeObservationHooks({ settingsPath,
installationId })` removes exactly the managed entries and restores the rest of the document.
