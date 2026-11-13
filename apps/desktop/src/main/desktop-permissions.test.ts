import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createDesktopPermissions,
  type MediaStatus,
  type DesktopPermissionReport,
} from "./desktop-permissions";
function fixture() {
  const media = {
    microphone: "not-determined",
    camera: "not-determined",
    screen: "denied",
  } as Record<"microphone" | "camera" | "screen", MediaStatus>;
  let report: DesktopPermissionReport = { permission: "denied" };
  const calls: string[] = [],
    updates: any[] = [];
  const host = createDesktopPermissions({
    media: (type) => media[type],
    desktop: async (prompt) => {
      calls.push(prompt ? "native-ax-request" : "read");
      return report;
    },
    askMedia: async (type) => {
      calls.push("native-" + type);
      media[type] = "granted";
      return true;
    },
    askScreen: async () => {
      calls.push("native-screen");
      media.screen = "granted";
    },
    openSettings: async (pane) => {
      calls.push(pane);
    },
    changed: (state) => updates.push(state),
  });
  return {
    host,
    media,
    calls,
    updates,
    setReport: (r: DesktopPermissionReport) => (report = r),
  };
}
test("status polling never requests access and detects manual changes without a guide", async () => {
  const f = fixture();
  await f.host.read();
  assert.deepEqual(f.calls, ["read"]);
  f.media.camera = "granted";
  f.media.screen = "granted";
  f.setReport({ permission: "granted" });
  const state = await f.host.read();
  assert.equal(state.camera, "granted");
  assert.equal(state.accessibility, true);
  assert.equal(f.updates.length, 2);
  assert.ok(f.calls.every((c) => c === "read"));
});
test("Screen Recording follows the app capture permission, independently of a denied AX helper", async () => {
  const f = fixture();
  f.media.screen = "granted";
  assert.equal((await f.host.read()).screen, "granted");
  assert.equal((await f.host.read()).accessibility, false);
});
test("first camera and microphone requests use native media dialogs, no custom window or Settings detour", async () => {
  for (const name of ["Camera", "Microphone"] as const) {
    const f = fixture();
    const state = await f.host.request(name);
    assert.equal(state[name === "Camera" ? "camera" : "microphone"], "granted");
    assert.ok(f.calls.includes("native-" + name.toLowerCase()));
    assert.ok(!f.calls.some((c) => c.startsWith("Privacy_")));
  }
});
test("previously denied camera access goes to the system pane, as required by macOS", async () => {
  const f = fixture();
  f.media.camera = "denied";
  await f.host.request("Camera");
  assert.ok(f.calls.includes("Privacy_Camera"));
  assert.ok(!f.calls.includes("native-camera"));
});
test("Accessibility requests the native AX prompt, then offers the system pane if still blocked", async () => {
  const f = fixture();
  await f.host.request("Accessibility");
  assert.ok(f.calls.includes("native-ax-request"));
  assert.ok(!f.calls.includes("Privacy_Accessibility"));
  await f.host.request("Accessibility");
  assert.ok(f.calls.includes("Privacy_Accessibility"));
});
test("screen requests invoke the platform capture path only on a user request", async () => {
  const f = fixture();
  const state = await f.host.request("Screen Recording");
  assert.equal(state.screen, "granted");
  assert.equal(f.calls.filter((c) => c === "native-screen").length, 1);
  await f.host.request("Screen Recording");
  assert.equal(f.calls.filter((c) => c === "native-screen").length, 1);
});
test("denied camera offers restart recovery without claiming another process’s grant is ours", async () => {
  const f = fixture();
  f.media.camera = "denied";
  f.setReport({ permission: "granted", camera: "granted" });
  const state = await f.host.read();
  assert.equal(state.camera, "denied");
  assert.deepEqual(state.restartRequired, ["Camera"]);
});

test("a failed desktop probe reports unknown access rather than a false denial", async () => {
  const f = fixture();
  const host = createDesktopPermissions({
    media: () => "granted",
    desktop: async () => {
      throw Error("helper failed");
    },
    askMedia: async () => true,
    askScreen: async () => {},
    openSettings: async () => {},
    changed: () => {},
  });
  const state = await host.read();
  assert.equal(state.accessibility, null);
  assert.match(state.desktopError!, /Could not check/);
});
