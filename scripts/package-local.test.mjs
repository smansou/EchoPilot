// Focused tests for scripts/package-local.mjs, the local (ad-hoc, not notarized) macOS bundle
// assembler. Everything runs against temp-directory fixtures with a fake Electron.app and an
// injected execute() stand-in, so no real plutil, codesign, Electron copy, or model pack is ever
// touched; the only real child processes are `node --help` invocations of this script itself.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ARTIFACTS_DIRECTORY,
  BUNDLE_IDENTIFIER,
  LOCAL_BUNDLE_RECORD,
  PRODUCT_NAME,
  PackagingError,
  adhocSignArguments,
  allocateOutputPath,
  buildPayloadPlan,
  findNestedBundles,
  isDeniedName,
  isNarrowReplacement,
  missingRequiredPayload,
  packageLocalApp,
  parseArgs,
  plistPatchArguments,
  plistReadArguments,
  resignHelperArguments,
  resolveElectronApp,
  resolveSileroPack,
  spawnFile,
  usage,
  verifySignArguments,
} from './package-local.mjs';

const SCRIPT_PATH = fileURLToPath(new URL('./package-local.mjs', import.meta.url));
const PLUTIL = '/usr/bin/plutil';
const CODESIGN = '/usr/bin/codesign';
const ELECTRON_PLIST = '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleExecutable</key><string>Electron</string></dict></plist>\n';

