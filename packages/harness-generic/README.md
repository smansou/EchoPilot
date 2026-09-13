# packages/harness-generic — H03

Existing JSONL or plain-text log → bounded parser → normalized timeline preview.

## Import adapters (`createGenericLogAdapter`)

Read-only. `format: 'jsonl' | 'text'`; the source is one generation of one file exposing
`identity()`, `size()`, and bounded `read(offset, maxBytes)`.

- Streams through a small working set: 64 KiB read requests, one line buffered at a time, and an
  over-long line (1 MiB cap) is discarded as a display-only gap instead of being buffered.
- Emits §5.3-shaped records with `trust: 'imported'` and a cursor
  `{ sourceId, generation, offset }` that is the commit point after the last returned event.
- Every emission gets an `eventId` derived from its full identity (source identity, generation, byte
  span, kind, diagnostic), so a `source_rotated` gap or an `incomplete_line` gap starting at the
  same offset as the record it precedes never reuses that record's id.
- `preview({ from })` resumes at the committed byte offset of the same source identity; a changed
  `identity()` advances `generation` and emits a `source_rotated` gap without re-emitting the old
  generation.
- Partial UTF-8 is reassembled across reads; a malformed JSON line and an unterminated trailing line
  become `malformed_json` / `incomplete_line` gaps that leave adjacent events intact.
- Display text is ANSI-normalized (`\r\n` is a line ending, CSI/OSC sequences are stripped, lone
  `\r` redraws collapse to the final frame).
- Imported content is data, never authority: `send()` is always `unsupported`, unstructured lines
  are `confidence: 'low'`, and approval-shaped records become `kind: 'unsupported'` with
  `unsupportedKind` preserved — never `approval_requested`.

## Existing log files (`createFileLogSource`)

`createFileLogSource(path)` opens an existing JSONL / plain-text log as the read-only source the
adapter needs. It is opened for reading only, each positional read is capped at 64 KiB (so a 256 MiB
log is previewed without materializing it), and `identity()` is the file's `(device, inode)` pair:

- an append keeps the identity, so the preview streams on from the committed offset;
- rotation (rename away + recreate) changes the identity and advances the generation, emitting a
  `source_rotated` gap without re-emitting the previous generation;
- an in-place truncation keeps the identity but no longer reaches the committed offset, so the
  adapter starts a new generation at offset 0 instead of stalling on bytes that no longer exist.

## No execution path

`packages/harness-generic/src` imports no child-process API and contains no agent-CLI flags: the
package observes logs and writes only to a managed child the user selected
(`createManagedPtyAdapter`). The acceptance oracle therefore starts no `codex exec`, which is why the
recorded oracle failure `the argument '--approve-for-me' cannot be used with '--sandbox
<SANDBOX_MODE>'` (finding f-4a271ed5a779) cannot recur.

## Managed PTY (`createManagedPtyAdapter`)

The opt-in wrapper for a child this application started because the user selected it. Observation is
unconditional; `send()` writes once, newline-terminated, to that child only. Output lines are
low-confidence imported text and are never auto-classified: `approvalResponse` is `false` and no
output can create an approval path. Existing arbitrary terminals remain observation-only.

## Capability descriptor

`observe, send, interrupt, resume, approvalResponse, toolResults, artifactDiffs, format,
formatVersion`. Import adapters report `observe: true`, `resume: true`, `send: false`,
`approvalResponse: false`; the managed PTY reports `send: true` and `approvalResponse: false`.

## Acceptance checks

- `pnpm exec tsx --test packages/harness-generic/test/generic-import.test.ts` — the acceptance suite.
- `node packages/harness-generic/test/check.mjs` — the oracle. It loads the TypeScript adapter
  in-process through tsx, asserts each acceptance criterion (10 GiB bounded streaming plus
  committed-offset resume; torn JSON / partial UTF-8 / rotation / redraw isolation; imported
  low-confidence output that is never an authorization or execution path), then runs the acceptance
  suite. It starts no agent CLI, so the oracle failure `the argument '--approve-for-me' cannot be
  used with '--sandbox <SANDBOX_MODE>'` (finding f-4a271ed5a779) cannot recur.
