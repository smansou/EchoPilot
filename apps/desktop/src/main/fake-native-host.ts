/**
 * F02 fake native host — a drop-in stand-in for the signed PlatformHost helper.
 *
 * It speaks the same newline-delimited JSON protocol on stdout, so TypeScript developers can work
 * without Xcode or a signed binary:
 *
 *   ECHOPILOT_NATIVE_HOST=apps/desktop/src/main/fake-native-host.ts pnpm dev
 *
 * It also accepts commands on stdin: `{"type":"status"}` re-announces status,
 * `{"type":"disconnect"}` exits (so the supervisor exercises the recoverable disconnect path),
 * and `{"type":"quit"}` shuts down cleanly.
 *
 * V05 voice protocol: `{"type":"voice-command"}` frames are answered with an authenticated
 * `voice-ack`, and while the standby microphone is open the host streams `voice-observation`
 * frames. The energy readings are measured from this process — CPU time via `process.cpuUsage()`,
 * resident memory via `process.memoryUsage()`, and the standby loop's own timer wakeups — so the
 * lifecycle's energy gate is driven by real numbers in dev as well as in the deterministic tests.
 * The acoustic scenario is what the developer configures (there is no audio device here):
 *
 *   ECHOPILOT_FAKE_STANDBY_TICK_MS=2500        standby loop cadence (also its wakeup rate)
 *   ECHOPILOT_FAKE_STANDBY_ENVIRONMENT=tv      label reported for each acoustic window
 *   ECHOPILOT_FAKE_STANDBY_DETECT_EVERY=1      detect on every Nth window (0 = never)
 *   ECHOPILOT_FAKE_STANDBY_CPU_BURN_MS=0       busy-wait this long per tick (a real CPU load)
 *   ECHOPILOT_STANDBY_MEMORY_BUDGET_MB=96     memory allowance for the host running this loop
 */
import { createInterface } from 'node:readline';
import {
  DEFAULT_STANDBY_ENERGY_BUDGET,
  StandbyEnergyMeter,
  type AcousticEnvironment,
  type StandbyEnergySample,
} from '../../../../packages/voice/src/activation';

const tokenArg = process.argv.find((argument) => argument.startsWith('--token='));
const token = tokenArg?.slice('--token='.length) ?? process.env.ECHOPILOT_NATIVE_TOKEN ?? '';
if (token.length < 16) {
  process.stderr.write('fake-native-host requires --token=<per-launch secret>\n');
  process.exit(2);
}

const status = {
  microphone: process.env.ECHOPILOT_FAKE_MICROPHONE ?? 'granted',
  capture: process.env.ECHOPILOT_FAKE_CAPTURE ?? 'denied',
  output: 'ready',
  targetSession: process.env.ECHOPILOT_FAKE_SESSION ?? 'session-42',
  provider: process.env.ECHOPILOT_FAKE_PROVIDER ?? 'local',
};

