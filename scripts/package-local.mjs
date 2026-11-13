#!/usr/bin/env node
// Local macOS .app packaging for Cleo.
//
// This assembles an *openable local development bundle* — not a release artifact:
//   - the official Electron.app already installed in node_modules is copied into a uniquely
//     allocated staging directory under artifacts/local-app (nothing is downloaded);
//   - the compiled `dist` output, the release status file, and the on-disk model metadata and
//     licenses are assembled into Contents/Resources/app, the app.getAppPath() root the runtime
//     resolves dist/..., models/..., workers/... and scripts/release/installers.json from;
//   - the bundle is renamed to Cleo with the stable local identifier
//     com.echopilot.desktop.local and is ad-hoc signed and verified.
//
// There is no Developer ID signature, no notarization, no application-secret access, no Apple account or
// credential, no network fetch, and no write outside the repository (default output:
// artifacts/local-app). If explicitly configured, its private build keychain supplies a stable
// local signing identity. apps/desktop/forge.config.ts with scripts/release/* remains the
// (currently unprovisioned) distributable release path. Run with --help for options; see
// docs/LOCAL_APP.md for the bundle contract and the remaining gates.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, readFile, readlink, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {localSigning,signingArguments} from './local-signing.mjs';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PRODUCT_NAME = 'Cleo';
export const BUNDLE_IDENTIFIER = 'com.echopilot.desktop.local';
export const BUNDLE_DIRECTORY = `${PRODUCT_NAME}.app`;
export const ARTIFACTS_DIRECTORY = join('artifacts', 'local-app');
/** Machine-readable record written into the bundle; it says plainly that this is not a release. */
export const LOCAL_BUNDLE_RECORD = 'local-bundle.json';

const PLUTIL = '/usr/bin/plutil';
const CODESIGN = '/usr/bin/codesign';
const ELECTRON_BINARY = 'Electron';

/** A packaging precondition failed; the message is written to be printed verbatim. */
export class PackagingError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PackagingError';
  }
}

export function usage() {
  return [
    'Local Cleo .app packaging (ad-hoc development bundle; no Developer ID, no notarization).',
    '',
    '  pnpm package [options]',
    '',
    'Options:',
    `  --out <path>.app       Output bundle path (default: ${ARTIFACTS_DIRECTORY}/${PRODUCT_NAME}-<version>-<stamp>-<nonce>.app)`,
    '  --cloud-voice          Native cloud voice bundle without offline ASR/VAD model packs',
    '  --ui-only              Legacy alias for --cloud-voice',
    `  --replace-existing     Replace an existing ${PRODUCT_NAME}-*.app inside ${ARTIFACTS_DIRECTORY} (never on by default)`,
    '  --no-build             Package existing dist output without refreshing the TypeScript build',
    '  --electron-app <path>  Override the source Electron.app (default: node_modules/electron/dist/Electron.app)',
    '  --json                 Print the machine-readable summary instead of the human summary',
    '  --help                 Show this help',
    '',
    `The bundle is written under ${ARTIFACTS_DIRECTORY} unless --out is given; nothing is installed`,
    'into /Applications, nothing is downloaded, and no Apple credential is read.',
  ].join('\n');
}

export function parseArgs(argv = []) {
  const options = { help: false, json: false, uiOnly: false, replaceExisting: false, build: true, out: null, electronApp: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const separator = argument.startsWith('--') ? argument.indexOf('=') : -1;
    const flag = separator === -1 ? argument : argument.slice(0, separator);
    const inline = separator === -1 ? null : argument.slice(separator + 1);
    const value = () => {
      if (inline !== null) {
        if (inline === '') throw new PackagingError(`${flag} requires a value`);
        return inline;
      }
      index += 1;
      const next = argv[index];
      if (next === undefined) throw new PackagingError(`${flag} requires a value`);
      return next;
    };
    switch (flag) {
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--cloud-voice':
      case '--ui-only':
        options.uiOnly = true;
        break;
      case '--replace-existing':
        options.replaceExisting = true;
        break;
      case '--no-build':
        options.build = false;
        break;
      case '--out':
        options.out = value();
        break;
      case '--electron-app':
        options.electronApp = value();
        break;
      default:
        throw new PackagingError(`Unknown argument: ${argument}\n\n${usage()}`);
    }
  }
  if (options.out !== null && !options.out.endsWith('.app')) {
    throw new PackagingError(`--out must name a .app bundle, received: ${options.out}`);
  }
  return options;
}

