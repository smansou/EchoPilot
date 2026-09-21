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
| Capture | Exactly one `captureContext` per permitted utterance, at most one permitted screenshot, never a screenshot of a secure field (secure flag *or* a `…secure…` role, so a helper that reports `secure: false` cannot unlock it), and never a capture at all while the focused application is excluded (including the always-excluded widget). |
| Bundle | Excluded bundle ids, secure nodes, secure selections, OCR spans from excluded apps, and OCR spans restating a secure value are removed here, before a bundle exists. A secure focused field contributes no selection, no screenshot and no OCR at all, because an OCR span cannot be attributed back to its field. An excluded focused target contributes no target metadata, selection, screenshot, AX nodes or OCR spans even if a raw helper returns them. The helper is treated as a raw producer, so redaction cannot be delegated to it (plan §5.4). |
| Insertion | Accessibility write first, transactional clipboard paste only when the helper reports `unsupported`. No Return/Enter key synthesis, no `activateApplication`. |
| Focus and eligibility | The original fingerprint is revalidated immediately before every write. A mismatch writes nothing and preserves the draft; `retargetToCurrentFocus()` is the explicit new-target decision. Secure fields, active IME composition, unavailable Accessibility trust and non-editable targets are refused by the controller itself, including on direct `insert()` calls, and preserve the draft. |
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