async function write(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

/**
 * A complete checkout fixture: package.json, compiled dist output, native helpers, the release
 * status file, model metadata/licenses, the pinned ASR and Silero packs, and the official
 * Electron.app layout the script copies. `voice: false` removes the voice helper, `asr`/`silero`
 * remove the packs, `reasoner` adds a Qwen-shaped pack that must never be bundled.
 */
async function makeFixture(t, { voice = true, asr = true, silero = true, reasoner = false, optionalHelpers = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'echopilot-package-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await write(join(root, 'package.json'), `${JSON.stringify({ name: 'echopilot', version: '0.1.0', private: true, main: 'dist/main/index.cjs' }, null, 2)}\n`);
  await write(join(root, 'scripts', 'build.mjs'), '// fixture build script\n');
  await write(join(root, 'scripts', 'release', 'installers.json'), '{"release":"echopilot-desktop"}\n');
  await write(join(root, 'dist', 'main', 'index.cjs'), '// fixture main\n');
  await write(join(root, 'dist', 'preload', 'index.cjs'), '// fixture preload\n');
  await write(join(root, 'dist', 'renderer', 'index.html'), '<!doctype html><title>Cleo</title>\n');
  await write(join(root, 'dist', 'native', 'PlatformHost'), '#!/bin/sh\nexit 0\n');
  await write(join(root, 'dist', 'native', 'echopilot-desktop'), '#!/bin/sh\nexit 0\n');
  await write(join(root, 'dist', 'native', 'echopilot-secrets'), '#!/bin/sh\nexit 0\n');
  if (voice) await write(join(root, 'dist', 'native', 'EchoPilotVoice.app', 'Contents', 'MacOS', 'echopilot-voice'), '#!/bin/sh\nexit 0\n');
  await write(join(root, 'models', 'manifest.json'), '{"manifestVersion":1}\n');
  await write(join(root, 'models', 'licenses', 'whisper-small-en.LICENSE'), 'fixture license\n');
  await write(join(root, 'fixtures/bootstrap/session.jsonl'), '{"id":"bootstrap-event-001","text":"Public synthetic fixture"}\n');
  if (asr) await write(join(root, 'models', 'asr', 'small.en', 'TextDecoder.mlmodelc', 'coremldata.bin'), 'fixture model\n');
  if (silero) await write(join(root, 'models', 'asr', 'silero_vad.mlmodelc', 'coremldata.bin'), 'fixture vad\n');
  if (reasoner) await write(join(root, 'models', 'reasoner', 'qwen3.5-4b-q4', 'weights.bin'), 'never bundled\n');
  if (optionalHelpers) {
    await write(join(root, 'native', 'macos', '.build', 'release', 'echopilot-secrets'), '#!/bin/sh\nexit 0\n');
    await write(join(root, 'native', 'macos', 'Sources', 'Execution', '.build', 'release', 'echopilot-exec-observation'), '#!/bin/sh\nexit 0\n');
  }
  await write(join(root, 'native', 'macos', 'VoiceHelper', 'entitlements.plist'), '<?xml version="1.0"?>\n<plist version="1.0"><dict/></plist>\n');
  const electronApp = join(root, 'node_modules', 'electron', 'dist', 'Electron.app');
  await write(join(electronApp, 'Contents', 'Info.plist'), ELECTRON_PLIST);
  await write(join(electronApp, 'Contents', 'MacOS', 'Electron'), 'electron binary\n');
  await write(join(electronApp, 'Contents', 'Frameworks', 'Electron Helper.app', 'Contents', 'MacOS', 'Electron Helper'), 'helper\n');
  await write(join(electronApp, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Electron Framework'), 'framework binary\n');
  await write(join(root, 'node_modules', 'electron', 'dist', 'version'), '44.3.0\n');
  return { root, electronApp };
}

/** Records every plutil/codesign/build invocation and answers plutil reads with the patched values. */
function makeExecute({ plistOverrides = {}, failVerify = false, onBuild = null } = {}) {
  const calls = [];
  const execute = async (file, args) => {
    calls.push({ file, args: [...args] });
    if (file === PLUTIL && args[0] === '-extract') {
      const values = {
        CFBundleExecutable: PRODUCT_NAME,
        CFBundleName: PRODUCT_NAME,
        CFBundleDisplayName: PRODUCT_NAME,
        CFBundleIdentifier: BUNDLE_IDENTIFIER,
        CFBundleShortVersionString: '0.1.0',
        ...plistOverrides,
      };
      const value = values[args[1]];
      return value === undefined
        ? { status: 1, stdout: '', stderr: 'missing key', error: null }
        : { status: 0, stdout: `${value}\n`, stderr: '', error: null };
    }
    if (file === CODESIGN && args[0] === '--verify' && failVerify) {
      return { status: 1, stdout: '', stderr: 'code object is not signed at all', error: null };
    }
    if (file === process.execPath && onBuild) await onBuild(args);
    return { status: 0, stdout: '', stderr: '', error: null };
  };
  return { calls, execute };
}

function runPackage(fixture, execute, overrides = {}) {
  return packageLocalApp({
    root: fixture.root,
    electronApp: fixture.electronApp,
    platform: 'darwin',
    execute,
    log: () => {},
    warn: () => {},
    ...overrides,
  });
}

function appRootOf(appPath) {
  return join(appPath, 'Contents', 'Resources', 'app');
}

async function readRecord(appPath) {
  return readJson(join(appRootOf(appPath), LOCAL_BUNDLE_RECORD));
}

test('parseArgs accepts the documented flags and defaults', () => {
  assert.deepEqual(parseArgs([]), {
    help: false, json: false, uiOnly: false, replaceExisting: false, build: true, out: null, electronApp: null,
  });
  const options = parseArgs([
    '--ui-only', '--replace-existing', '--no-build', '--json',
    '--out', '/tmp/Cleo.app', '--electron-app', '/tmp/Electron.app',
  ]);
  assert.equal(options.uiOnly, true);
  assert.equal(options.replaceExisting, true);
  assert.equal(options.build, false);
  assert.equal(options.json, true);
  assert.equal(options.out, '/tmp/Cleo.app');
  assert.equal(options.electronApp, '/tmp/Electron.app');
  assert.equal(parseArgs(['--out=/tmp/Other.app']).out, '/tmp/Other.app');
  assert.equal(parseArgs(['-h']).help, true);
  assert.equal(parseArgs(['--cloud-voice']).uiOnly, true);
});

test('parseArgs rejects unknown flags, missing values and non-.app outputs', () => {
  assert.throws(() => parseArgs(['--out']), PackagingError);
  assert.throws(() => parseArgs(['--out']), /requires a value/);
  assert.throws(() => parseArgs(['--out=']), /requires a value/);
  assert.throws(() => parseArgs(['--electron-app']), /requires a value/);
  assert.throws(() => parseArgs(['--out', '/tmp/not-a-bundle']), /must name a \.app bundle/);
  assert.throws(() => parseArgs(['--wat']), /Unknown argument/);
});

test('plutil and codesign invocations are exact argv arrays, never shell text', () => {
  const plist = '/tmp/My Bundle.app/Contents/Info.plist';
  assert.deepEqual(plistPatchArguments({ plist, version: '1.2.3' }), [
    ['-replace', 'CFBundleExecutable', '-string', 'Cleo', plist],
    ['-replace', 'CFBundleName', '-string', 'Cleo', plist],
    ['-replace', 'CFBundleDisplayName', '-string', 'Cleo', plist],
    ['-replace', 'CFBundleIdentifier', '-string', BUNDLE_IDENTIFIER, plist],
    ['-replace', 'CFBundleShortVersionString', '-string', '1.2.3', plist],
    ['-replace', 'CFBundleVersion', '-string', '1.2.3', plist],
    ['-replace', 'NSMicrophoneUsageDescription', '-string', 'Cleo uses the microphone when you start dictation or a live conversation. Audio is sent to your selected provider.', plist],
    ['-replace', 'NSCameraUsageDescription', '-string', 'Cleo uses the camera only when you enable gaze, to estimate eye direction locally without saving camera frames.', plist],
  ]);
  assert.deepEqual(plistReadArguments(plist), [
    { key: 'CFBundleExecutable', args: ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', plist] },
    { key: 'CFBundleName', args: ['-extract', 'CFBundleName', 'raw', '-o', '-', plist] },
    { key: 'CFBundleDisplayName', args: ['-extract', 'CFBundleDisplayName', 'raw', '-o', '-', plist] },
    { key: 'CFBundleIdentifier', args: ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist] },
    { key: 'CFBundleShortVersionString', args: ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist] },
  ]);
  assert.deepEqual(adhocSignArguments('/tmp/A B.app'), ['--force', '--sign', '-', '--timestamp=none', '/tmp/A B.app']);
  assert.deepEqual(verifySignArguments('/tmp/A B.app'), ['--verify', '--deep', '--strict', '--verbose=2', '/tmp/A B.app']);
  assert.deepEqual(resignHelperArguments({ helperPath: '/tmp/A B.app', entitlements: '/tmp/ent.plist' }), [
    '--force', '--deep', '--options', 'runtime', '--timestamp=none', '--entitlements', '/tmp/ent.plist', '--sign', '-', '/tmp/A B.app',
  ]);
  assert.deepEqual(resignHelperArguments({ helperPath: '/tmp/A B.app' }), [
    '--force', '--deep', '--options', 'runtime', '--timestamp=none', '--sign', '-', '/tmp/A B.app',
  ]);
});

test('findNestedBundles finds helper apps and frameworks deepest first and never follows symlinks', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'echopilot-nested-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const frameworks = join(root, 'Contents', 'Frameworks');
  const helper = join(frameworks, 'Electron Helper.app');
  const framework = join(frameworks, 'Electron Framework.framework');
  const inner = join(framework, 'Versions', 'A', 'Frameworks', 'Inner.framework');
  await write(join(helper, 'Contents', 'MacOS', 'Electron Helper'), 'helper\n');
  await write(join(framework, 'Versions', 'A', 'Electron Framework'), 'framework\n');
  await write(join(inner, 'Versions', 'A', 'Inner'), 'inner\n');
  await symlink('A', join(framework, 'Versions', 'Current'));

  assert.deepEqual(findNestedBundles({ frameworksDirectory: frameworks }), [inner, framework, helper]);
  assert.deepEqual(findNestedBundles({ frameworksDirectory: frameworks, skip: [framework] }), [inner, helper]);
  assert.deepEqual(findNestedBundles({ frameworksDirectory: join(root, 'missing') }), []);
});

test('spawnFile passes arguments literally without a shell', async () => {
  const literal = 'a b;$(echo injected) && echo nope | tee /tmp/nope';
  const result = await spawnFile(process.execPath, ['-e', 'process.stdout.write(process.argv[1] ?? "")', literal], { stdio: 'pipe' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, literal);
});

test('isDeniedName blocks private files and keeps helper names', () => {
  for (const name of [
    'node_modules', '.git', '.env', '.env.local', '.DS_Store', 'fixtures', 'transcripts',
    'auth.json', 'providers.json', 'provider-config.json', 'profiles', 'credentials',
    '__pycache__', 'debug.log',
  ]) {
    assert.equal(isDeniedName(name), true, `${name} should be denied`);
  }
  for (const name of ['echopilot-secrets', 'secrets', 'env.example', 'main', 'silero_vad.mlmodelc', 'settings.json']) {
    assert.equal(isDeniedName(name), false, `${name} should be allowed`);
  }
});

test('resolveElectronApp requires the installed Electron.app', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'echopilot-package-electron-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.throws(() => resolveElectronApp({ root, env: {} }), (error) => error instanceof PackagingError && /pnpm install/.test(error.message));
  const electronApp = join(root, 'node_modules', 'electron', 'dist', 'Electron.app');
  await write(join(electronApp, 'Contents', 'Info.plist'), 'plist\n');
  await write(join(electronApp, 'Contents', 'MacOS', 'Electron'), 'bin\n');
  assert.equal(resolveElectronApp({ root, env: {} }), electronApp);
  const override = join(root, 'elsewhere', 'Electron.app');
  await write(join(override, 'Contents', 'Info.plist'), 'plist\n');
  await write(join(override, 'Contents', 'MacOS', 'Electron'), 'bin\n');
  assert.equal(resolveElectronApp({ root, env: { ECHOPILOT_ELECTRON_APP: override } }), override);
});

test('resolveSileroPack uses the documented lookup order', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'echopilot-package-silero-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(resolveSileroPack({ root }), null);
  await write(join(root, 'models', 'vad', 'silero_vad.mlmodelc', 'coremldata.bin'), 'vad\n');
  assert.deepEqual(resolveSileroPack({ root }), { path: 'models/vad/silero_vad.mlmodelc', kind: 'directory' });
  await write(join(root, 'models', 'asr', 'silero_vad.mlmodel'), 'vad\n');
  assert.equal(resolveSileroPack({ root }).path, 'models/asr/silero_vad.mlmodel');
});

test('buildPayloadPlan includes the pinned ASR and Silero packs and never the reasoner', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'echopilot-package-plan-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await write(join(root, 'models', 'asr', 'small.en', 'sentinel'), 'asr\n');
  await write(join(root, 'models', 'asr', 'silero_vad.mlmodelc', 'sentinel'), 'vad\n');
  const full = buildPayloadPlan({ root });
  const asr = full.entries.find((entry) => entry.id === 'asr-pack');
  assert.equal(asr.source, 'models/asr/small.en');
  assert.equal(asr.destination, 'models/asr/small.en');
  const silero = full.entries.find((entry) => entry.id === 'silero-vad');
  assert.deepEqual(silero.mirror, {
    destination: 'dist/native/EchoPilotVoice.app/Contents/Resources/Silero/silero_vad.mlmodelc',
    resignBundle: 'dist/native/EchoPilotVoice.app',
  });
  assert.ok(full.entries.every((entry) => !/reasoner/.test(entry.source)));
  assert.ok(full.omitted.some((entry) => entry.id === 'local-reasoner'));
  const uiOnly = buildPayloadPlan({ root, uiOnly: true });
  assert.ok(!uiOnly.entries.some((entry) => entry.id === 'asr-pack' || entry.id === 'silero-vad'));
  assert.ok(uiOnly.omitted.some((entry) => entry.id === 'asr-pack' && /--ui-only/.test(entry.reason)));
  assert.ok(uiOnly.omitted.some((entry) => entry.id === 'silero-vad' && /--ui-only/.test(entry.reason)));
});