/** spawn() without a shell: every argument stays exactly one argv entry. */
export function spawnFile(file, args, { stdio = 'inherit', env } = {}) {
  return new Promise((settle) => {
    const child = spawn(file, args, { stdio, shell: false, env });
    let stdout = '';
    let stderr = '';
    if (child.stdout) child.stdout.on('data', (chunk) => { stdout += chunk; });
    if (child.stderr) child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => settle({ status: null, signal: null, stdout, stderr, error }));
    child.once('exit', (code, signal) => settle({ status: code, signal, stdout, stderr, error: null }));
  });
}

export const defaultExecute = (file, args, options) => spawnFile(file, args, options);

async function run(execute, command, args, label) {
  const result = await execute(command, args, { stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    const detail = result.error ? ` (${result.error.message})` : '';
    throw new PackagingError(`${label} failed${detail}: ${command} ${args.join(' ')}`);
  }
  return result;
}

/** The official Electron.app shipped by the installed `electron` dependency; never downloaded. */
export function resolveElectronApp({ root = REPO_ROOT, env = process.env, exists = existsSync } = {}) {
  const candidates = [
    env.ECHOPILOT_ELECTRON_APP,
    join(root, 'node_modules', 'electron', 'dist', 'Electron.app'),
  ].filter((candidate) => typeof candidate === 'string' && candidate.length > 0).map((candidate) => resolve(candidate));
  for (const candidate of candidates) {
    if (exists(join(candidate, 'Contents', 'Info.plist')) && exists(join(candidate, 'Contents', 'MacOS', ELECTRON_BINARY))) {
      return candidate;
    }
  }
  throw new PackagingError(
    `The official Electron.app is not installed (looked in: ${candidates.join(', ')}).\n` +
    `Run 'pnpm install --frozen-lockfile' first; packaging never downloads a browser runtime.`,
  );
}

/** Names that never travel into the bundle, wherever a whitelisted directory is copied. */
const DENIED_NAMES = new Set([
  'node_modules', '.git', '.env', '.DS_Store', 'fixtures', 'transcripts',
  'auth.json', 'providers.json', 'provider-config.json', 'profiles', 'credentials',
  '__pycache__',
]);

export function isDeniedName(name) {
  return DENIED_NAMES.has(name) || name.startsWith('.env.') || name.endsWith('.log');
}

/** Silero VAD packs the runtime and the voice helper accept, in lookup order. */
export const SILERO_CANDIDATES = [
  { path: 'models/asr/silero_vad.mlmodelc', kind: 'directory' },
  { path: 'models/asr/silero_vad.mlmodel', kind: 'file' },
  { path: 'models/vad/silero_vad.mlmodelc', kind: 'directory' },
];

export function resolveSileroPack({ root = REPO_ROOT, exists = existsSync, candidates = SILERO_CANDIDATES } = {}) {
  return candidates.find((candidate) => exists(join(root, candidate.path))) ?? null;
}

/** Compiled payload every bundle carries; the runtime resolves these through app.getAppPath(). */
export const REQUIRED_PAYLOAD = [
  { id: 'app-icon', source: 'assets/branding/cleo.icns', kind: 'file' },
  { id: 'secrets-helper', source: 'dist/native/echopilot-secrets', kind: 'file' },
  { id: 'dist-main', source: 'dist/main', kind: 'directory' },
  { id: 'dist-preload', source: 'dist/preload', kind: 'directory' },
  { id: 'dist-renderer', source: 'dist/renderer', kind: 'directory' },
  { id: 'dist-native', source: 'dist/native', kind: 'directory' },
  { id: 'release-policy', source: 'scripts/release/installers.json', kind: 'file' },
  { id: 'model-manifest', source: 'models/manifest.json', kind: 'file' },
  { id: 'model-licenses', source: 'models/licenses', kind: 'directory' },
  // One checked-in public synthetic event is needed by --smoke on a fresh disposable profile.
  // No recursive fixtures directory is copied; all other fixtures remain denied.
  { id: 'smoke-fixture', source: 'fixtures/bootstrap/session.jsonl', kind: 'file' },
];

/** Native helpers `pnpm dev` builds; `voice: true` entries are the ones --ui-only may omit. */
export const REQUIRED_NATIVE_HELPERS = [
  { id: 'platform-host', paths: ['dist/native/PlatformHost'], voice: false },
  { id: 'desktop-observation', paths: ['dist/native/echopilot-desktop'], voice: false },
  { id: 'voice-helper', paths: ['dist/native/EchoPilotVoice.app/Contents/MacOS/echopilot-voice', 'dist/native/echopilot-voice'], voice: true },
];

/** Compiled-but-optional helpers the packaged runtime looks up bundle-relative, when built. */
export const OPTIONAL_HELPER_GROUPS = [
  {
    id: 'execution-helper',
    candidates: [
      { source: 'native/macos/Sources/Execution/.build/release/echopilot-exec-observation', destination: 'dist/native/echopilot-exec-observation' },
      { source: 'native/macos/Sources/Execution/.build/debug/echopilot-exec-observation', destination: 'dist/native/echopilot-exec-observation' },
    ],
  },
];

export function buildPayloadPlan({ root = REPO_ROOT, uiOnly = false, silero = null, exists = existsSync } = {}) {
  const entries = REQUIRED_PAYLOAD.map((entry) => ({ ...entry, destination: entry.source, required: true, voice: false }));
  const warnings = [];
  // The optional local reasoner is deliberately never copied by this script: it is a multi-gigabyte
  // pack for a separate runtime host, so the record says so instead of the bundle silently lacking it.
  const omitted = [{
    id: 'local-reasoner',
    reason: 'the optional local reasoning pack (models/reasoner/qwen3.5-4b-q4) is never copied into a local development bundle',
  }];
  if (uiOnly) {
    omitted.push({ id: 'asr-pack', reason: '--ui-only deliberately skips voice assets so the bundle assembles without the Whisper pack' });
    omitted.push({ id: 'silero-vad', reason: '--ui-only deliberately skips voice assets' });
  } else {
    const asr = 'models/asr/small.en';
    if (exists(join(root, asr))) {
      entries.push({ id: 'asr-pack', source: asr, destination: asr, kind: 'directory', required: false, voice: true });
    } else {
      warnings.push(`No ASR pack at ${asr}; the bundle will report dictation unavailable (vendor it with 'pnpm models:asr').`);
      omitted.push({ id: 'asr-pack', reason: 'not present in this checkout' });
    }
    const pack = silero ?? resolveSileroPack({ root, exists });
    if (pack) {
      entries.push({
        id: 'silero-vad',
        source: pack.path,
        destination: pack.path,
        kind: pack.kind,
        required: false,
        voice: true,
        // The voice helper resolves its VAD pack from its own bundle, so the pack also travels
        // into EchoPilotVoice.app/Contents/Resources/Silero (that copy forces a helper re-sign).
        mirror: {
          destination: `dist/native/EchoPilotVoice.app/Contents/Resources/Silero/${basename(pack.path)}`,
          resignBundle: 'dist/native/EchoPilotVoice.app',
        },
      });
    } else {
      warnings.push('No Silero VAD pack found (models/asr/silero_vad.mlmodelc, models/asr/silero_vad.mlmodel, or models/vad/silero_vad.mlmodelc); packaged voice fails closed without it.');
      omitted.push({ id: 'silero-vad', reason: 'not present in this checkout' });
    }
  }
  for (const group of OPTIONAL_HELPER_GROUPS) {
    const candidate = group.candidates.find(({ source }) => exists(join(root, source)));
    if (candidate) {
      entries.push({ id: group.id, source: candidate.source, destination: candidate.destination, kind: 'file', required: false, voice: false, optional: true });
    } else {
      omitted.push({ id: group.id, reason: 'not built in this checkout (optional; pnpm dev builds it when the toolchain allows)' });
    }
  }
  return { entries, warnings, omitted };
}

export function missingRequiredPayload({ root = REPO_ROOT, uiOnly = false, exists = existsSync } = {}) {
  const missing = [];
  for (const entry of REQUIRED_PAYLOAD) if (!exists(join(root, entry.source))) missing.push(entry.source);
  for (const helper of REQUIRED_NATIVE_HELPERS) {
    if (uiOnly && helper.voice) continue;
    if (!helper.paths.some((relativePath) => exists(join(root, relativePath)))) missing.push(helper.paths[0]);
  }
  return missing;
}

function missingPayloadMessage(missing, uiOnly) {
  const hints = [];
  if (missing.some((relativePath) => relativePath.startsWith('dist/native'))) {
    hints.push(`The Swift native helpers are built by 'pnpm dev' (native/macos build scripts); 'pnpm build' does not build them.`);
  }
  if (missing.some((relativePath) => /^dist\/(main|preload|renderer)\//.test(relativePath))) {
    hints.push(`The compiled interface is built by 'pnpm dev' or 'pnpm build'.`);
  }
  if (missing.some((relativePath) => relativePath.startsWith('models/'))) {
    hints.push('Model metadata and licenses are checked into the repository; restore them from git.');
  }
  if (missing.includes('scripts/release/installers.json')) {
    hints.push('The release status file is checked into the repository; restore it from git.');
  }
  if (uiOnly) hints.push('--ui-only relaxes only the voice helper and voice model assets; it never replaces other missing payload.');
  return [
    'The bundle cannot be assembled without its compiled payload:',
    ...missing.map((relativePath) => `  - ${relativePath}`),
    ...hints.map((hint) => `Hint: ${hint}`),
  ].join('\n');
}

export function isNarrowReplacement({ root = REPO_ROOT, output, base = join(root, ARTIFACTS_DIRECTORY) }) {
  const inside = relative(resolve(base), resolve(output));
  return inside !== '' && inside !== '..' && !inside.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(inside)
    && new RegExp(`^${PRODUCT_NAME}-.+\\.app$`).test(basename(output));
}

export function allocateOutputPath({ base, version, stamp = () => new Date().toISOString(), nonce = () => randomUUID().replace(/-/g, '').slice(0, 6) }) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const label = stamp().replace('T', '-').replace(/:/g, '').replace(/\.\d+Z$/, 'Z');
    const candidate = join(base, `${PRODUCT_NAME}-${version}-${label}-${nonce()}.app`);
    if (!existsSync(candidate)) return candidate;
  }
  throw new PackagingError(`Could not allocate a unique bundle name under ${base}.`);
}

