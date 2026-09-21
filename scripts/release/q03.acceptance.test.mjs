#!/usr/bin/env node
/**
 * Q03 acceptance oracle — Fresh Mac install → offline A+B session → signed update → rollback.
 *
 * One deterministic leg per ticket acceptance criterion:
 *
 *   (1) "Offline installer completes dictation, local conversation, memory restart and narration
 *       without API keys or runtime downloads" — Q03-1 pins the keyless, hash-pinned, license-
 *       carrying offline asset set the installer embeds (ASR for dictation, reasoner for local
 *       conversation, TTS model/voices for narration, bundled runtime for execution); Q03-2 pins
 *       the installer/update policy so exactly one installer may claim complete offline
 *       availability; Q03-6 pins the packaged app that embeds those assets instead of downloading
 *       them.
 *
 *   (2) "Tampered model/app updates are rejected; interrupted install leaves the old working
 *       version recoverable" — Q03-3 proves pack verification rejects a flipped payload byte, a
 *       missing file, an undeclared file and a substituted manifest; Q03-4 proves a tampered
 *       update never reaches the commit stage and the previous version stays active and
 *       verifiable; Q03-5 proves a crash at every stage leaves a verifiable active version and
 *       that `rollback` restores the previous one in a fresh process.
 *
 *   (3) "All A+B quality gates pass; support docs explain permissions, local/premium differences,
 *       data location, recovery and measured limits" — Q03-7 pins the five runbooks; Q03-8 pins
 *       the plan §4.5 gate set at its published thresholds, requires every gate to declare an
 *       in-repository evidence path, and executes every gate command and requires exit 0.
 *
 * Deterministic by construction: no network, no signing identity, no GUI, no model weights and no
 * user data. Packs are synthesized in a temporary directory with digests computed at run time, and
 * the release tooling is driven through its CLI against those packs.
 *
 * ---------------------------------------------------------------------------------------------
 * FROZEN SEAM — this file pins the names and observable behavior the release tooling must provide.
 * The implementer reads this block as the specification:
 *
 * `models/manifest.json` — the offline asset and license record. `assets[]` entries carry `id`,
 *   `kind`, `revision`, `license`, `licenseFile`, repository-relative POSIX `path` (no `..`, no
 *   absolute path, no backslash), positive integer `bytes` and lowercase 64-hex `sha256`. The
 *   offline A+B journey needs at least one asset of each kind: `asr` (Whisper `small.en`),
 *   `reasoner` (Qwen3.5-4B), `model` (Pocket TTS) and `voice` (a cleared preset), plus a
 *   `runtime` (the bundled worker interpreter/helper). `offlineInstall` is
 *   `{ "requiresApiKey": false, "runtimeDownloads": [] }`: the full installer needs no
 *   account/key and downloads nothing after installation. For a file asset `sha256` is the digest
 *   of its bytes; for a directory asset it is the digest of the sorted lines
 *   `"<sha256(file bytes)>  <path relative to the asset directory>\n"` (POSIX separators), so it
 *   covers every file the asset ships.
 *
 * `scripts/release/verify-pack.mjs` — release-time pack verification:
 *   `node scripts/release/verify-pack.mjs --manifest <manifest.json> --pack <pack-directory>`
 *   exits 0 only when every declared asset resolves inside the pack to bytes of the declared
 *   length and digest (directory assets under the rule above, so an added, removed or edited file
 *   inside the pack is a mismatch). Every violation prints one `problem: <detail>` line naming the
 *   offending asset id where one applies, and the exit status is nonzero. `path` and `licenseFile`
 *   resolve relative to the pack root, so a pack that lost an asset's license notice is a
 *   mismatch too.
 *
 * `scripts/release/install.mjs` — staged install/update/verify/rollback with crash simulation:
 *   `node scripts/release/install.mjs install --root <dir> --pack <dir> --manifest <path> --version <v>`
 *   `node scripts/release/install.mjs update  --root <dir> --pack <dir> --manifest <path> --version <v>`
 *     `update` stages a new immutable version and commits atomically: `<root>/current` is only
 *     replaced after the staged version is complete and verified, and the previously active
 *     version stays available for `rollback`. A successful install/update prints these stage lines
 *     in this order and exits 0:
 *       stage: verify / stage: stage / stage: journal / stage: commit / stage: cleanup
 *     A pack that fails verification prints `problem: <detail>`, exits nonzero, and never reaches
 *     `stage: commit`; the active version is unchanged.
 *   `--simulate-crash-after <stage>` runs the same code path, finishes the named stage, and then
 *     stops (nonzero) right after printing its line, leaving exactly the partial state a crash
 *     at that point would leave. It is the deterministic stand-in for SIGKILL/power loss.
 *   `node scripts/release/install.mjs verify --root <dir>` re-hashes the stored active version
 *   against the manifest recorded at install time, prints `active: <version>` and `verify: ok`,
 *   and exits 0 from a fresh process (a crash or app restart must not lose the recovery record).
 *   `node scripts/release/install.mjs rollback --root <dir>` restores the version that was active
 *   before the most recent successful install/update, prints `active: <version>`, and exits 0.
 *
 * `scripts/release/installers.json` — installer/update policy. `installers[]` entries carry `id`,
 *   `kind` (`"full"` | `"online"`), `offlineAvailability` (`"complete"` | `"after-asset-download"`),
 *   `embeddedModelAssets`, `requiresApiKey`, `runtimeDownloads` (array), `signed`, `notarized`.
 *   Exactly one installer may be `"complete"`: the full installer, which embeds the model assets.
 *   The smaller online installer is `"after-asset-download"` and must not embed them. `updates` is
 *   `{ "staged": true, "verifyPackBeforeCommit": true, "requiresSignature": true,
 *   "keepPreviousVersions": >= 1, "rollback": true, "compatibilityBackups": true }`.
 *
 * `scripts/release/quality-gates.json` — the A+B gate set. `gates[]` entries carry `id`,
 *   `pillar` (`"A"` | `"B"` | `"A+B"`), `comparator` (`"gte"` | `"lte"` | `"eq"`), numeric
 *   `threshold` equal to the plan §4.5 target, an existing repository-relative `evidence` path and
 *   a `command` argv headed by `node`, `pnpm` or `swift` that must exit 0 and must not re-run this
 *   oracle. Required gates: dictation-technical-term-error-reduction (A, gte 0.25),
 *   dictation-harmful-semantic-edits (A, lte 0.01), narration-critical-event-recall (B, gte 0.95),
 *   narration-supported-factual-claims (B, gte 0.98), routing-auto-dispatch-precision (B, gte 0.99),
 *   backchannel-precision (A+B, gte 0.95), temporal-memory-answer-accuracy (B, gte 0.90),
 *   adversarial-zero-violations (A+B, eq 0).
 *
 * `apps/desktop/forge.config.ts` — the packaged desktop app: `packagerConfig` with `asar`,
 *   `osxSign`, `osxNotarize` and an `extraResource` list that embeds the model pack (`models`) and
 *   the bundled TTS worker runtime (`workers/pocket-tts`) without referencing a download URL, plus
 *   makers for `@electron-forge/maker-dmg` and `@electron-forge/maker-zip`.
 *
 * `docs/runbooks/` — support documentation: `permissions.md` (microphone, screen recording,
 *   accessibility, revocation), `local-vs-premium.md` (local vs premium/BYOK, no provider
 *   substitution), `data-location.md` (where memory lives on disk and how to delete it),
 *   `recovery.md` (interrupted install, backups, `scripts/release/install.mjs` rollback) and
 *   `measured-limits.md` (limits keyed to `scripts/release/quality-gates.json`).
 * ---------------------------------------------------------------------------------------------
 *
 * Remaining limitation (reported, not claimed): real Developer ID signing and notarization, a
 * clean-Mac journey with the real vendored multi-gigabyte weights, and hard power-loss/reboot
 * drills are human hardware qualification. This oracle pins the signed/notarized release artifacts
 * and drives the release tooling against fixture packs that take the same verification, staging
 * and rollback code paths as the real payload.
 *
 * Usage: node --test scripts/release/q03.acceptance.test.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MANIFEST_PATH = join(REPO_ROOT, 'models', 'manifest.json');
const RUNTIME_PATH = join(REPO_ROOT, 'workers', 'pocket-tts', 'runtime.json');
const INSTALLERS_PATH = join(REPO_ROOT, 'scripts', 'release', 'installers.json');
const GATES_PATH = join(REPO_ROOT, 'scripts', 'release', 'quality-gates.json');
const VERIFY_PACK = 'scripts/release/verify-pack.mjs';
const INSTALL_CLI = 'scripts/release/install.mjs';
const FORGE_CONFIG = join(REPO_ROOT, 'apps', 'desktop', 'forge.config.ts');
const RUNBOOK_DIRECTORY = join(REPO_ROOT, 'docs', 'runbooks');
const COMMAND_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** `stage: commit` is the commit boundary an interrupted or tampered run must never cross. */
const INSTALL_STAGES = Object.freeze([
  'stage: verify',
  'stage: stage',
  'stage: journal',
  'stage: commit',
  'stage: cleanup',
]);
const CRASH_STAGES = Object.freeze(['verify', 'stage', 'journal', 'commit']);

