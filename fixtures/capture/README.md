# Capture fixtures

`a01-app-surfaces.json` is the deterministic A01 oracle fixture: four synthetic focused
surfaces (VS Code, TextEdit, one browser text field, one secure field), the exclusion list, and
the synthetic secret markers that must never reach a context bundle.

Everything here is invented. The markers exist so `packages/capture/test/acceptance.test.ts` can
assert that secure fields, excluded applications, and the EchoPilot widget are removed from the
bundle even when the capture helper hands them back raw (plan §5.4: "post-capture blur alone is
insufficient for an excluded app").

The fixture does not prove real insertion into VS Code, TextEdit, or a browser: that needs the
signed helper, Accessibility/Screen Recording consent, and A04 hardware qualification. A01 pins
the frozen TypeScript seam and the safety properties that are decidable off-device.
