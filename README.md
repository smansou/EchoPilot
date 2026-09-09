# EchoPilot

A TypeScript-first desktop companion for AI coding agents. The implementation starts with a small Electron/React widget and a secondary Mission Control window; a narrow native macOS helper will provide system audio and capture later.

## Run the first slice

Requires Node.js 24+ and pnpm 11.19.0 on macOS. No API key, microphone permission, or Xcode is needed for this slice.

```sh
pnpm install
pnpm dev
```

`dev` builds the application and launches Electron. Restart it after source changes; hot reload is deliberately deferred. Close Mission Control to return to the persistent widget. Close the widget or use the application menu to quit.

The current UI is explicitly a **synthetic demo**. A fixed session event passes through validated IPC, appears in both windows, and is restored from a bounded fixture journal after restart. Mute invalidates speech leases; no audio is synthesized yet. Replay redispatches the text event.

## Focused verification

```sh
pnpm check
pnpm smoke
```

The unit checks cover IPC validation, speech lease revocation, and journal identity. The smoke script opens hidden Electron windows twice using a temporary profile, checks the preload boundary and dashboard lifecycle, and removes its temporary data. It makes no paid calls and requests no hardware access.

## Where to work

- `apps/desktop/src/main`: window lifecycle, trusted IPC handling, synthetic persistence.
- `apps/desktop/src/preload`: narrowly exposed renderer bridge.
- `apps/desktop/src/renderer`: React widget and Mission Control.
- `packages/contracts`: validated command/state boundary.
- `packages/core`: pure coordinator and bounded synthetic journal.
- `IMPLEMENTATION_PLAN.md`: destination architecture and 42-ticket plan.
- `BACKLOG.json`: machine-readable dependency graph.
- `IMPLEMENTATION_STATUS.md`: current progress, next tickets, orchestration policy.

The unencrypted journal is exclusively for synthetic fixtures. Real user data must wait for S01/M01. No remote pages, arbitrary command execution, or renderer Node access are enabled in this bootstrap. Later capabilities are implemented through explicit user scopes.

No release package is signed or notarized yet. Performance targets in the plan are targets, not measurements of this prototype.

The Electron boundary follows the official [security guidance](https://www.electronjs.org/docs/latest/tutorial/security) and [preload guidance](https://www.electronjs.org/docs/latest/tutorial/tutorial-preload).