/** Offline asset kinds, and the artifact each must identify (acceptance criterion 1). */
const REQUIRED_OFFLINE_KINDS = Object.freeze({
  asr: /whisper|small\.en/i,          // dictation
  reasoner: /qwen/i,                  // local conversation
  model: /pocket-tts|tts/i,           // narration
  voice: /alba|anna|charles|jean/i,   // narration
  runtime: /python|runtime|helper/i,  // executes the local assets
});

/** Plan §4.5 release gates, at their published targets. */
const REQUIRED_GATES = Object.freeze([
  { id: 'dictation-technical-term-error-reduction', pillar: 'A', comparator: 'gte', threshold: 0.25 },
  { id: 'dictation-harmful-semantic-edits', pillar: 'A', comparator: 'lte', threshold: 0.01 },
  { id: 'narration-critical-event-recall', pillar: 'B', comparator: 'gte', threshold: 0.95 },
  { id: 'narration-supported-factual-claims', pillar: 'B', comparator: 'gte', threshold: 0.98 },
  { id: 'routing-auto-dispatch-precision', pillar: 'B', comparator: 'gte', threshold: 0.99 },
  { id: 'backchannel-precision', pillar: 'A+B', comparator: 'gte', threshold: 0.95 },
  { id: 'temporal-memory-answer-accuracy', pillar: 'B', comparator: 'gte', threshold: 0.9 },
  { id: 'adversarial-zero-violations', pillar: 'A+B', comparator: 'eq', threshold: 0 },
]);

