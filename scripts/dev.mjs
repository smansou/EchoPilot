import { spawn, spawnSync } from 'node:child_process';
import { platform } from 'node:os';
import electron from 'electron';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

function run(command, args, label) {
  console.log(`\nEchoPilot · ${label}`);
  const result = spawnSync(command, args, { stdio: 'inherit', env: { ...process.env, CI: 'true' } });
  if (result.error) throw result.error;
  return result.status === 0;
}

if (platform() === 'darwin' && process.env.ECHOPILOT_SKIP_NATIVE_BUILD !== '1') {
  const moduleCache = resolve('native/macos/.build/module-cache');
  mkdirSync(moduleCache, { recursive: true });
  process.env.CLANG_MODULE_CACHE_PATH = moduleCache;
  process.env.SWIFT_MODULECACHE_PATH = moduleCache;
  const native = [
    ['swift', ['build', '--package-path', 'native/macos', '--disable-sandbox'], 'building voice, reasoner, and Keychain helpers'],
    ['bash', ['native/macos/VoiceHelper/build.sh'], 'packaging the local voice helper'],
    ['bash', ['native/macos/Sources/Accessibility/build.sh'], 'building and locally signing the desktop observation helper'],
    ['swift', ['build', '--package-path', 'native/macos/Sources/Execution', '--disable-sandbox'], 'building process observation'],
    ['bash', ['native/macos/Sources/PlatformHost/build.sh'], 'building and locally signing the platform helper'],
    ['bash', ['native/macos/Sources/Gaze/build.sh'], 'building and locally signing the opt-in gaze helper'],
  ];
  for (const [command, args, label] of native) {
    try {
      if (!run(command, args, label)) console.warn(`EchoPilot · ${label} failed; Diagnostics will show this component as unavailable.`);
    } catch (error) {
      console.warn(`EchoPilot · ${label} unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

if (!run(process.execPath, ['scripts/build.mjs'], 'building desktop interface')) process.exit(1);
console.log('\nEchoPilot · opening the desktop app');
const child = spawn(electron, ['.'], { stdio: 'inherit', env: process.env });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.once('error', (error) => { console.error(error); process.exitCode = 1; });
child.once('exit', (code, signal) => { process.exitCode = signal ? 1 : code ?? 1; });
