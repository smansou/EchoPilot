import { test } from "node:test";
import assert from "node:assert/strict";
import { permissionPlan } from "./permission-plan";
test("Accessibility offers the process that actually reads and edits app controls", () => {
  const p = permissionPlan(
    "Accessibility",
    "/Applications/Cleo.app",
    "/app/echopilot-desktop",
  );
  assert.equal(p.pane, "Privacy_Accessibility");
  assert.deepEqual(
    p.targets.map((t) => t.file),
    ["/app/echopilot-desktop"],
  );
});
test("screen access presents both the app screenshot path and desktop text helper", () => {
  const p = permissionPlan(
    "Screen Recording",
    "/Applications/Cleo.app",
    "/app/echopilot-desktop",
  );
  assert.equal(p.targets.length, 2);
  assert.equal(p.targets[0]?.file, "/Applications/Cleo.app");
});
test("camera and microphone use macOS toggles, never a misleading drag instruction", () => {
  for (const name of ["Microphone", "Camera"] as const)
    assert.equal(permissionPlan(name, "/app", null).draggable, false);
  assert.throws(() => permissionPlan("invalid" as any, null, null));
});