/** Support topics the runbooks must cover; each group needs at least one alternative. */
const REQUIRED_RUNBOOKS = Object.freeze([
  {
    file: 'permissions.md',
    topic: 'permissions and revocation',
    keywords: [['microphone', 'mic'], ['screen recording'], ['accessibility'], ['revoke', 'revoking', 'revocation']],
  },
  {
    file: 'local-vs-premium.md',
    topic: 'local vs premium differences',
    keywords: [['local'], ['premium', 'byok'], ['api key'], ['substitution', 'substitute']],
  },
  {
    file: 'data-location.md',
    topic: 'data location and deletion',
    keywords: [['application support'], ['memory'], ['delete', 'deletion', 'remove']],
  },
  {
    file: 'recovery.md',
    topic: 'recovery and rollback',
    keywords: [['rollback'], ['interrupt'], ['backup'], ['scripts/release/install.mjs']],
  },
  {
    file: 'measured-limits.md',
    topic: 'measured limits',
    keywords: [['measured'], ['scripts/release/quality-gates.json']],
  },
]);

function missing(behavior) {
  assert.fail(`Missing required behavior: ${behavior}`);
}

async function fileExists(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function requireFile(path, behavior) {
  if (!(await fileExists(path))) missing(behavior);
}

async function readTextFile(path, describe) {
  await requireFile(path, `${describe} (${relative(REPO_ROOT, path)}) is missing from the repository.`);
  return readFile(path, 'utf8');
}

async function readJsonFile(path, describe) {
  const text = await readTextFile(path, describe);
  try {
    return JSON.parse(text);
  } catch (error) {
    missing(`${describe} (${relative(REPO_ROOT, path)}) is not valid JSON: ${error.message}`);
  }
}

function outputOf(result) {
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

function tailOutput(result) {
  const text = outputOf(result).trim();
  if (result.error?.message) return `${result.error.message}\n${text}`.trim();
  return text.length > 2_000 ? `...${text.slice(-2_000)}` : text;
}

/** Runs a repository script under the current Node with a bounded, network-neutral environment. */
function runNode(script, args, { env = {} } = {}) {
  const result = spawnSync(process.execPath, [join(REPO_ROOT, script), ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
    env: { ...process.env, CI: 'true', ...env },
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error };
}

function runArgv(command) {
  const result = spawnSync(command[0], command.slice(1), {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
    env: { ...process.env, CI: 'true' },
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error };
}

function isSafeArgv(command) {
  return Array.isArray(command)
    && command.length > 0
    && command.every((part) => typeof part === 'string' && part.length > 0)
    && ['pnpm', 'node', 'swift'].includes(command[0]);
}

function activeVersion(text) {
  const match = text.match(/active:\s*(\S+)/);
  return match?.[1] ?? null;
}

function hasStage(text, stage) {
  return text.includes(`stage: ${stage}`);
}

/** Asserts the successful-run stage lines appear exactly once each and in order. */
function assertStagesInOrder(text, context) {
  let cursor = -1;
  for (const stage of INSTALL_STAGES) {
    const index = text.indexOf(stage);
    assert.ok(index >= 0, `${context} must print '${stage}'\n${text}`);
    assert.ok(index > cursor, `${context} must print '${stage}' after the previous stage\n${text}`);
    assert.equal(text.indexOf(stage, index + 1), -1, `${context} must print '${stage}' once\n${text}`);
    cursor = index;
  }
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function listFilesRecursive(directory) {
  const found = [];
  const stack = [{ absolute: directory, relative: '.' }];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = await readdir(current.absolute, { withFileTypes: true });
    for (const entry of entries) {
      const next = {
        absolute: join(current.absolute, entry.name),
        relative: current.relative === '.' ? entry.name : `${current.relative}/${entry.name}`,
      };
      if (entry.isDirectory()) stack.push(next);
      else if (entry.isFile()) found.push(next.relative);
    }
  }
  return found.sort();
}

/** The frozen directory-asset digest: sorted `"<sha256(file)>  <relative path>\n"` lines. */
async function sha256Directory(directory) {
  const digest = createHash('sha256');
  for (const relativePath of await listFilesRecursive(directory)) {
    digest.update(`${sha256Bytes(await readFile(join(directory, relativePath)))}  ${relativePath}\n`);
  }
  return digest.digest('hex');
}

const FIXTURE_FILES = Object.freeze([
  ['models/tts/weights.bin', 'q03-fixture-tts-weights-v1'],
  ['models/voices/alba/tokens.bin', 'q03-fixture-voice-alba-tokens-v1'],
  ['models/voices/alba/config.json', '{"voice":"alba","sampleRate":24000}'],
  ['licenses/q03-fixture-tts-weights.txt', 'CC-BY-4.0 fixture license (q03 acceptance oracle)'],
  ['licenses/q03-fixture-voice-alba.txt', 'CC-BY-4.0 fixture license (q03 acceptance oracle)'],
]);

/**
 * Synthesizes a minimal but schema-faithful pack: one file asset, one directory asset and the
 * license files the manifest records. Digests are computed here, so a fixture template cannot
 * drift away from the pack it describes.
 */
async function writeFixturePack(workspace, name = 'pack') {
  const pack = join(workspace, name);
  for (const [relativePath, text] of FIXTURE_FILES) {
    const absolute = join(pack, relativePath);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, Buffer.from(`${text}\n`));
  }
  const weights = await readFile(join(pack, 'models/tts/weights.bin'));
  const voiceRoot = join(pack, 'models/voices/alba');
  const voiceBytes = (await Promise.all((await listFilesRecursive(voiceRoot)).map((file) => readFile(join(voiceRoot, file)))))
    .reduce((total, bytes) => total + bytes.length, 0);
  const manifest = {
    manifestVersion: 1,
    generatedBy: 'q03 acceptance oracle fixture pack',
    outputFormat: { sampleRate: 24000, channels: 1, packetMs: 20 },
    offlineInstall: { requiresApiKey: false, runtimeDownloads: [] },
    assets: [
      {
        id: 'fixture-tts-weights',
        kind: 'model',
        revision: 'fixture-2026-09',
        license: 'CC-BY-4.0',
        licenseFile: 'licenses/q03-fixture-tts-weights.txt',
        path: 'models/tts/weights.bin',
        bytes: weights.length,
        sha256: sha256Bytes(weights),
      },
      {
        id: 'fixture-voice-alba',
        kind: 'voice',
        voiceId: 'alba',
        revision: 'fixture-2026-09',
        license: 'CC-BY-4.0',
        licenseFile: 'licenses/q03-fixture-voice-alba.txt',
        path: 'models/voices/alba',
        bytes: voiceBytes,
        sha256: await sha256Directory(voiceRoot),
      },
    ],
  };
  const manifestPath = join(workspace, `${name}-manifest.json`);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { pack, manifestPath, manifest };
}

async function flipOneByte(path) {
  const bytes = await readFile(path);
  bytes[0] ^= 0xff;
  await writeFile(path, bytes);
}

async function withWorkspace(prefix, body) {
  const workspace = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await body(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

test('Q03-1 the offline installer ships a keyless, hash-pinned A+B asset set', async () => {
  const manifest = await readJsonFile(MANIFEST_PATH, 'the models/manifest.json offline asset and license record');
  assert.ok(Array.isArray(manifest.assets) && manifest.assets.length > 0, 'models/manifest.json must list assets');

  const offline = manifest.offlineInstall;
  assert.ok(
    offline && typeof offline === 'object',
    'Missing required behavior: models/manifest.json must declare an offlineInstall block '
    + '({ requiresApiKey: false, runtimeDownloads: [] }) so the full installer cannot silently '
    + 'require an account or fetch assets after installation.',
  );
  assert.equal(offline.requiresApiKey, false, 'the offline install must not require an API key');
  assert.deepEqual(offline.runtimeDownloads, [], 'the offline install must perform no run-time downloads');

  const byKind = new Map();
  for (const asset of manifest.assets) {
    const label = `models/manifest.json asset ${asset?.id ?? '<unidentified>'}`;
    assert.ok(typeof asset?.id === 'string' && asset.id.length > 0, `${label} needs an id`);
    assert.match(String(asset.path ?? ''), /^(?!\/)(?!.*\.\.)(?!.*\\)[^\\]+$/, `${label} needs a repository-relative POSIX path`);
    assert.match(String(asset.sha256 ?? ''), /^[0-9a-f]{64}$/, `${label} needs a lowercase sha256 pin`);
    assert.ok(Number.isInteger(asset.bytes) && asset.bytes > 0, `${label} needs a positive byte length`);
    assert.ok(typeof asset.revision === 'string' && asset.revision.length > 0, `${label} needs a pinned revision`);
    assert.ok(typeof asset.license === 'string' && asset.license.length > 0, `${label} needs its license`);
    assert.ok(typeof asset.licenseFile === 'string' && asset.licenseFile.length > 0, `${label} needs its license file record`);
    byKind.set(asset.kind, [...(byKind.get(asset.kind) ?? []), asset]);
  }

  for (const [kind, identity] of Object.entries(REQUIRED_OFFLINE_KINDS)) {
    const assets = byKind.get(kind) ?? [];
    assert.ok(
      assets.length > 0,
      `Missing required behavior: models/manifest.json declares no '${kind}' asset, so the offline `
      + 'journey (dictation, local conversation, narration) cannot be assembled without a download.',
    );
    assert.ok(
      assets.some((asset) => identity.test(`${asset.id} ${asset.path}`)),
      `models/manifest.json declares a '${kind}' asset, but none identifies ${identity} as the shipped artifact`,
    );
  }

  const runtime = await readJsonFile(RUNTIME_PATH, 'the workers/pocket-tts/runtime.json worker runtime record');
  assert.equal(runtime.offline, true, 'the bundled TTS worker runtime must be offline-capable');
  assert.equal(runtime.downloads, 'none', 'the bundled TTS worker runtime must perform no downloads');
  assert.equal(runtime.network, 'denied', 'the bundled TTS worker runtime must not be able to reach the network');
});

test('Q03-2 one embedded offline installer, an honest online build, and a staged/recoverable update policy', async () => {
  const declaration = await readJsonFile(INSTALLERS_PATH, 'the scripts/release/installers.json installer policy');
  assert.ok(Array.isArray(declaration.installers) && declaration.installers.length > 0, 'installers.json must list installers');

  const complete = declaration.installers.filter((installer) => installer.offlineAvailability === 'complete');
  assert.equal(
    complete.length,
    1,
    'Missing required behavior: exactly one installer may claim complete offline availability — '
    + 'the signed/notarized full installer that embeds the model assets.',
  );
  assert.ok(
    declaration.installers.some((installer) => installer.offlineAvailability === 'after-asset-download'),
    "Missing required behavior: the smaller online installer must declare offlineAvailability "
    + "'after-asset-download' so it never claims offline use before its signed asset download completes.",
  );

  const full = complete[0];
  assert.equal(full.kind, 'full', 'the complete offline installer must be the full installer');
  assert.equal(full.embeddedModelAssets, true, 'the full installer must embed the model assets');
  assert.equal(full.requiresApiKey, false, 'the full installer must not require an API key');
  assert.deepEqual(full.runtimeDownloads, [], 'the full installer must declare no run-time downloads');
  assert.equal(full.signed, true, 'the full installer must be Developer ID signed');
  assert.equal(full.notarized, true, 'the full installer must be notarized');

  for (const installer of declaration.installers) {
    if (installer.offlineAvailability === 'after-asset-download') {
      assert.equal(installer.embeddedModelAssets, false, `the online installer ${installer.id} must not claim embedded assets`);
    }
  }

  const updates = declaration.updates;
  assert.ok(updates && typeof updates === 'object', 'installers.json must declare an updates policy block');
  assert.equal(updates.staged, true, 'updates must be staged');
  assert.equal(updates.verifyPackBeforeCommit, true, 'a tampered update must be rejected before it commits');
  assert.equal(updates.requiresSignature, true, 'updates must require a Developer ID signature');
  assert.ok(
    Number.isInteger(updates.keepPreviousVersions) && updates.keepPreviousVersions >= 1,
    'updates must keep at least one previous version for recovery',
  );
  assert.equal(updates.rollback, true, 'updates must be rollback-able');
  assert.equal(updates.compatibilityBackups, true, 'updates must keep compatibility backups');
});

test('Q03-3 pack verification rejects tampered bytes, layout changes and a substituted manifest', async () => {
  await requireFile(
    join(REPO_ROOT, VERIFY_PACK),
    `${VERIFY_PACK} must exist: the release gate has to verify every pinned asset of a model/app `
    + 'pack before it is installed.',
  );
  await withWorkspace('q03-verify-pack-', async (workspace) => {
    const { pack, manifestPath } = await writeFixturePack(workspace);

    const clean = runNode(VERIFY_PACK, ['--manifest', manifestPath, '--pack', pack]);
    assert.equal(clean.status, 0, `a pack whose bytes match the manifest must verify\n${tailOutput(clean)}`);

    const flipped = join(workspace, 'flipped');
    await cp(pack, flipped, { recursive: true });
    await flipOneByte(join(flipped, 'models/tts/weights.bin'));
    const tamperedBytes = runNode(VERIFY_PACK, ['--manifest', manifestPath, '--pack', flipped]);
    assert.notEqual(tamperedBytes.status, 0, 'a flipped payload byte must be rejected');
    assert.match(outputOf(tamperedBytes), /problem:/, 'a rejection must name its problem');
    assert.match(outputOf(tamperedBytes), /fixture-tts-weights/, 'the rejection must name the failing asset');

    const missingFile = join(workspace, 'missing');
    await cp(pack, missingFile, { recursive: true });
    await rm(join(missingFile, 'models/voices/alba/config.json'));
    const missingResult = runNode(VERIFY_PACK, ['--manifest', manifestPath, '--pack', missingFile]);
    assert.notEqual(missingResult.status, 0, 'a directory asset that lost a file must be rejected');
    assert.match(outputOf(missingResult), /problem:/, 'a rejection must name its problem');
    assert.match(outputOf(missingResult), /fixture-voice-alba/, 'the rejection must name the failing asset');

    const extraFile = join(workspace, 'extra');
    await cp(pack, extraFile, { recursive: true });
    await writeFile(join(extraFile, 'models/voices/alba/extra.bin'), Buffer.from('undeclared payload\n'));
    const extraResult = runNode(VERIFY_PACK, ['--manifest', manifestPath, '--pack', extraFile]);
    assert.notEqual(extraResult.status, 0, 'an undeclared file inside a declared directory asset must be rejected');
    assert.match(outputOf(extraResult), /problem:/, 'a rejection must name its problem');
    assert.match(outputOf(extraResult), /fixture-voice-alba/, 'the rejection must name the affected asset');

    const missingLicense = join(workspace, 'missing-license');
    await cp(pack, missingLicense, { recursive: true });
    await rm(join(missingLicense, 'licenses/q03-fixture-tts-weights.txt'));
    const licenseResult = runNode(VERIFY_PACK, ['--manifest', manifestPath, '--pack', missingLicense]);
    assert.notEqual(licenseResult.status, 0, 'a pack that lost an asset license notice must be rejected');
    assert.match(outputOf(licenseResult), /problem:/, 'a rejection must name its problem');
    assert.match(outputOf(licenseResult), /fixture-tts-weights/, 'the rejection must name the affected asset');

    const substituted = JSON.parse(await readFile(manifestPath, 'utf8'));
    substituted.assets[0].bytes += 1;
    substituted.assets[0].sha256 = 'f'.repeat(64);
    const substitutedPath = join(workspace, 'substituted-manifest.json');
    await writeFile(substitutedPath, `${JSON.stringify(substituted, null, 2)}\n`);
    const substitutedResult = runNode(VERIFY_PACK, ['--manifest', substitutedPath, '--pack', pack]);
    assert.notEqual(substitutedResult.status, 0, 'a manifest that does not describe the pack bytes must be rejected');
    assert.match(outputOf(substitutedResult), /problem:/, 'a rejection must name its problem');
  });
});

test('Q03-4 a tampered update is rejected before commit and the previous version stays active', async () => {
  await requireFile(
    join(REPO_ROOT, INSTALL_CLI),
    `${INSTALL_CLI} must exist: staged install, verification and rollback are the recovery path this ticket ships.`,
  );
  await withWorkspace('q03-install-tamper-', async (workspace) => {
    const root = join(workspace, 'store');
    const first = await writeFixturePack(workspace, 'pack-1');
    const install = runNode(
      INSTALL_CLI,
      ['install', '--root', root, '--pack', first.pack, '--manifest', first.manifestPath, '--version', '1.0.0'],
    );
    assert.equal(install.status, 0, `a verified pack must install\n${tailOutput(install)}`);
    assertStagesInOrder(outputOf(install), 'a successful install');

    const verified = runNode(INSTALL_CLI, ['verify', '--root', root]);
    assert.equal(verified.status, 0, `the installed version must verify\n${tailOutput(verified)}`);
    assert.match(outputOf(verified), /verify: ok/, 'verify must report success');
    assert.equal(activeVersion(outputOf(verified)), '1.0.0', 'the installed version must be active');

    const second = await writeFixturePack(workspace, 'pack-2');
    await flipOneByte(join(second.pack, 'models/tts/weights.bin'));
    const rejected = runNode(
      INSTALL_CLI,
      ['update', '--root', root, '--pack', second.pack, '--manifest', second.manifestPath, '--version', '2.0.0'],
    );
    assert.notEqual(rejected.status, 0, 'a tampered update must be rejected');
    assert.match(outputOf(rejected), /problem:/, 'the rejection must name its problem');
    assert.equal(hasStage(outputOf(rejected), 'commit'), false, 'a tampered update must never reach the commit stage');

    const stillActive = runNode(INSTALL_CLI, ['verify', '--root', root]);
    assert.equal(stillActive.status, 0, `the previous version must survive a rejected update\n${tailOutput(stillActive)}`);
    assert.equal(activeVersion(outputOf(stillActive)), '1.0.0', 'the previous version must stay active');
  });
});

test('Q03-5 an interrupted install leaves the previous version recoverable and rollback restores it', async () => {
  await requireFile(
    join(REPO_ROOT, INSTALL_CLI),
    `${INSTALL_CLI} must exist: interrupted-install recovery and rollback cannot be claimed without it.`,
  );
  await withWorkspace('q03-install-crash-', async (workspace) => {
    const root = join(workspace, 'store');
    const first = await writeFixturePack(workspace, 'pack-1');
    const install = runNode(
      INSTALL_CLI,
      ['install', '--root', root, '--pack', first.pack, '--manifest', first.manifestPath, '--version', '1.0.0'],
    );
    assert.equal(install.status, 0, `a verified pack must install\n${tailOutput(install)}`);

    const second = await writeFixturePack(workspace, 'pack-2');
    const updateArgs = (stage) => [
      'update', '--root', root, '--pack', second.pack, '--manifest', second.manifestPath,
      '--version', '2.0.0', '--simulate-crash-after', stage,
    ];

    for (const stage of CRASH_STAGES.filter((name) => name !== 'commit')) {
      const crashed = runNode(INSTALL_CLI, updateArgs(stage));
      assert.notEqual(crashed.status, 0, `a crash after '${stage}' must fail the update`);
      assert.ok(hasStage(outputOf(crashed), stage), `the run must reach 'stage: ${stage}' before stopping\n${tailOutput(crashed)}`);
      assert.equal(hasStage(outputOf(crashed), 'commit'), false, `a crash after '${stage}' must not commit`);

      const recovered = runNode(INSTALL_CLI, ['verify', '--root', root]);
      assert.equal(recovered.status, 0, `the previous version must verify after a crash at '${stage}'\n${tailOutput(recovered)}`);
      assert.equal(activeVersion(outputOf(recovered)), '1.0.0', `the previous version must stay active after a crash at '${stage}'`);
    }

    const committed = runNode(INSTALL_CLI, updateArgs('commit'));
    assert.notEqual(committed.status, 0, 'a crash after the commit stage must fail the run');
    assert.ok(hasStage(outputOf(committed), 'commit'), 'the run must reach the commit stage before stopping');
    const committedState = runNode(INSTALL_CLI, ['verify', '--root', root]);
    assert.equal(committedState.status, 0, `the committed version must verify after an interrupted cleanup\n${tailOutput(committedState)}`);
    assert.equal(activeVersion(outputOf(committedState)), '2.0.0', 'a completed commit must be the active version');
    const recoveredOld = runNode(INSTALL_CLI, ['rollback', '--root', root]);
    assert.equal(recoveredOld.status, 0, `rollback must undo an interrupted update\n${tailOutput(recoveredOld)}`);
    assert.equal(activeVersion(outputOf(recoveredOld)), '1.0.0', 'rollback must restore the previously active version');

    const retried = runNode(
      INSTALL_CLI,
      ['update', '--root', root, '--pack', second.pack, '--manifest', second.manifestPath, '--version', '2.0.0'],
    );
    assert.equal(retried.status, 0, `a retried update must complete after crashes\n${tailOutput(retried)}`);
    assertStagesInOrder(outputOf(retried), 'a retried update');
    const verified = runNode(INSTALL_CLI, ['verify', '--root', root]);
    assert.equal(verified.status, 0, `the updated version must verify\n${tailOutput(verified)}`);
    assert.equal(activeVersion(outputOf(verified)), '2.0.0');

    const rollback = runNode(INSTALL_CLI, ['rollback', '--root', root]);
    assert.equal(rollback.status, 0, `rollback must succeed\n${tailOutput(rollback)}`);
    assert.equal(activeVersion(outputOf(rollback)), '1.0.0', 'rollback must restore the previously active version');
    const rolledBack = runNode(INSTALL_CLI, ['verify', '--root', root]);
    assert.equal(rolledBack.status, 0, `the rolled-back version must verify in a fresh process\n${tailOutput(rolledBack)}`);
    assert.equal(activeVersion(outputOf(rolledBack)), '1.0.0');
  });
});

test('Q03-6 the packaged desktop app declares a signed, notarized bundle with embedded assets', async () => {
  const config = await readTextFile(FORGE_CONFIG, 'the apps/desktop/forge.config.ts packaging configuration');
  for (const token of [
    'packagerConfig',
    'asar',
    'extraResource',
    'osxSign',
    'osxNotarize',
    '@electron-forge/maker-dmg',
    '@electron-forge/maker-zip',
  ]) {
    assert.ok(config.includes(token), `Missing required behavior: apps/desktop/forge.config.ts must declare ${token}.`);
  }
  const embedded = config.match(/extraResource\s*:\s*\[([\s\S]*?)\]/);
  assert.ok(embedded, 'Missing required behavior: apps/desktop/forge.config.ts must declare an extraResource list.');
  assert.ok(embedded[1].includes('models'), 'the packaged app must embed the model assets');
  assert.ok(embedded[1].includes('workers/pocket-tts'), 'the packaged app must embed the bundled TTS worker runtime');
  assert.equal(
    /https?:\/\//.test(embedded[1]),
    false,
    'the offline bundle must embed the assets instead of referencing a download URL',
  );
});

test('Q03-7 support runbooks explain permissions, local/premium, data, recovery and measured limits', async () => {
  for (const runbook of REQUIRED_RUNBOOKS) {
    const path = join(RUNBOOK_DIRECTORY, runbook.file);
    const text = await readTextFile(path, `the ${runbook.topic} runbook (docs/runbooks/${runbook.file})`);
    assert.ok(text.length >= 400, `docs/runbooks/${runbook.file} must actually explain ${runbook.topic}`);
    const lower = text.toLowerCase();
    for (const alternatives of runbook.keywords) {
      assert.ok(
        alternatives.some((keyword) => lower.includes(keyword)),
        `docs/runbooks/${runbook.file} must cover ${alternatives.join(' / ')}`,
      );
    }
    if (runbook.file === 'measured-limits.md') {
      await readJsonFile(GATES_PATH, 'the scripts/release/quality-gates.json release gate set');
      for (const gate of REQUIRED_GATES) {
        assert.ok(lower.includes(gate.id), `docs/runbooks/measured-limits.md must state the measured limit for ${gate.id}`);
      }
    }
  }
});

test('Q03-8 the A+B release gates are declared at plan thresholds and all pass', async () => {
  const declaration = await readJsonFile(GATES_PATH, 'the scripts/release/quality-gates.json release gate set');
  assert.ok(Array.isArray(declaration.gates) && declaration.gates.length > 0, 'quality-gates.json must declare gates');

  const byId = new Map();
  for (const gate of declaration.gates) {
    assert.ok(typeof gate?.id === 'string' && gate.id.length > 0, 'every gate needs an id');
    assert.equal(byId.has(gate.id), false, `duplicate gate id ${gate.id}`);
    byId.set(gate.id, gate);
  }

  for (const required of REQUIRED_GATES) {
    const gate = byId.get(required.id);
    assert.ok(
      gate,
      `Missing required behavior: the A+B release gate set must declare '${required.id}' `
      + `(plan §4.5 target: ${required.comparator} ${required.threshold}).`,
    );
    assert.equal(gate.pillar, required.pillar, `${required.id} must be a ${required.pillar} gate`);
    assert.equal(gate.comparator, required.comparator, `${required.id} comparator must stay as published`);
    assert.equal(gate.threshold, required.threshold, `${required.id} threshold must equal the published plan target`);
    assert.ok(isSafeArgv(gate.command), `${required.id} needs a command argv headed by node, pnpm or swift`);
    assert.equal(
      gate.command.some((part) => part.includes('q03.acceptance.test')),
      false,
      `${required.id} must not re-run this oracle`,
    );
    assert.ok(typeof gate.evidence === 'string' && gate.evidence.length > 0, `${required.id} needs an evidence path`);
    assert.ok(
      await fileExists(join(REPO_ROOT, gate.evidence)),
      `${required.id} evidence ${gate.evidence} does not exist in the repository`,
    );
  }

  for (const required of REQUIRED_GATES) {
    const gate = byId.get(required.id);
    const result = runArgv(gate.command);
    assert.equal(
      result.status,
      0,
      `A+B release gate ${required.id} must pass (${gate.command.join(' ')})\n${tailOutput(result)}`,
    );
  }
});