test('missingRequiredPayload fails closed except for the ui-only voice opt-out', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'echopilot-package-missing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const missing = missingRequiredPayload({ root, uiOnly: false });
  assert.ok(missing.includes('dist/main'));
  assert.ok(missing.includes('dist/native'));
  assert.ok(missing.includes('dist/native/PlatformHost'));
  assert.ok(missing.includes('dist/native/EchoPilotVoice.app/Contents/MacOS/echopilot-voice'));
  assert.ok(missing.includes('scripts/release/installers.json'));
  assert.ok(missing.includes('models/licenses'));
  const uiOnly = missingRequiredPayload({ root, uiOnly: true });
  assert.ok(!uiOnly.some((entry) => entry.includes('EchoPilotVoice.app')));
  assert.ok(uiOnly.includes('dist/native/PlatformHost'));
});

test('allocateOutputPath allocates unique versioned names', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'echopilot-package-alloc-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const stamp = () => '2026-09-30T10:11:12.345Z';
  const first = allocateOutputPath({ base, version: '0.1.0', stamp, nonce: () => 'aaaaaa' });
  assert.equal(first, join(base, 'Cleo-0.1.0-2026-09-30-101112Z-aaaaaa.app'));
  await mkdir(first);
  const nonces = ['aaaaaa', 'bbbbbb'];
  const second = allocateOutputPath({ base, version: '0.1.0', stamp, nonce: () => nonces.shift() });
  assert.equal(second, join(base, 'Cleo-0.1.0-2026-09-30-101112Z-bbbbbb.app'));
});

