# @echopilot/capture

The A01 dictation seam: dictate into a focused editor → scoped context preview → literal insertion
→ undo. `src/index.ts` exports the two names the frozen oracle pins:

- `AX_CAPTURE_BUDGET = { maxNodes: 500, maxTraversalMs: 100 }` — the bounded AX traversal from
  plan §5.4.
- `createDictationController({ bridge, excludedBundleIds })` — the rules layer that sits between
  the widget session and the signed native host.

## What this package decides

| Decision | Rule |
| --- | --- |
| Capture | Exactly one `captureContext` per utterance, at most one permitted screenshot, never a screenshot of a secure field. |
| Bundle | Excluded bundle ids, secure nodes, secure selections and OCR spans from excluded apps are removed here, before a bundle exists. The helper is treated as a raw producer, so redaction cannot be delegated to it (plan §5.4). |
| Insertion | Accessibility write first, transactional clipboard paste only when the helper reports `unsupported`. No Return/Enter key synthesis, no `activateApplication`. |
| Focus | The original fingerprint is revalidated immediately before every write. A mismatch (or a non-editable focus) writes nothing anywhere and preserves the draft; `retargetToCurrentFocus()` is the explicit new-target decision. |
| Clipboard | Read once, only to restore it, and restored only when the pasteboard change count still proves the user has not replaced the clipboard. |
| Undo | One insertion transaction, one undo; a second undo reports `nothing_to_undo`. |

## Native boundary

`native/macos/Sources/Accessibility` and `native/macos/Sources/Capture` own the real
Accessibility/ScreenCaptureKit/pasteboard calls behind the `CaptureBridge` shape in
`src/types.ts`. Those paths need the signed helper, TCC consent and the A04 hardware matrix, so
they are not exercised by the off-device oracle.

## Evidence

```sh
node --import tsx --test packages/capture/test/acceptance.test.ts   # frozen A01 oracle
node --import tsx --test packages/capture/test/controller.test.ts   # off-oracle controller branches
```