/** plutil rewrites for the local identity; argv arrays, never shell text. */
export function plistPatchArguments({ plist, version, productName = PRODUCT_NAME, bundleIdentifier = BUNDLE_IDENTIFIER }) {
  return [
    ['-replace', 'CFBundleExecutable', '-string', productName, plist],
    ['-replace', 'CFBundleName', '-string', productName, plist],
    ['-replace', 'CFBundleDisplayName', '-string', productName, plist],
    ['-replace', 'CFBundleIdentifier', '-string', bundleIdentifier, plist],
    ['-replace', 'CFBundleShortVersionString', '-string', version, plist],
    ['-replace', 'CFBundleVersion', '-string', version, plist],
    ['-replace', 'CFBundleIconFile', '-string', 'cleo.icns', plist],
    ['-replace', 'NSMicrophoneUsageDescription', '-string', 'Cleo uses the microphone when you start dictation or a live conversation. Audio is sent to your selected provider.', plist],
    ['-replace', 'NSCameraUsageDescription', '-string', 'Cleo uses the camera only when you enable gaze, to estimate eye direction locally without saving camera frames.', plist],
  ];
}

export function plistReadArguments(plist) {
  return ['CFBundleExecutable', 'CFBundleName', 'CFBundleDisplayName', 'CFBundleIdentifier', 'CFBundleShortVersionString']
    .map((key) => ({ key, args: ['-extract', key, 'raw', '-o', '-', plist] }));
}

