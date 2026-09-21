#!/usr/bin/env node
/**
 * Q03 staged install / update / verify / rollback with crash simulation.
 *
 *   node scripts/release/install.mjs install  --root <dir> --pack <dir> --manifest <path> --version <v>
 *   node scripts/release/install.mjs update   --root <dir> --pack <dir> --manifest <path> --version <v>
 *   node scripts/release/install.mjs verify   --root <dir>
 *   node scripts/release/install.mjs rollback --root <dir>
 *   ... install/update accept `--simulate-crash-after <verify|stage|journal|commit>` and an optional
 *   `--signature <file>` recording the Developer ID signature that travelled with the pack.
 *
 * The on-disk store is what makes an interrupted install recoverable:
 *
 *   <root>/current            the active version (the only pointer the app reads)
 *   <root>/versions/<v>/      an immutable copy of a verified pack + the manifest of record
 *   <root>/staging/           partial staging areas, never read as an installed version
 *   <root>/journal.json       the in-flight transaction record (present only mid-transaction)
 *   <root>/history.json       committed versions, oldest first, used by `rollback`
 *
 * A successful install/update prints `stage: verify`, `stage: stage`, `stage: journal`,
 * `stage: commit`, `stage: cleanup` in that order and exits 0. A pack that fails verification
 * prints `problem: <detail>` lines, exits nonzero, never reaches `stage: commit`, and leaves the
 * active version untouched. `--simulate-crash-after <stage>` runs the same code path, finishes the
 * named stage, prints its line and stops nonzero — the deterministic stand-in for SIGKILL/power
 * loss. `verify` re-hashes the stored active version against the manifest recorded at install time
 * from a fresh process, and `rollback` restores the version that was active before the most recent
 * successful install/update.
 */
import { randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { verifyPack } from './verify-pack.mjs';

const CRASH_STAGES = Object.freeze(['verify', 'stage', 'journal', 'commit']);
const KEEP_PREVIOUS_VERSIONS = 2;

function fail(message, code = 2) {
  console.error(`problem: ${message}`);
  process.exitCode = code;
  return null;
}

function parseArgs(argv) {
  const [first, ...rest] = argv;
  const options = { command: first === '--help' || first === '-h' ? null : first, help: first === '--help' || first === '-h', simulateCrashAfter: null, signature: null };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (['--root', '--pack', '--manifest', '--version', '--simulate-crash-after', '--signature'].includes(token)) {
      const value = rest[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${token} needs a value`);
      index += 1;
      if (token === '--simulate-crash-after') options.simulateCrashAfter = value;
      else if (token === '--signature') options.signature = value;
      else options[token.slice(2)] = value;
    } else if (token === '--help' || token === '-h') {
      options.help = true;
    } else {
      throw new Error(`unknown argument ${token}`);
    }
  }
  return options;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Directory listing that never throws, so a half-finished transaction can always be inspected. */
async function listDirectory(path) {
  try {
    return (await readdir(path)).sort();
  } catch {
    return [];
  }
}

function currentVersionPath(root) {
  return join(root, 'current');
}

async function readActiveVersion(root) {
  try {
    const text = (await readFile(currentVersionPath(root), 'utf8')).trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

async function readHistory(root) {
  try {
    const parsed = await readJson(join(root, 'history.json'));
    return Array.isArray(parsed?.versions) ? parsed.versions.filter((entry) => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

async function writeHistory(root, versions) {
  await writeJson(join(root, 'history.json'), { versions, updatedAt: new Date().toISOString() });
}

async function readJournal(root) {
  try {
    return await readJson(join(root, 'journal.json'));
  } catch {
    return null;
  }
}

/** Verifies the stored copy of a version against the manifest recorded with it. */
async function verifyStoredVersion(root, version) {
  const versionRoot = join(root, 'versions', version);
  if (!(await exists(versionRoot))) return { ok: false, problems: [`version ${version} is not present under ${versionRoot}`] };
  let manifest;
  try {
    manifest = await readJson(join(versionRoot, 'manifest.json'));
  } catch (error) {
    return { ok: false, problems: [`version ${version} has no readable manifest of record (${error.message})`] };
  }
  const { problems } = await verifyPack({ manifest, pack: join(versionRoot, 'pack') });
  return { ok: problems.length === 0, problems };
}

/**
 * Recovers from a previous interrupted transaction before starting a new one. A committed journal
 * is simply cleared; an uncommitted one is cleared too, because the transaction never replaced
 * `current`. Nothing here touches the active version: recovery only removes the transaction's own
 * partial state, so the previous version stays recoverable (and rollback-able).
 */
async function recoverInterruptedTransaction(root) {
  const journal = await readJournal(root);
  if (!journal) return;
  const active = await readActiveVersion(root);
  const activeLooksSane = active !== null && (await verifyStoredVersion(root, active)).ok;
  if (journal.stagedDir) {
    await rm(journal.stagedDir, { recursive: true, force: true });
  }
  await rm(join(root, 'journal.json'), { force: true });
  if (!activeLooksSane && typeof journal.previous === 'string') {
    // The commit never completed (or the previous version was replaced by a half-written commit):
    // put the recorded previous version back so the app has a working version again.
    await writeFile(currentVersionPath(root), `${journal.previous}\n`);
  }
}

function stagePrinter(simulateCrashAfter) {
  return async function completeStage(stage) {
    console.log(`stage: ${stage}`);
    if (simulateCrashAfter === stage) {
      console.error(`crash-simulated: stopped after stage ${stage} (SIGKILL stand-in, before the next stage)`);
      process.exit(70);
    }
  };
}

async function pruneVersions(root, keepVersion) {
  const keep = new Set([keepVersion]);
  const history = await readHistory(root);
  for (const version of history.slice(-KEEP_PREVIOUS_VERSIONS)) keep.add(version);
  const rollbackTarget = history.length >= 2 ? history[history.length - 2] : null;
  if (rollbackTarget) keep.add(rollbackTarget);
  for (const version of await listDirectory(join(root, 'versions'))) {
    if (!keep.has(version)) await rm(join(root, 'versions', version), { recursive: true, force: true });
  }
}

async function installOrUpdate(options) {
  const { root, pack, manifest: manifestPath, version } = options;
  if (!root || !pack || !manifestPath || !version) {
    return fail('install/update need --root <dir> --pack <dir> --manifest <path> --version <v>');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(version)) {
    return fail(`version ${JSON.stringify(version)} must be a single path-safe token`);
  }
  if (options.simulateCrashAfter !== null && !CRASH_STAGES.includes(options.simulateCrashAfter)) {
    return fail(`--simulate-crash-after must be one of ${CRASH_STAGES.join(', ')}`);
  }

  const packRoot = resolve(pack);
  let manifest;
  try {
    manifest = await readJson(manifestPath);
  } catch (error) {
    return fail(`manifest ${manifestPath} could not be read as JSON (${error.message})`);
  }

  await mkdir(root, { recursive: true });
  await mkdir(join(root, 'versions'), { recursive: true });
  await mkdir(join(root, 'staging'), { recursive: true });
  await recoverInterruptedTransaction(root);

  const completeStage = stagePrinter(options.simulateCrashAfter);

  // stage: verify — every declared asset must resolve to the declared bytes and digest.
  const { problems } = await verifyPack({ manifest, pack: packRoot });
  if (problems.length > 0) {
    for (const problem of problems) console.error(`problem: ${problem}`);
    console.error(`verify: ${problems.length} problem(s); the active version is unchanged`);
    process.exitCode = 1;
    return null;
  }
  await completeStage('verify');

  // stage: stage — an immutable copy of the verified pack, never read before commit.
  const transactionId = randomUUID();
  const stagedDir = join(root, 'staging', `${version}-${transactionId}`);
  await mkdir(stagedDir, { recursive: true });
  await cp(packRoot, join(stagedDir, 'pack'), { recursive: true });
  await writeFile(join(stagedDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  let signature = null;
  if (options.signature) {
    signature = basename(options.signature);
    await cp(options.signature, join(stagedDir, 'signature'), { force: true });
  }
  await writeJson(join(stagedDir, 'record.json'), {
    version,
    stagedAt: new Date().toISOString(),
    sourcePack: packRoot,
    sourceManifest: resolve(manifestPath),
    transactionId,
    signature,
    assets: manifest.assets.map((asset) => ({ id: asset.id, kind: asset.kind, sha256: asset.sha256, bytes: asset.bytes })),
  });
  // Re-verify the staged copy: what is committed must be the bytes that were verified.
  const staged = await verifyPack({ manifest, pack: join(stagedDir, 'pack') });
  if (staged.problems.length > 0) {
    for (const problem of staged.problems) console.error(`problem: ${problem}`);
    process.exitCode = 1;
    return null;
  }
  await completeStage('stage');

  // stage: journal — the durable transaction record a crash or restart can inspect.
  const previous = await readActiveVersion(root);
  const journal = {
    transactionId,
    operation: previous === null || previous === version ? 'install' : 'update',
    version,
    previous,
    stagedDir,
    startedAt: new Date().toISOString(),
    signature,
  };
  await writeJson(join(root, 'journal.json'), journal);
  await completeStage('journal');

  // stage: commit — move the staged version into place, then flip `current` in one rename.
  const committedDir = join(root, 'versions', version);
  await rm(committedDir, { recursive: true, force: true });
  await mkdir(dirname(committedDir), { recursive: true });
  await rename(stagedDir, committedDir);
  const currentPath = currentVersionPath(root);
  await writeFile(join(root, `.current-${transactionId}`), `${version}\n`);
  await rename(join(root, `.current-${transactionId}`), currentPath);
  const history = await readHistory(root);
  const nextHistory = history[history.length - 1] === version ? history : [...history, version];
  await writeHistory(root, nextHistory);
  await completeStage('commit');

  // stage: cleanup — drop the partial state and keep the versions rollback may need.
  await rm(stagedDir, { recursive: true, force: true });
  await rm(join(root, 'journal.json'), { force: true });
  await pruneVersions(root, version);
  await completeStage('cleanup');

  console.log(`active: ${version}`);
  return null;
}

async function verifyCommand(options) {
  const { root } = options;
  if (!root) return fail('verify needs --root <dir>');
  const version = await readActiveVersion(root);
  if (version === null) return fail(`no active version under ${resolve(root)}: run install before verify`, 1);
  const { ok, problems } = await verifyStoredVersion(root, version);
  if (!ok) {
    for (const problem of problems) console.error(`problem: ${problem}`);
    console.error(`active: ${version}`);
    console.error('verify: failed');
    process.exitCode = 1;
    return null;
  }
  console.log(`active: ${version}`);
  console.log('verify: ok');
  return null;
}

async function rollbackCommand(options) {
  const { root } = options;
  if (!root) return fail('rollback needs --root <dir>');
  const active = await readActiveVersion(root);
  if (active === null) return fail(`no active version under ${resolve(root)}: nothing to roll back`, 1);
  const history = await readHistory(root);
  const index = history.lastIndexOf(active);
  const target = index > 0 ? history[index - 1] : null;
  if (target === null) {
    return fail(`version ${active} has no previous version to roll back to`, 1);
  }
  const { ok, problems } = await verifyStoredVersion(root, target);
  if (!ok) {
    for (const problem of problems) console.error(`problem: ${problem}`);
    console.error(`rollback: ${target} does not verify; keeping ${active} active`);
    process.exitCode = 1;
    return null;
  }
  await writeFile(currentVersionPath(root), `${target}\n`);
  await writeHistory(root, history.slice(0, index));
  console.log(`active: ${target}`);
  return null;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    return fail(error.message);
  }
  if (options.help || !options.command) {
    console.log('usage: node scripts/release/install.mjs <install|update|verify|rollback> [--root <dir>] [--pack <dir>] [--manifest <path>] [--version <v>] [--simulate-crash-after <stage>] [--signature <file>]');
    return null;
  }
  if (options.command === 'install' || options.command === 'update') return installOrUpdate(options);
  if (options.command === 'verify') return verifyCommand(options);
  if (options.command === 'rollback') return rollbackCommand(options);
  return fail(`unknown command ${options.command}`);
}

main().catch((error) => {
  console.error(`problem: ${error?.stack ?? error}`);
  process.exitCode = 1;
});