test('isNarrowReplacement only accepts Cleo-*.app inside the artifacts directory', () => {
  const root = '/repo';
  const base = join(root, ARTIFACTS_DIRECTORY);
  assert.equal(isNarrowReplacement({ root, output: join(base, 'Cleo-0.1.0-stamp-nonce.app') }), true);
  assert.equal(isNarrowReplacement({ root, output: join(root, 'artifacts', 'Cleo-0.1.0.app') }), false);
  assert.equal(isNarrowReplacement({ root, output: base }), false);
  assert.equal(isNarrowReplacement({ root, output: join(base, 'Other.app') }), false);
  assert.equal(isNarrowReplacement({ root, output: join(base, 'Cleo.app') }), false);
});

test('packageLocalApp rejects non-macOS hosts', async (t) => {
  const fixture = await makeFixture(t);
  const { execute } = makeExecute();
  await assert.rejects(runPackage(fixture, execute, { platform: 'linux' }), /requires macOS/);
});

test('packageLocalApp requires a complete Electron.app', async (t) => {
  const fixture = await makeFixture(t);
  const { execute } = makeExecute();
  const incomplete = await mkdtemp(join(tmpdir(), 'echopilot-package-incomplete-'));
  t.after(() => rm(incomplete, { recursive: true, force: true }));
  await assert.rejects(runPackage(fixture, execute, { electronApp: incomplete }), /has no Contents\/MacOS\/Electron/);
});