export function adhocSignArguments(appPath) {
  return ['--force', '--sign', '-', '--timestamp=none', appPath];
}

export function verifySignArguments(appPath) {
  return ['--verify', '--deep', '--strict', '--verbose=2', appPath];
}

export function resignHelperArguments({ helperPath, entitlements = null, signing = null }) {
  const args = ['--force', '--deep', '--options', 'runtime', '--timestamp=none'];
  if (entitlements) args.push('--entitlements', entitlements);
  args.push('--sign', signing?.identity??'-');
  if(signing)args.push('--keychain',signing.keychain);
  args.push(helperPath);
  return args;
}

/**
 * Helper apps and frameworks nested in the copied Electron bundle, deepest first. The official
 * distribution ships them linker-signed; `codesign --verify --deep --strict` rejects those
 * ("code has no resources but signature indicates they must be present"), so each nested bundle
 * is re-signed as a bundle before the outer app. `Versions/Current` symlinks are not followed,
 * so a framework is signed once through its real path. `skip` lists bundles handled elsewhere
 * instead (the nested voice helper, which is re-signed with its own entitlement).
 */
export function findNestedBundles({ frameworksDirectory, skip = [], readdir = readdirSync }) {
  const skipped = new Set(skip.map((skippedPath) => resolve(skippedPath)));
  const nested = [];
  const walk = (directory, depth) => {
    let entries;
    try {
      entries = readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(directory, entry.name);
      if ((entry.name.endsWith('.app') || entry.name.endsWith('.framework')) && !skipped.has(resolve(path))) {
        nested.push({ path, depth });
      }
      walk(path, depth + 1);
    }
  };
  walk(frameworksDirectory, 0);
  return nested
    .sort((left, right) => right.depth - left.depth || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
    .map((entry) => entry.path);
}

export async function patchInfoPlist({ plist, version, execute = defaultExecute, productName = PRODUCT_NAME, bundleIdentifier = BUNDLE_IDENTIFIER }) {
  for (const args of plistPatchArguments({ plist, version, productName, bundleIdentifier })) {
    await run(execute, PLUTIL, args, 'plutil (rewriting the bundle identity)');
  }
  await run(execute, PLUTIL, ['-lint', plist], 'plutil (checking the rewritten Info.plist)');
  for (const { key, args } of plistReadArguments(plist)) {
    const result = await execute(PLUTIL, args, { stdio: 'pipe' });
    if (result.error || result.status !== 0) {
      throw new PackagingError(`plutil could not read ${key} from the packaged Info.plist (${plist}).`);
    }
    const expected = key === 'CFBundleShortVersionString' ? version : key === 'CFBundleIdentifier' ? bundleIdentifier : productName;
    const actual = result.stdout.trim();
    if (actual !== expected) {
      throw new PackagingError(`The packaged Info.plist has ${key}=${JSON.stringify(actual)} but should read ${JSON.stringify(expected)}.`);
    }
  }
}

async function readPackageVersion(rootDir) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(join(rootDir, 'package.json'), 'utf8'));
  } catch (cause) {
    throw new PackagingError(`Cannot read ${join(rootDir, 'package.json')}: ${cause.message}`);
  }
  const version = typeof parsed.version === 'string' ? parsed.version.trim() : '';
  if (!version) throw new PackagingError(`${join(rootDir, 'package.json')} has no version; set one before packaging.`);
  return version;
}

