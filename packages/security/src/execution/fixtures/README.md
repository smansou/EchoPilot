# Execution fixtures (S04)

`s04-execution.json` is the deterministic scenario corpus for the S04 scoped-command tracer
(`packages/security/src/execution/`, `packages/desktop-tools/src/commands/`). It fixes the values
the oracle reuses in every leg so a replay is byte-stable:

- `profileId`, `project` — the explicit project association every command request carries. The
  oracle builds its `Scope` from these values, so a request is never scope-less.
- `workspace` — the allowed test workspace: `allowedDirectory` is created under a fresh temporary
  root and is the only host directory the VM executor may mount (`guestRoot`); `outsideDirectory`
  and `canaryRelativePath` hold the canary that sits outside that mount, with synthetic
  `canaryContent`. `probeFile` is the change a VM command makes inside the mount, and
  `injectedFile` is the file a shell metacharacter would create if an argument were ever re-parsed
  by a shell instead of passed as one argv element.
- `grants` — the grant ids the oracle registers in its grant source: one VM capability, one Host
  Autonomy capability, and one revoked grant. The oracle revokes grants by id, never by rewriting
  the tuple.
- `capabilities`, `destinations` — §5.9 permission tuple values. The VM executor authorizes
  `execution.vm` to `managed-vm`; native host execution authorizes `execution.host_autonomy` to
  `native-host`; shell scripts are the separate `execution.shell_script` capability.
- `network` — the controlled network profile: `allowedHost` is inside the grant's allowlist,
  `deniedHost` is not. The denied endpoint must be unreachable and the refusal must be reported.
- `labels` — the two execution labels the proposal and the outcome must carry: `isolated-vm` for
  the managed Lima VM, `host-execution` for the native macOS host executor.
- `authorizationTtlMs` — §5.9 confirmation expiry, kept here for the same value the S02 broker
  uses when a host command needs a fresh confirmation.

Consumers:

- `packages/security/src/execution/s04.acceptance.test.ts` — the executor half of the oracle
  (mount boundary, network profile, argv integrity, Host Autonomy grant, managed process group).
- `packages/desktop-tools/src/commands/s04.acceptance.test.ts` — the tool half (tool-call argument
  validation, authority surface, host-execution label).

Provenance: fully synthetic. No real workspace, canary, endpoint, or credential is referenced; the
temporary root is created by the oracle and removed in `finally`. One catch: no production module
exists yet, so both oracle files report the missing behavior while the seam is unimplemented.

Limitations: this corpus pins the seam, not the hardware. Real Lima instance isolation, a real
guest network namespace, and the signed native host helper need a manual qualification pass on a
machine where those components are installed; the deterministic oracle proves the plan and the
observation mapping that drive them. The host process-group legs do run real child processes: they
kill the managed group for real and expect survivors of an escaped descendant to be reported by
pid, so `native/macos/Sources/Execution/` has to enumerate descendants through darwin libproc
(`proc_listallpids` + `proc_pidinfo` parent mapping) - restricted runtimes deny `ps` and `pgrep`,
and Node's own stdio close cannot stand in for a process table.
