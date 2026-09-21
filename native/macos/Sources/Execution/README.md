# Execution (S04)

`echopilot-exec-observation` is the native macOS process observer for the scoped-command host
executor (`packages/security/src/execution/host-executor.ts`). It is spawned with stdio pipes only —
no socket and no port — and answers one question: which processes exist, what is each one's parent
and process group, and is it still running.

```
echopilot-exec-observation ps
```

prints one line per visible process:

```
<pid> <ppid> <pgid> <pbi_status>
```

`pbi_status` is the Darwin value: 1 SIDL, 2 SRUN, 3 SSLEEP, 4 SSTOP, 5 SZOMB. Processes this uid may
not inspect are skipped rather than guessed at. Exit status is 0 on success, 1 when libproc refuses,
2 on a usage error.

## Why libproc

A managed command runs as its own process group, so the group signal reaches everything that stayed
in the group. A child that left it (a daemonizing double-fork, or a script that spawned a detached
process) cannot be reached by that signal, and Node's stdio `close` says only that the direct
child's pipes are done — not that the grandchild died. Restricted runtimes deny `ps` (spawn EPERM)
and `pgrep` (no process list), so the executor enumerates through `proc_listallpids` plus
`proc_pidinfo(PROC_PIDTBSDINFO)` and reports the survivors it can see by pid and evidence instead
of claiming the stop was clean.

`packages/security/src/execution/process-table.ts` resolves, in order: `ECHOPILOT_EXEC_OBSERVATION`,
this package's `.build/release/echopilot-exec-observation` then `.build/debug/…`, `ps`, the bundled
`packages/security/src/execution/native/exec-observation.c` bootstrap (the same reader, compiled on
demand), and finally nothing — in which case the executor reports `stop_unverified` rather than
assuming an empty table.

## Build

```
swift build --package-path native/macos/Sources/Execution
```

The package has no dependencies and builds offline. `.gitignore` keeps `.build/` and `.swiftpm/`
out of the repository.

## Limitations

This binary is not signed or notarized yet: the signed-helper packaging step belongs to the helper
packaging ticket (S01/F02). A restricted runtime that has neither a built helper, `ps`, nor a C
toolchain falls back to `stop_unverified`, which is reported rather than glossed over. Real
host-containment qualification (a host command that daemonizes and is proven dead) still needs a
manual pass on installed hardware.