test('packageLocalApp preserves relative Electron framework links inside the delivered bundle', async (t) => {
  const fixture = await makeFixture(t);
  const framework = join(fixture.electronApp, 'Contents/Frameworks/Test.framework');
  await write(join(framework, 'Versions/A/Resources/test.txt'), 'framework resource');
  await symlink('A', join(framework, 'Versions/Current'));
  await symlink('Versions/Current/Resources', join(framework, 'Resources'));
  const { execute } = makeExecute();
  const summary = await runPackage(fixture, execute);
  const delivered = join(summary.appPath, 'Contents/Frameworks/Test.framework');
  assert.equal(await readlink(join(delivered, 'Versions/Current')), 'A');
  assert.equal(await readlink(join(delivered, 'Resources')), 'Versions/Current/Resources');
  assert.equal(await readFile(join(delivered, 'Resources/test.txt'), 'utf8'), 'framework resource');
});

test('packageLocalApp assembles an Cleo bundle with the official Electron identity', async (t) => {
  const fixture = await makeFixture(t, { reasoner: true, optionalHelpers: true });
  const { calls, execute } = makeExecute();
  const summary = await runPackage(fixture, execute);

  assert.equal(summary.mode, 'full');
  assert.equal(summary.signature, 'ad-hoc');
  assert.equal(summary.notarized, false);
  assert.equal(summary.distributable, false);
  assert.equal(summary.version, '0.1.0');
  assert.equal(summary.electronVersion, '44.3.0');
  assert.equal(summary.openCommand, `open "${summary.appPath}"`);
  assert.match(basename(summary.appPath), /^Cleo-0\.1\.0-.+\.app$/);
  assert.ok(summary.appPath.startsWith(join(fixture.root, ARTIFACTS_DIRECTORY)));
  assert.deepEqual(summary.warnings, []);

  const out = summary.appPath;
  assert.ok(existsSync(join(out, 'Contents', 'MacOS', 'Cleo')), 'the executable is renamed');
  assert.ok(!existsSync(join(out, 'Contents', 'MacOS', 'Electron')), 'the Electron binary name is gone');
  const appRoot = appRootOf(out);
  assert.deepEqual(await readJson(join(appRoot, 'package.json')), {
    name: 'echopilot', productName: 'Cleo', version: '0.1.0', private: true, main: 'dist/main/index.cjs',
  });
  for (const relativePath of [
    'dist/main/index.cjs',
    'dist/preload/index.cjs',
    'dist/renderer/index.html',
    'dist/native/PlatformHost',
    'dist/native/echopilot-desktop',
    'dist/native/EchoPilotVoice.app/Contents/MacOS/echopilot-voice',
    'dist/native/echopilot-secrets',
    'dist/native/echopilot-exec-observation',
    'scripts/release/installers.json',
    'fixtures/bootstrap/session.jsonl',
    'models/manifest.json',
    'models/licenses/whisper-small-en.LICENSE',
    'models/asr/small.en/TextDecoder.mlmodelc/coremldata.bin',
    'dist/native/EchoPilotVoice.app/Contents/Resources/Silero/silero_vad.mlmodelc/coremldata.bin',
  ]) {
    assert.ok(existsSync(join(appRoot, relativePath)), `expected ${relativePath} in the bundle`);
  }
  assert.ok(!existsSync(join(appRoot, 'models', 'reasoner')), 'the optional reasoner pack is never copied');
  assert.ok(!existsSync(join(appRoot, 'node_modules')), 'dependencies never travel into the bundle');

  const record = await readRecord(out);
  assert.equal(record.kind, 'echopilot-local-development-bundle');
  assert.equal(record.mode, 'full');
  assert.equal(record.signature, 'ad-hoc');
  assert.equal(record.notarized, false);
  assert.equal(record.distributable, false);
  assert.equal(record.electronVersion, '44.3.0');
  for (const id of [
    'dist-main', 'dist-preload', 'dist-renderer', 'dist-native', 'release-policy', 'model-manifest',
    'model-licenses', 'asr-pack', 'silero-vad', 'secrets-helper', 'execution-helper',
  ]) {
    assert.ok(record.included.includes(id), `record should include ${id}`);
  }
  assert.ok(record.omitted.some((entry) => entry.id === 'local-reasoner'));
  assert.ok(!record.omitted.some((entry) => entry.id === 'asr-pack'));
  assert.ok(!record.omitted.some((entry) => entry.id === 'silero-vad'));

  const plutilCalls = calls.filter((call) => call.file === PLUTIL);
  const patchCalls = plutilCalls.filter((call) => call.args[0] === '-replace').map((call) => call.args);
  assert.equal(patchCalls.length, 8);
  const stagedPlist = patchCalls[0].at(-1);
  assert.match(stagedPlist, /\.staging-[^/]+\/Cleo\.app\/Contents\/Info\.plist$/);
  assert.deepEqual(patchCalls, plistPatchArguments({ plist: stagedPlist, version: '0.1.0' }));
  const stagedApp = stagedPlist.replace(/\/Contents\/Info\.plist$/, '');
  assert.deepEqual(plutilCalls.find((call) => call.args[0] === '-lint').args, ['-lint', stagedPlist]);
  assert.deepEqual(
    plutilCalls.filter((call) => call.args[0] === '-extract').map((call) => call.args),
    plistReadArguments(stagedPlist).map(({ args }) => args),
  );

  const codesignCalls = calls.filter((call) => call.file === CODESIGN).map((call) => call.args);
  const nestedBundles = [
    join(stagedApp, 'Contents', 'Frameworks', 'Electron Helper.app'),
    join(stagedApp, 'Contents', 'Frameworks', 'Electron Framework.framework'),
  ];
  const nestedSignIndices = nestedBundles.map((bundlePath) => codesignCalls.findIndex((args) => args.at(-1) === bundlePath));
  for (const [position, bundlePath] of nestedBundles.entries()) {
    assert.notEqual(nestedSignIndices[position], -1, `${basename(bundlePath)} is re-signed as a bundle`);
    assert.deepEqual(codesignCalls[nestedSignIndices[position]], adhocSignArguments(bundlePath));
  }
  const voiceBundle = join(stagedApp, 'Contents', 'Resources', 'app', 'dist', 'native', 'EchoPilotVoice.app');
  const helperSignIndex = codesignCalls.findIndex((args) => args.at(-1) === voiceBundle);
  assert.notEqual(helperSignIndex, -1, 'the nested voice helper is re-signed after the Silero mirror');
  assert.deepEqual(codesignCalls[helperSignIndex], resignHelperArguments({
    helperPath: voiceBundle,
    entitlements: join(fixture.root, 'native', 'macos', 'VoiceHelper', 'entitlements.plist'),
  }));
  const signIndex = codesignCalls.findIndex((args) => args.includes('--sign') && args.at(-1) === stagedApp);
  const verifyIndex = codesignCalls.findIndex((args) => args[0] === '--verify');
  assert.deepEqual(codesignCalls[signIndex], adhocSignArguments(stagedApp));
  assert.deepEqual(codesignCalls[verifyIndex], verifySignArguments(stagedApp));
  assert.ok(Math.max(...nestedSignIndices) < helperSignIndex, 'Electron helpers and frameworks are re-signed before the voice helper');
  assert.ok(helperSignIndex < signIndex && signIndex < verifyIndex, 'nested code is re-signed before the outer bundle, which is verified last');
});

