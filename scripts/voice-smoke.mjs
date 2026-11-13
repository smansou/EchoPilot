import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import electron from 'electron';

const profile = await mkdtemp(join(tmpdir(), 'echopilot-voice-smoke-'));
const appIndex = process.argv.indexOf('--app');
const appBundle = appIndex === -1 ? null : process.argv[appIndex + 1];
if (appIndex !== -1 && (!appBundle || !appBundle.endsWith('.app'))) throw new Error('--app requires the path to a packaged .app bundle');
const executable = appBundle ? join(appBundle, 'Contents', 'MacOS', 'Cleo') : electron;
try {
  await new Promise((resolve, reject) => {
    const child = spawn(executable, [...(appBundle ? [] : ['.']), '--voice-smoke', `--profile=${profile}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Voice smoke timed out. ${stderr}`));
    }, 40_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      const passed = stdout.split('\n').some((line) => line.startsWith('ECHOPILOT_VOICE_SMOKE '));
      if (code === 0 && passed) resolve(undefined);
      else reject(new Error(`Voice smoke exited ${code}. ${stderr}`));
    });
  });
  console.log('PASS: local microphone opened, Whisper models loaded, then capture and models were released.');
} finally {
  await rm(profile, { recursive: true, force: true });
}
