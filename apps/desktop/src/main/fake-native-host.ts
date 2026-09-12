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
 */
import { createInterface } from 'node:readline';

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

const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let type: unknown;
  try {
    type = (JSON.parse(trimmed) as { type?: unknown }).type;
  } catch {
    process.stderr.write('fake-native-host ignored a non-JSON command\n');
    return;
  }
  if (type === 'status') send({ type: 'status', status });
  else if (type === 'disconnect') process.exit(0);
  else if (type === 'quit') {
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