async function readElectronVersion(electronApp) {
  try {
    return (await readFile(join(dirname(electronApp), 'version'), 'utf8')).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Copies one whitelisted payload entry. Directory traversal applies the bundle deny-list and
 * refuses to follow symlinks that leave the repository; nothing is inherited from a parent
 * directory that the plan did not name.
 */
async function copyPayloadEntry({ source, destination, kind, rootDir, skipped }) {
  await mkdir(dirname(destination), { recursive: true });
  if (kind === 'file') {
    await cp(source, destination, { force: true });
    return;
  }
  await cp(source, destination, {
    recursive: true,
    force: true,
    filter: async (candidate) => {
      if (isDeniedName(basename(candidate))) return false;
      const stats = await lstat(candidate);
      if (!stats.isSymbolicLink()) return true;
      const target = await readlink(candidate);
      const absolute = isAbsolute(target) ? target : resolve(dirname(candidate), target);
      const inside = relative(rootDir, absolute);
      if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
        skipped.push(relative(rootDir, candidate));
        return false;
      }
      return true;
    },
  });
}

/**
 * Moves the finished bundle into place. rename() is atomic while staging and output share a
 * volume; an --out path on another volume (EXDEV) falls back to a copy that preserves symlinks.
 */
async function moveBundle(from, to) {
  try {
    await rename(from, to);
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error;
    await cp(from, to, { recursive: true, force: true, verbatimSymlinks: true });
    await rm(from, { recursive: true, force: true });
  }
}

/**
 * Assembles the local bundle. Returns a summary; throws PackagingError for every missing
 * precondition instead of downgrading the bundle silently. `execute` and `platform` are
 * injectable so the flow is testable without a real Electron download or codesign.
 */
export async function packageLocalApp(options = {}) {
  const {
    root = REPO_ROOT,
    out: requestedOut = null,
    uiOnly = false,
    replaceExisting = false,
    build = true,
    electronApp: electronAppOption = null,
    platform = process.platform,
    env = process.env,
    execute = defaultExecute,
    log = console.log,
    warn = console.warn,
    now = () => new Date(),
  } = options;

  if (platform !== 'darwin') {
    throw new PackagingError(`Local .app packaging requires macOS (darwin); this host reports ${platform}.`);
  }

  const rootDir = resolve(root);
  const signing=options.signing??(execute===defaultExecute?await localSigning():null);
  const version = await readPackageVersion(rootDir);
  const safeVersion = version.replace(/[^0-9A-Za-z.+-]/g, '_');
  const electronApp = electronAppOption === null ? resolveElectronApp({ root: rootDir, env }) : resolve(electronAppOption);
  if (!existsSync(join(electronApp, 'Contents', 'Info.plist')) || !existsSync(join(electronApp, 'Contents', 'MacOS', ELECTRON_BINARY))) {
    throw new PackagingError(
      `The Electron source bundle is incomplete: ${electronApp} has no Contents/MacOS/${ELECTRON_BINARY}.\n` +
      `Run 'pnpm install --frozen-lockfile'; packaging never downloads Electron.`,
    );
  }

  const artifactsBase = join(rootDir, ARTIFACTS_DIRECTORY);
  const output = requestedOut === null
    ? allocateOutputPath({ base: artifactsBase, version: safeVersion, stamp: () => now().toISOString() })
    : resolve(requestedOut);

  // Every precondition is checked *before* an existing bundle can be removed or staging can be
  // created: a failed run must never delete a previously usable bundle or leave half-created ones.
  const plan = buildPayloadPlan({ root: rootDir, uiOnly });
  let missing = missingRequiredPayload({ root: rootDir, uiOnly });
  if (build && missing.every((relativePath) => /^dist\/(main|preload|renderer)(\/|$)/.test(relativePath))) {
    log('Cleo packaging: refreshing the TypeScript bundle once (node scripts/build.mjs).');
    await run(execute, process.execPath, [join(rootDir, 'scripts', 'build.mjs')], 'the TypeScript build');
    missing = missingRequiredPayload({ root: rootDir, uiOnly });
  }
  if (missing.length > 0) throw new PackagingError(missingPayloadMessage(missing, uiOnly));

  if (existsSync(output)) {
    if (!replaceExisting) {
      throw new PackagingError(
        `Refusing to overwrite the existing bundle ${output}.\n` +
        `Choose a new --out path, or pass --replace-existing (which may only replace ${PRODUCT_NAME}-*.app bundles inside ${artifactsBase}).`,
      );
    }
    if (!isNarrowReplacement({ root: rootDir, output })) {
      throw new PackagingError(
        `--replace-existing may only replace ${PRODUCT_NAME}-*.app bundles inside ${artifactsBase}; refusing to remove ${output}.`,
      );
    }
    await rm(output, { recursive: true, force: true });
  }

  await mkdir(artifactsBase, { recursive: true });
  const staging = await mkdtemp(join(artifactsBase, '.staging-'));
  const appPath = join(staging, BUNDLE_DIRECTORY);
  const resourcesApp = join(appPath, 'Contents', 'Resources', 'app');
  const copied = [];
  const skipped = [];
  let voiceHelperTouched = false;
  try {
    // The official Electron distribution is copied whole (its own signatures stay intact); only
    // the main executable name and the Info.plist identity are rewritten for Cleo.
    await cp(electronApp, appPath, { recursive: true, force: true, verbatimSymlinks: true, filter: (source) => !isDeniedName(basename(source)) });
    await rename(join(appPath, 'Contents', 'MacOS', ELECTRON_BINARY), join(appPath, 'Contents', 'MacOS', PRODUCT_NAME));

    await mkdir(resourcesApp, { recursive: true });
    await writeFile(join(resourcesApp, 'package.json'), `${JSON.stringify({
      name: 'echopilot',
      productName: PRODUCT_NAME,
      version,
      private: true,
      main: 'dist/main/index.cjs',
    }, null, 2)}\n`);

    for (const entry of plan.entries) {
      const source = join(rootDir, entry.source);
      if (!existsSync(source)) continue;
      await copyPayloadEntry({ source, destination: join(resourcesApp, entry.destination), kind: entry.kind, rootDir, skipped });
      if (entry.mirror) {
        await copyPayloadEntry({ source, destination: join(resourcesApp, entry.mirror.destination), kind: entry.kind, rootDir, skipped });
        if (entry.mirror.resignBundle) voiceHelperTouched = true;
      }
      copied.push(entry.id);
    }

    // Skipped symlinks are part of the record, so they must be known before the record is written.
    const skippedOmissions = skipped.map((relativePath) => ({
      id: 'skipped-symlink',
      reason: `symlink leaves the repository: ${relativePath}`,
    }));
    const warnings = [
      ...plan.warnings,
      ...skipped.map((relativePath) => `Skipped a symlink that leaves the repository: ${relativePath}`),
    ];
    const record = {
      kind: 'echopilot-local-development-bundle',
      mode: uiOnly ? 'cloud-voice' : 'full',
      generatedAt: now().toISOString(),
      version,
      bundleIdentifier: BUNDLE_IDENTIFIER,
      electronVersion: await readElectronVersion(electronApp),
      signature: signing?'local-certificate':'ad-hoc',
      notarized: false,
      distributable: false,
      included: [...copied].sort(),
      omitted: [...plan.omitted, ...skippedOmissions],
      notes: 'Local development bundle assembled by scripts/package-local.mjs; it is not Developer ID signed and not notarized.',
    };
    await writeFile(join(resourcesApp, LOCAL_BUNDLE_RECORD), `${JSON.stringify(record, null, 2)}\n`);

    await cp(join(rootDir, 'assets', 'branding', 'cleo.icns'), join(appPath, 'Contents', 'Resources', 'cleo.icns'));
    await patchInfoPlist({ plist: join(appPath, 'Contents', 'Info.plist'), version, execute });

    // Electron's helpers and frameworks arrive linker-signed; re-sign each nested bundle so the
    // final `codesign --verify --deep --strict` pass succeeds instead of failing on pristine code.
    for (const nestedBundle of findNestedBundles({
      frameworksDirectory: join(appPath, 'Contents', 'Frameworks'),
      skip: [join(resourcesApp, 'dist', 'native', 'EchoPilotVoice.app')],
    })) {
      await run(execute, CODESIGN, signingArguments(nestedBundle,signing), `re-signing the nested ${basename(nestedBundle)}`);
    }

    if (voiceHelperTouched) {
      const entitlements = join(rootDir, 'native', 'macos', 'VoiceHelper', 'entitlements.plist');
      if (!existsSync(entitlements)) {
        warn('Cleo packaging: native/macos/VoiceHelper/entitlements.plist is missing; re-signing the nested voice helper without the audio-input entitlement.');
      }
      await run(
        execute,
        CODESIGN,
        resignHelperArguments({ helperPath: join(resourcesApp, 'dist', 'native', 'EchoPilotVoice.app'), entitlements: existsSync(entitlements) ? entitlements : null, signing }),
        're-signing the nested voice helper',
      );
    }

    await run(execute, CODESIGN, signingArguments(appPath,signing), 'signing the bundle');
    await run(execute, CODESIGN, verifySignArguments(appPath), 'verifying the bundle signature');

    await mkdir(dirname(output), { recursive: true });
    await moveBundle(appPath, output);
    await rm(staging, { recursive: true, force: true });
    return {
      appPath: output,
      mode: record.mode,
      signature: record.signature,
      notarized: false,
      distributable: false,
      version,
      electronApp,
      electronVersion: record.electronVersion,
      included: record.included,
      omitted: record.omitted,
      warnings,
      openCommand: `open "${output}"`,
    };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return;
  }
  const summary = await packageLocalApp({
    out: options.out,
    uiOnly: options.uiOnly,
    replaceExisting: options.replaceExisting,
    build: options.build,
    electronApp: options.electronApp,
  });
  if (options.json) {
    console.log(JSON.stringify(summary));
    return;
  }
  console.log(`\nCleo local bundle (${summary.mode}) assembled from Electron ${summary.electronVersion ?? 'unknown'}:`);
  console.log(`  ${summary.appPath}`);
  console.log(`\nOpen it with:  ${summary.openCommand}`);
  console.log(`Signature: ${summary.signature} local development signature — no Developer ID, not notarized.`);
  if (summary.mode === 'cloud-voice') {
    console.log('Mode: cloud-voice — native cloud audio is included; offline ASR/VAD model packs are omitted.');
  }
  if (summary.omitted.length > 0) {
    console.log('\nNot bundled:');
    for (const item of summary.omitted) console.log(`  - ${item.id}: ${item.reason}`);
  }
  if (summary.warnings.length > 0) {
    console.log('\nWarnings:');
    for (const warning of summary.warnings) console.log(`  - ${warning}`);
  }
  console.log('\nThis bundle is for local development on this Mac; it is not a distributable release (see docs/LOCAL_APP.md).');
}

const invokedAsScript = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`\nCleo packaging failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