test('packageLocalApp copies only whitelisted payload and skips symlinks that leave the repository', async (t) => {
  const fixture = await makeFixture(t);
  const renderer = join(fixture.root, 'dist', 'renderer');
  await write(join(renderer, 'nested', 'app.js'), '// nested\n');
  await write(join(renderer, '.env'), 'SECRET=1\n');
  await write(join(renderer, '.env.local'), 'SECRET=2\n');
  await write(join(renderer, '.DS_Store'), 'junk\n');
  await write(join(renderer, 'debug.log'), 'log\n');
  await write(join(renderer, 'auth.json'), '{}\n');
  await write(join(renderer, 'providers.json'), '{}\n');
  await write(join(renderer, 'provider-config.json'), '{}\n');
  await write(join(renderer, 'fixtures', 'secret.json'), '{}\n');
  await write(join(renderer, 'transcripts', 'session.txt'), 'spoken words\n');
  await write(join(renderer, 'profiles', 'default.json'), '{}\n');
  await write(join(renderer, 'credentials', 'token'), 'token\n');
  await write(join(renderer, 'node_modules', 'pkg', 'index.js'), '// dependency\n');

  const outside = await mkdtemp(join(tmpdir(), 'echopilot-package-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await write(join(outside, 'private.txt'), 'outside the repository\n');
  await symlink(join(outside, 'private.txt'), join(renderer, 'leak-absolute.txt'));
  await symlink(relative(renderer, join(outside, 'private.txt')), join(renderer, 'leak-relative.txt'));
  await symlink(join(renderer, 'nested', 'app.js'), join(renderer, 'internal-link.js'));

  const { execute } = makeExecute();
  const summary = await runPackage(fixture, execute);
  const copiedRenderer = join(appRootOf(summary.appPath), 'dist', 'renderer');
  assert.ok(existsSync(join(copiedRenderer, 'index.html')));
  assert.ok(existsSync(join(copiedRenderer, 'nested', 'app.js')));
  for (const denied of [
    '.env', '.env.local', '.DS_Store', 'debug.log', 'auth.json', 'providers.json',
    'provider-config.json', 'fixtures', 'transcripts', 'profiles', 'credentials',
    'node_modules', 'leak-absolute.txt', 'leak-relative.txt',
  ]) {
    assert.ok(!existsSync(join(copiedRenderer, denied)), `${denied} must not be bundled`);
  }
  assert.ok((await lstat(join(copiedRenderer, 'internal-link.js'))).isSymbolicLink(), 'internal symlinks survive');
  assert.equal(summary.warnings.filter((warning) => warning.includes('leaves the repository')).length, 2);
  const record = await readRecord(summary.appPath);
  assert.equal(record.omitted.filter((entry) => entry.id === 'skipped-symlink').length, 2);
});

test('packageLocalApp fails closed on missing compiled payload and creates nothing', async (t) => {
  const fixture = await makeFixture(t);
  await rm(join(fixture.root, 'dist', 'native'), { recursive: true, force: true });
  const { calls, execute } = makeExecute();
  await assert.rejects(runPackage(fixture, execute), (error) => {
    assert.ok(error instanceof PackagingError);
    assert.match(error.message, /dist\/native/);
    assert.match(error.message, /pnpm dev/);
    return true;
  });
  assert.equal(calls.length, 0, 'nothing runs when the payload is missing');
  assert.ok(!existsSync(join(fixture.root, ARTIFACTS_DIRECTORY)), 'no artifact directory is created');
});

test('cloud voice packaging refuses to ship without the Keychain helper',async(t)=>{
  const fixture=await makeFixture(t,{voice:false,asr:false,silero:false});
  await rm(join(fixture.root,'dist/native/echopilot-secrets'));
  const {calls,execute}=makeExecute();
  await assert.rejects(runPackage(fixture,execute,{uiOnly:true}),/echopilot-secrets/);
  assert.equal(calls.length,0);
});

test('packageLocalApp builds the TypeScript bundle once when only dist output is missing', async (t) => {
  const fixture = await makeFixture(t);
  for (const relativePath of ['dist/main', 'dist/preload', 'dist/renderer']) {
    await rm(join(fixture.root, relativePath), { recursive: true, force: true });
  }
  const { calls, execute } = makeExecute({
    onBuild: async () => {
      await write(join(fixture.root, 'dist', 'main', 'index.cjs'), '// rebuilt main\n');
      await write(join(fixture.root, 'dist', 'preload', 'index.cjs'), '// rebuilt preload\n');
      await write(join(fixture.root, 'dist', 'renderer', 'index.html'), '<!doctype html>\n');
    },
  });
  const summary = await runPackage(fixture, execute);
  const buildCalls = calls.filter((call) => call.file === process.execPath);
  assert.equal(buildCalls.length, 1);
  assert.deepEqual(buildCalls[0].args, [join(fixture.root, 'scripts', 'build.mjs')]);
  assert.ok(existsSync(join(appRootOf(summary.appPath), 'dist', 'main', 'index.cjs')));

  const noBuild = await makeFixture(t);
  for (const relativePath of ['dist/main', 'dist/preload', 'dist/renderer']) {
    await rm(join(noBuild.root, relativePath), { recursive: true, force: true });
  }
  const second = makeExecute();
  await assert.rejects(runPackage(noBuild, second.execute, { build: false }), /dist\/main/);
  assert.equal(second.calls.filter((call) => call.file === process.execPath).length, 0);
});

test('packageLocalApp refreshes existing dist rather than packaging stale source output', async (t) => {
  const fixture = await makeFixture(t);
  const runner = makeExecute({ onBuild: () => write(join(fixture.root, 'dist/main/index.cjs'), '// refreshed build\n') });
  const summary = await runPackage(fixture, runner.execute);
  assert.equal(await readFile(join(appRootOf(summary.appPath), 'dist/main/index.cjs'), 'utf8'), '// refreshed build\n');
  assert.equal(runner.calls.filter((call) => call.file === process.execPath).length, 1);
});

test('packageLocalApp preserves an existing bundle unless replacement is narrow and explicit', async (t) => {
  const fixture = await makeFixture(t);
  const { execute } = makeExecute();
  const existing = join(fixture.root, ARTIFACTS_DIRECTORY, 'Cleo-0.1.0-old.app');
  await write(join(existing, 'marker.txt'), 'keep me\n');

  await assert.rejects(runPackage(fixture, execute, { out: existing }), /Refusing to overwrite/);
  assert.ok(existsSync(join(existing, 'marker.txt')), 'the existing bundle is untouched');

  const outside = join(fixture.root, 'Cleo-outside.app');
  await write(join(outside, 'marker.txt'), 'keep me\n');
  await assert.rejects(
    runPackage(fixture, execute, { out: outside, replaceExisting: true }),
    /may only replace/,
  );
  assert.ok(existsSync(join(outside, 'marker.txt')), 'replacement outside the artifacts directory is refused');
  const misnamed = join(fixture.root, 'artifacts', 'local-app', 'NotCleo.app');
  await write(join(misnamed, 'marker.txt'), 'keep me\n');
  await assert.rejects(
    runPackage(fixture, execute, { out: misnamed, replaceExisting: true }),
    /may only replace/,
  );
  assert.ok(existsSync(join(misnamed, 'marker.txt')), 'a differently named bundle is never replaced');

  const summary = await runPackage(fixture, execute, { out: existing, replaceExisting: true });
  assert.equal(summary.appPath, existing);
  assert.ok(existsSync(join(existing, 'Contents', 'MacOS', 'Cleo')));
  assert.ok(!existsSync(join(existing, 'marker.txt')), 'an explicitly replaced bundle is rebuilt');
});

test('packageLocalApp does not delete an existing bundle when packaging would fail', async (t) => {
  const fixture = await makeFixture(t);
  await rm(join(fixture.root, 'dist', 'native'), { recursive: true, force: true });
  const existing = join(fixture.root, ARTIFACTS_DIRECTORY, 'Cleo-0.1.0-old.app');
  await write(join(existing, 'marker.txt'), 'keep me\n');
  const { execute } = makeExecute();
  await assert.rejects(runPackage(fixture, execute, { out: existing, replaceExisting: true }), /dist\/native/);
  assert.ok(existsSync(join(existing, 'marker.txt')), 'validation runs before any removal');
});

test('packageLocalApp cleans staging when signing or plist rewriting fails', async (t) => {
  const fixture = await makeFixture(t);
  const failing = makeExecute({ failVerify: true });
  await assert.rejects(runPackage(fixture, failing.execute), /verifying the bundle signature failed/);
  assert.deepEqual(await readdir(join(fixture.root, ARTIFACTS_DIRECTORY)), [], 'no staging survives a failure');

  const mismatched = makeExecute({ plistOverrides: { CFBundleExecutable: 'Electron' } });
  await assert.rejects(runPackage(fixture, mismatched.execute), /CFBundleExecutable/);
  assert.deepEqual(await readdir(join(fixture.root, ARTIFACTS_DIRECTORY)), [], 'no staging survives a plist failure');
});

test('packageLocalApp ui-only mode labels the missing voice assets', async (t) => {
  const fixture = await makeFixture(t, { voice: false, asr: false, silero: false });
  const { calls, execute } = makeExecute();
  const summary = await runPackage(fixture, execute, { uiOnly: true });
  assert.equal(summary.mode, 'cloud-voice');
  assert.deepEqual(summary.warnings, []);
  const appRoot = appRootOf(summary.appPath);
  assert.ok(!existsSync(join(appRoot, 'models', 'asr')), 'voice models stay out of a ui-only bundle');
  assert.ok(!existsSync(join(appRoot, 'dist', 'native', 'EchoPilotVoice.app')));
  const record = await readRecord(summary.appPath);
  assert.equal(record.mode, 'cloud-voice');
  for (const id of ['asr-pack', 'silero-vad']) {
    const entry = record.omitted.find((item) => item.id === id);
    assert.ok(entry, `${id} should be recorded as omitted`);
    assert.match(entry.reason, /--ui-only/);
  }
  assert.ok(!calls.some((call) => call.file === CODESIGN && call.args.at(-1).endsWith('EchoPilotVoice.app')));

  await assert.rejects(runPackage(fixture, execute), /EchoPilotVoice\.app/);

  const noNative = await makeFixture(t, { voice: false, asr: false, silero: false });
  await rm(join(noNative.root, 'dist', 'native'), { recursive: true, force: true });
  await assert.rejects(runPackage(noNative, execute, { uiOnly: true }), /dist\/native/);
});

test('the packaging script keeps its local, no-download, no-install contract', async () => {
  const source = await readFile(SCRIPT_PATH, 'utf8');
  assert.ok(source.includes('shell: false'), 'children are spawned without a shell');
  assert.ok(!/shell:\s*true/.test(source));
  assert.ok(!/['"]\/Applications/.test(source), 'nothing is written to /Applications');
  assert.ok(!/\b(curl|wget)\b/.test(source), 'nothing is downloaded');
  assert.ok(!source.includes('https://'), 'no network endpoints are referenced');
  assert.ok(!source.includes('execSync'), 'no shell-interpolated execution');
});

test('--help prints usage and exits without packaging', async () => {
  assert.match(usage(), /--ui-only/);
  assert.match(usage(), /--replace-existing/);
  assert.match(usage(), /notariz/i);
  const result = await spawnFile(process.execPath, [SCRIPT_PATH, '--help'], { stdio: 'pipe' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--electron-app/);
  assert.match(result.stdout, /artifacts\/local-app/);
});