function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ protocolVersion: 1, token, ...message })}\n`);
}

send({ type: 'hello', status });

function numberFromEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name] ?? '');
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

const standbyTickMs = Math.max(250, numberFromEnv('ECHOPILOT_FAKE_STANDBY_TICK_MS', 2_500));
const standbyEnvironment = (process.env.ECHOPILOT_FAKE_STANDBY_ENVIRONMENT ?? 'quiet') as AcousticEnvironment;
const detectEvery = Math.trunc(numberFromEnv('ECHOPILOT_FAKE_STANDBY_DETECT_EVERY', 0));
const standbyCpuBurnMs = numberFromEnv('ECHOPILOT_FAKE_STANDBY_CPU_BURN_MS', 0);
const wakeThreshold = Math.min(1, Math.max(0, numberFromEnv('ECHOPILOT_FAKE_WAKE_THRESHOLD', 0.8)));

let wakeModelLoaded = false;
let standbyTimer: NodeJS.Timeout | null = null;
let standbyWindows = 0;
/**
 * The gate's memory entry assumes the signed Swift helper's footprint. This stand-in runs on Node,
 * where the runtime baseline alone is ~90 MB, so a caller may restate that one entry for the host
 * it is standing in for (`ECHOPILOT_STANDBY_MEMORY_BUDGET_MB`, the same knob the app's own gate
 * reads). CPU and wakeups always keep the product budget, so a standby loop that really burns CPU
 * or wakes too often still fails by default.
 */
const standbyMemoryBudgetMb = numberFromEnv(
  'ECHOPILOT_STANDBY_MEMORY_BUDGET_MB',
  DEFAULT_STANDBY_ENERGY_BUDGET.maxResidentMemoryMb,
);
const standbyEnergy = new StandbyEnergyMeter({
  ...DEFAULT_STANDBY_ENERGY_BUDGET,
  maxResidentMemoryMb: standbyMemoryBudgetMb,
});
let previousCpu = process.cpuUsage();
let previousWallMs = Date.now();

/** Burns real CPU so an over-budget standby trace can be measured, not injected. */
function burnCpu(milliseconds: number): void {
  if (milliseconds <= 0) return;
  const deadline = Date.now() + milliseconds;
  let accumulator = 0;
  while (Date.now() < deadline) accumulator = Math.sqrt(accumulator + 1);
}

function sampleStandbyEnergy(): StandbyEnergySample {
  const wallMs = Math.max(1, Date.now() - previousWallMs);
  const cpu = process.cpuUsage();
  const cpuMs = ((cpu.user - previousCpu.user) + (cpu.system - previousCpu.system)) / 1_000;
  previousCpu = cpu;
  previousWallMs = Date.now();
  return {
    durationMs: wallMs,
    cpuPercent: Math.max(0, (cpuMs / wallMs) * 100),
    // The standby loop is the only wake source this stand-in has, so its own timer callbacks are
    // the wakeups it reports. A cadence faster than the budget allows is a real violation.
    wakeups: 1,
    residentMemoryMb: process.memoryUsage().rss / (1024 * 1024),
  };
}

function emitStandbyStep(): void {
  burnCpu(standbyCpuBurnMs);
  const sample = sampleStandbyEnergy();
  standbyEnergy.record(sample);
  send({
    type: 'voice-observation',
    observation: { kind: 'standby-energy', sample, report: standbyEnergy.report() },
  });
  standbyWindows += 1;
  const detected = detectEvery > 0 && standbyWindows % detectEvery === 0;
  send({
    type: 'voice-observation',
    observation: {
      kind: 'standby-window',
      environment: standbyEnvironment,
      durationMs: sample.durationMs,
      detected,
      confidence: detected ? 0.95 : 0.1,
      threshold: wakeThreshold,
    },
  });
}

function stopStandby(): void {
  if (!standbyTimer) return;
  clearInterval(standbyTimer);
  standbyTimer = null;
  process.stderr.write('fake-native-host closed the standby microphone\n');
}

function startStandby(): void {
  if (standbyTimer) return;
  previousCpu = process.cpuUsage();
  previousWallMs = Date.now();
  standbyTimer = setInterval(emitStandbyStep, standbyTickMs);
  process.stderr.write(`fake-native-host opened the standby microphone (${standbyEnvironment}, ${standbyTickMs} ms)\n`);
}

function acknowledge(id: unknown, ok: boolean, error?: string): void {
  send({ type: 'voice-ack', id: typeof id === 'string' ? id : '', ok, ...(error === undefined ? {} : { error }) });
}

function handleVoiceCommand(command: Record<string, unknown>): void {
  const id = command.id;
  const name = command.name;
  if (name === 'load-wake-model') {
    wakeModelLoaded = true;
    acknowledge(id, true);
    return;
  }
  if (name === 'unload-wake-model') {
    stopStandby();
    wakeModelLoaded = false;
    acknowledge(id, true);
    return;
  }
  if (name === 'close-microphone') {
    stopStandby();
    acknowledge(id, true);
    return;
  }
  if (name === 'open-microphone') {
    if (command.mode !== 'standby') {
      acknowledge(id, false, 'Conversation capture belongs to the local voice worker.');
      return;
    }
    if (!wakeModelLoaded) {
      acknowledge(id, false, 'The wake model is not loaded.');
      return;
    }
    if (status.microphone === 'denied') {
      acknowledge(id, false, 'Microphone permission is denied.');
      return;
    }
    startStandby();
    acknowledge(id, true);
    return;
  }
  acknowledge(id, false, `Unsupported voice command '${String(name)}'.`);
}

const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(trimmed);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('not an object');
    parsed = value as Record<string, unknown>;
  } catch {
    process.stderr.write('fake-native-host ignored a non-JSON command\n');
    return;
  }
  if (parsed.type === 'status') send({ type: 'status', status });
  else if (parsed.type === 'voice-command') handleVoiceCommand(parsed);
  else if (parsed.type === 'disconnect') process.exit(0);
  else if (parsed.type === 'quit') {
    input.close();
    process.exit(0);
  }
});
input.on('close', () => { process.exit(0); });

// A helper that dies before saying hello still has to look recoverable to the supervisor.
const dropAfter = Number(process.env.ECHOPILOT_FAKE_DROP_AFTER_MS ?? '0');
if (Number.isFinite(dropAfter) && dropAfter > 0) {
  setTimeout(() => { process.stderr.write('fake-native-host dropping connection on purpose\n'); process.exit(1); }, dropAfter);
}
