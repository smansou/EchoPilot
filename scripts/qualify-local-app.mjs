#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { verifyPack } from './release/verify-pack.mjs';
import { isDeniedName } from './package-local.mjs';

const appPath = process.argv[2] && resolve(process.argv[2]);
if (!appPath?.endsWith('.app')) throw new Error('Usage: pnpm package:verify <Cleo.app> [--voice]');
const root = resolve(import.meta.dirname, '..');
const appRoot = join(appPath, 'Contents/Resources/app');
const record = JSON.parse(await readFile(join(appRoot, 'local-bundle.json'), 'utf8'));
if (record.kind !== 'echopilot-local-development-bundle' || record.signature !== 'ad-hoc' || record.distributable !== false) {
  throw new Error('The bundle does not carry an honest local-development record');
}
const report = {
  kind: 'echopilot-local-app-qualification', appPath, checkedAt: new Date().toISOString(),
  status: 'incomplete', distributable: false, signature: 'ad-hoc', notarized: false,
  included: record.included, omitted: record.omitted, checks: [],
  releaseBlockers: [
    'Developer ID identity/team and release signing key are unprovisioned placeholders.',
    'No notarized/stapled distributable artifact has been produced.',
    'Full original-ticket quality, device/app/OS matrix and beta reliability measurements remain required.',
    'Native OpenAI/Gemini conversations and cross-app insertion/gaze require provider-key and device acceptance.',
  ],
};
const commands = [
  ['/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]],
  ['/usr/bin/plutil', ['-lint', join(appPath, 'Contents/Info.plist')]],
  [process.execPath, [join(root, 'scripts/smoke.mjs'), '--app', appPath]],
];
const manifest = JSON.parse(await readFile(join(appRoot, 'models/manifest.json'), 'utf8'));
const selectedAssets = manifest.assets.filter((asset) =>
  (asset.kind === 'asr' && record.included.includes('asr-pack'))
  || (asset.kind === 'vad' && record.included.includes('silero-vad')));
const vad = selectedAssets.find((asset) => asset.kind === 'vad');
if (vad) selectedAssets.push({ ...vad, id: `${vad.id}-helper-copy`, path: 'dist/native/EchoPilotVoice.app/Contents/Resources/Silero/silero_vad.mlmodelc' });
report.assets = await verifyPack({ manifest: { assets: selectedAssets }, pack: appRoot });
// Inspect the delivered payload itself, including anything introduced by a native build.
const forbiddenPaths = [];
async function inspectPayload(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    const publicFixture = path === 'fixtures' || path === 'fixtures/bootstrap' || path === 'fixtures/bootstrap/session.jsonl';
    if ((isDeniedName(entry.name) && !publicFixture) || path === 'models/reasoner'
      || (path.startsWith('fixtures/') && !publicFixture)) forbiddenPaths.push(path);
    if (entry.isDirectory()) await inspectPayload(join(directory, entry.name), path);
  }
}
await inspectPayload(appRoot);
report.payloadPrivacy = { forbiddenPaths, publicSmokeFixture: 'fixtures/bootstrap/session.jsonl' };
if (process.argv.includes('--voice')) commands.push([process.execPath, [join(root, 'scripts/voice-smoke.mjs'), '--app', appPath]]);
for (const [command, args] of commands) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: 90_000, maxBuffer: 2 * 1024 * 1024 });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  report.checks.push({ command, args, exitCode: result.status, error: result.error?.message ?? null, output });
  if (result.status !== 0) break;
}
report.status = report.assets.problems.length === 0 && forbiddenPaths.length === 0 && report.checks.length === commands.length && report.checks.every((check) => check.exitCode === 0)
  ? 'local-qualified' : 'incomplete';
report.voiceCaptureRequested = process.argv.includes('--voice');
report.voiceCaptureChecked = report.checks.some((check) => check.args.includes(join(root, 'scripts/voice-smoke.mjs')) && check.exitCode === 0);
const output = join(dirname(appPath), `${appPath.split('/').at(-1)}.qualification.json`);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(`${report.status}: ${output}`);
console.log('Distributable release: blocked (see releaseBlockers in the report).');
if (report.status !== 'local-qualified') process.exitCode = 1;
