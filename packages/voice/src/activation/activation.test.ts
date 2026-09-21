import assert from "node:assert/strict";
import test from "node:test";

import {
  ConversationActivationController,
  StandbyEnergyMeter,
  WakeFalseTriggerMeter,
  type ActivationHost,
} from "./index.ts";
import { voiceIndicator } from "../../../../apps/desktop/src/renderer/control/voice/index.ts";

class FakeHost implements ActivationHost {
  readonly calls: string[] = [];
  openMicrophone(mode: "conversation" | "standby"): void { this.calls.push(`mic:open:${mode}`); }
  closeMicrophone(): void { this.calls.push("mic:close"); }
  loadConversationModels(): void { this.calls.push("conversation:load"); }
  unloadConversationModels(): void { this.calls.push("conversation:unload"); }
  loadWakeModel(): void { this.calls.push("wake:load"); }
  unloadWakeModel(): void { this.calls.push("wake:unload"); }
}

test("one enable supports a 20-minute hands-free conversation and default idle tears everything down", async () => {
  let now = 0;
  const host = new FakeHost();
  const controller = new ConversationActivationController({
    host,
    clock: { now: () => now },
    idleTimeoutMs: 60_000,
  });

  await controller.enable();
  for (now = 30_000; now <= 20 * 60_000; now += 30_000) {
    controller.noteActivity();
    await controller.tick();
    assert.equal(controller.snapshot().state, "active");
  }
  assert.equal(host.calls.filter((call) => call === "conversation:load").length, 1);
  assert.equal(host.calls.filter((call) => call === "mic:open:conversation").length, 1);

  now += 60_000;
  await controller.tick();
  assert.deepEqual(controller.snapshot(), {
    state: "idle",
    enabled: true,
    microphoneOpen: false,
    conversationModelsLoaded: false,
    wakeModelLoaded: false,
    standbyEnabled: false,
    lastActivityAt: null,
  });
  assert.deepEqual(host.calls.slice(-2), ["mic:close", "conversation:unload"]);
});

test("optional standby is visibly distinct and its duration-weighted energy gate passes", async () => {
  let now = 0;
  const controller = new ConversationActivationController({
    host: new FakeHost(),
    clock: { now: () => now },
    idleTimeoutMs: 1_000,
    standby: true,
  });
  await controller.enable();
  now = 1_001;
  await controller.tick();
  controller.observeStandbyEnergy({ durationMs: 300_000, cpuPercent: 0.7, wakeups: 80, residentMemoryMb: 42 });
  controller.observeStandbyEnergy({ durationMs: 300_000, cpuPercent: 0.9, wakeups: 80, residentMemoryMb: 44 });

  const snapshot = controller.snapshot();
  assert.equal(snapshot.state, "standby");
  assert.equal(snapshot.conversationModelsLoaded, false);
  assert.equal(snapshot.wakeModelLoaded, true);
  assert.deepEqual(voiceIndicator(snapshot), {
    kind: "standby",
    label: "Voice standby",
    ariaLabel: "Voice standby; low-power wake listening is on",
    persistent: true,
    animated: false,
    tone: "standby",
  });
  assert.deepEqual(controller.standbyEnergy.report(), {
    durationMs: 600_000,
    averageCpuPercent: 0.8,
    wakeupsPerMinute: 16,
    peakResidentMemoryMb: 44,
    sampleCount: 2,
    passed: true,
    violations: [],
  });
});

test("wake attention never grants action authority and TV/background false triggers are reported", async () => {
  let now = 0;
  const falseTriggers = new WakeFalseTriggerMeter();
  falseTriggers.record({ environment: "tv", durationMs: 3_600_000, detected: true, expectedWake: false });
  falseTriggers.record({ environment: "background_speech", durationMs: 1_800_000, detected: true, expectedWake: false });
  falseTriggers.record({ environment: "background_speech", durationMs: 1_800_000, detected: false, expectedWake: false });
  const report = falseTriggers.report();
  assert.equal(report.byEnvironment.tv.falseTriggersPerHour, 1);
  assert.equal(report.byEnvironment.background_speech.falseTriggersPerHour, 1);
  assert.equal(report.total.falseTriggers, 2);

  const controller = new ConversationActivationController({
    host: new FakeHost(),
    clock: { now: () => now },
    idleTimeoutMs: 1,
    standby: true,
    falseTriggerMeter: falseTriggers,
  });
  await controller.enable();
  now = 2;
  await controller.tick();
  const outcome = await controller.detectWake({ confidence: 0.99, environment: "tv", observationMs: 1_000 });
  assert.deepEqual(outcome, {
    detected: true,
    conversationActivated: true,
    actionAuthorized: false,
    requiresExplicitActionConfirmation: true,
  });
});

test("the standalone energy meter rejects an over-budget standby trace", () => {
  const meter = new StandbyEnergyMeter();
  meter.record({ durationMs: 60_000, cpuPercent: 3, wakeups: 40, residentMemoryMb: 120 });
  assert.equal(meter.report().passed, false);
  assert.deepEqual(meter.report().violations, ["average_cpu", "wakeups_per_minute", "resident_memory"]);
});
