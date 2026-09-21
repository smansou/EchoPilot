#!/usr/bin/env node
/**
 * Q03 staged install / update / verify / rollback with crash simulation.
 *
 *   node scripts/release/install.mjs install  --root <dir> --pack <dir> --manifest <path> --version <v>
 *   node scripts/release/install.mjs update   --root <dir> --pack <dir> --manifest <path> --version <v>
 *   node scripts/release/install.mjs verify   --root <dir>
 *   node scripts/release/install.mjs rollback --root <dir>
 *   ... install/update accept `--simulate-crash-after <verify|stage|journal|commit>`, the release
 *   policy that pins the trusted Developer ID key (`--policy <installers.json>`) and the signature
 *   record that travelled with the pack (`--signature <file>`, or `<pack>/signature.json`).
 *
 * The on-disk store is what makes an interrupted install recoverable:
 *
 *   <root>/current            the active version (the only pointer the app reads)
 *   <root>/versions/<v>/      an immutable copy of a verified pack + the manifest of record
 *   <root>/staging/           partial staging areas, never read as an installed version
 *   <root>/journal.json       the in-flight transaction record (present only mid-transaction)
 *   <root>/history.json       committed versions, oldest first, used by `rollback`
 *   <root>/policy.json        the authenticity policy this store has committed to (once signed,
 *                             always signed: an update may not silently drop the signature)
 *   <root>/versions/<v>/signature.json   the verified record, re-checked by `verify` and `rollback`
 *
 * A successful install/update prints `stage: verify`, `stage: stage`, `stage: journal`,
 * `stage: commit`, `stage: cleanup` in that order and exits 0. A pack that fails verification
 * prints `problem: <detail>` lines, exits nonzero, never reaches `stage: commit`, and leaves the
 * active version untouched. `--simulate-crash-after <stage>` runs the same code path, finishes the
 * named stage, prints its line and stops nonzero — the deterministic stand-in for SIGKILL/power
 * loss. `verify` re-hashes the stored active version against the manifest recorded at install time
 * from a fresh process, and `rollback` restores the version that was active before the most recent
 * successful install/update.
 *
 * Authenticity: the manifest of record travels with the pack, so a self-consistent manifest proves
 * nothing by itself. When the manifest declares `authenticity.requiresSignature` (models/manifest.json
 * does) or the store already committed a signed version, a valid Developer ID signature record is
 * mandatory: it must name the pinned identity/team, bind the exact manifest bytes and the whole pack
 * digest, and verify against the public key pinned in the release policy. A missing, stale or
 * substituted record prints `problem: signature: ...`, exits nonzero before `stage: stage`, and
 * leaves the active version untouched. A pack that ships a record is held to the same check even
 * when the manifest does not require one, and an install that ends up unsigned is reported as such.
 */
import { randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SIGNATURE_FILE_NAME,
  readSignatureRecord,
  sha256PackDirectory,
  trustAnchor,
  verifySignatureRecord,
} from './signature-record.mjs';
import { verifyPack } from './verify-pack.mjs';

const CRASH_STAGES = Object.freeze(['verify', 'stage', 'journal', 'commit']);
const KEEP_PREVIOUS_VERSIONS = 2;
const RELEASE_POLICY_PATH = join(dirname(fileURLToPath(import.meta.url)), 'installers.json');

function fail(message, code = 2) {
  console.error(`problem: ${message}`);
  process.exitCode = code;
  return null;
}

function parseArgs(argv) {
  const [first, ...rest] = argv;
  const options = { command: first === '--help' || first === '-h' ? null : first, help: first === '--help' || first === '-h', simulateCrashAfter: null, signature: null, policy: null };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (['--root', '--pack', '--manifest', '--version', '--simulate-crash-after', '--signature', '--policy'].includes(token)) {
      const value = rest[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${token} needs a value`);
      index += 1;
      if (token === '--simulate-crash-after') options.simulateCrashAfter = value;
      else if (token === '--signature') options.signature = value;
      else if (token === '--policy') options.policy = value;
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

/**
 * Loads the release policy that pins the trusted Developer ID identity and public key. It ships
 * with the installer (next to this script, or wherever `--policy` points); it is never read from
 * the pack, because the pack is exactly what is being checked.
 */
async function loadReleasePolicy(policyOption) {
  const policyPath = policyOption ? resolve(policyOption) : RELEASE_POLICY_PATH;
  try {
    const policy = await readJson(policyPath);
    return { ok: true, policyPath, policy, anchor: trustAnchor(policy), problem: null };
  } catch (error) {
    return {
      ok: false,
      policyPath,
      policy: null,
      anchor: trustAnchor(null),
      problem: `release policy ${policyPath} could not be read as JSON (${error.message}); without it no signature can be verified`,
    };
  }
}

/** The authenticity policy this store has committed to, written at commit time. */
async function readStorePolicy(root) {
  try {
    const parsed = await readJson(join(root, 'policy.json'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Records the store's authenticity policy. `requiresSignature` is sticky: a store that has
 * committed a signed version keeps requiring one, so an update cannot silently drop the signature.
 */
async function writeStorePolicy(root, { requiresSignature, anchor, signedVersion, signedManifestSha256 }) {
  const previous = await readStorePolicy(root);
  const policy = {
    requiresSignature: requiresSignature === true || previous?.requiresSignature === true,
    signingIdentity: anchor.signingIdentity ?? previous?.signingIdentity ?? null,
    teamIdentifier: anchor.teamIdentifier ?? previous?.teamIdentifier ?? null,
    signatureFormat: anchor.signatureFormat ?? previous?.signatureFormat ?? null,
    publicKeySha256: anchor.publicKeySha256 ?? previous?.publicKeySha256 ?? null,
    signedVersion: signedVersion ?? previous?.signedVersion ?? null,
    signedManifestSha256: signedManifestSha256 ?? previous?.signedManifestSha256 ?? null,
    updatedAt: new Date().toISOString(),
  };
  await writeJson(join(root, 'policy.json'), policy);
  return policy;
}

/**
 * Resolves and verifies the signature that travels with a pack. The requirement comes from the
 * manifest of record (`authenticity.requiresSignature`) and from the store's own committed policy;
 * any record that is present — via `--signature` or `<pack>/signature.json` — is always verified,
 * so a pack cannot present an unverifiable record and slip through as unsigned.
 */
async function checkSignature({ packRoot, manifest, manifestBytes, options, anchor, storePolicy, policyProblem }) {
  const requiredBy = [];
  if (manifest?.authenticity?.requiresSignature === true) requiredBy.push('the manifest of record requires a Developer ID signature (authenticity.requiresSignature)');
  if (storePolicy?.requiresSignature === true) requiredBy.push('this store has already committed a signed version, so an update may not drop the signature');

  const recordFileName = anchor.recordFileName;
  let source = null;
  if (options.signature) source = resolve(options.signature);
  else if (await exists(join(packRoot, recordFileName))) source = join(packRoot, recordFileName);

  const summary = { verified: false, source: null, requiredBy: [...requiredBy] };
  if (source === null) {
    if (requiredBy.length > 0) {
      return {
        ok: false,
        summary,
        problems: [`signature: ${requiredBy.join('; ')}; pass --signature <file> or ship ${recordFileName} inside the pack`],
      };
    }
    return { ok: true, summary: { ...summary, reason: 'the manifest of record does not require a signature' }, problems: [] };
  }

  const problems = [];
  if (policyProblem) problems.push(`signature: ${policyProblem}`);
  const read = await readSignatureRecord(source);
  if (!read.ok) {
    problems.push(...read.problems);
    return { ok: false, summary, problems };
  }
  const result = await verifySignatureRecord({ record: read.record, manifestBytes, packRoot, anchor });
  problems.push(...result.problems);
  if (problems.length > 0) return { ok: false, summary, problems };

  return {
    ok: true,
    problems: [],
    summary: {
      verified: true,
      source,
      format: read.record.format,
      signingIdentity: read.record.signingIdentity,
      teamIdentifier: read.record.teamIdentifier ?? null,
      algorithm: read.record.algorithm,
      signedAt: read.record.signedAt ?? null,
      manifestSha256: result.manifestSha256,
      packSha256: result.packSha256,
    },
  };
}

/**
 * Verifies the stored copy of a version: every asset against the manifest recorded with it, and —
 * when the version was installed signed — the stored signature record against those exact manifest
 * bytes and the stored pack, using the pinned anchor. A store that has committed a signed version
 * refuses a stored version that records no signature.
 */
async function verifyStoredVersion(root, version, { anchor = trustAnchor(null), policyProblem = null } = {}) {
  const versionRoot = join(root, 'versions', version);
  if (!(await exists(versionRoot))) return { ok: false, problems: [`version ${version} is not present under ${versionRoot}`] };
  let manifest;
  let manifestBytes;
  try {
    manifestBytes = await readFile(join(versionRoot, 'manifest.json'));
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch (error) {
    return { ok: false, problems: [`version ${version} has no readable manifest of record (${error.message})`] };
  }
  const problems = (await verifyPack({ manifest, pack: join(versionRoot, 'pack') })).problems;
  const recordPath = join(versionRoot, SIGNATURE_FILE_NAME);
  const storePolicy = await readStorePolicy(root);
  if (await exists(recordPath)) {
    if (policyProblem) {
      problems.push(`signature: ${policyProblem}`);
    } else {
      const read = await readSignatureRecord(recordPath);
      if (!read.ok) problems.push(...read.problems);
      else {
        const verified = await verifySignatureRecord({
          record: read.record,
          manifestBytes,
          packRoot: join(versionRoot, 'pack'),
          anchor,
        });
        problems.push(...verified.problems);
      }
    }
  } else if (storePolicy?.requiresSignature === true) {
    problems.push(`signature: this store committed signed versions, but ${version} records no ${SIGNATURE_FILE_NAME}`);
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Recovers from a previous interrupted transaction before starting a new one. A committed journal
 * is simply cleared; an uncommitted one is cleared too, because the transaction never replaced
 * `current`. Nothing here touches the active version: recovery only removes the transaction's own
 * partial state, so the previous version stays recoverable (and rollback-able).
 */
async function recoverInterruptedTransaction(root, context) {
  const journal = await readJournal(root);
  if (!journal) return;
  const active = await readActiveVersion(root);
  const activeLooksSane = active !== null && (await verifyStoredVersion(root, active, context)).ok;
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
  let manifestBytes;
  try {
    manifestBytes = await readFile(manifestPath);
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch (error) {
    return fail(`manifest ${manifestPath} could not be read as JSON (${error.message})`);
  }

  await mkdir(root, { recursive: true });
  await mkdir(join(root, 'versions'), { recursive: true });
  await mkdir(join(root, 'staging'), { recursive: true });

  const releasePolicy = await loadReleasePolicy(options.policy);
  const storePolicy = await readStorePolicy(root);
  const context = { anchor: releasePolicy.anchor, policyProblem: releasePolicy.problem };
  await recoverInterruptedTransaction(root, context);

  // Authenticity comes before anything else that could touch the store: a substituted pack with a
  // rewritten, self-consistent manifest must not even reach the staging area.
  const signature = await checkSignature({
    packRoot,
    manifest,
    manifestBytes,
    options,
    anchor: releasePolicy.anchor,
    storePolicy,
    policyProblem: releasePolicy.problem,
  });
  if (!signature.ok) {
    for (const problem of signature.problems) console.error(`problem: ${problem}`);
    console.error(`signature: rejected (${releasePolicy.policyPath}); the active version is unchanged`);
    process.exitCode = 1;
    return null;
  }
  if (signature.summary.verified) {
    console.log(`signature: verified ${signature.summary.signingIdentity} (${signature.summary.algorithm})`);
  } else {
    console.log(`signature: none presented; ${signature.summary.reason}`);
  }

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
  // The manifest of record is stored as the exact bytes that were verified (and, when signed, the
  // exact bytes the signature covers), never as a re-serialization.
  await writeFile(join(stagedDir, 'manifest.json'), manifestBytes);
  if (signature.summary.verified) {
    await cp(signature.summary.source, join(stagedDir, SIGNATURE_FILE_NAME), { force: true });
    const [sourceDigest, stagedDigest] = await Promise.all([
      sha256PackDirectory(packRoot, { exclude: [SIGNATURE_FILE_NAME] }),
      sha256PackDirectory(join(stagedDir, 'pack'), { exclude: [SIGNATURE_FILE_NAME] }),
    ]);
    if (sourceDigest !== stagedDigest) {
      console.error(`problem: signature: the staged pack hashes to ${stagedDigest}, the signed pack hashes to ${sourceDigest}; nothing was committed`);
      process.exitCode = 1;
      return null;
    }
  }
  await writeJson(join(stagedDir, 'record.json'), {
    version,
    stagedAt: new Date().toISOString(),
    sourcePack: packRoot,
    sourceManifest: resolve(manifestPath),
    transactionId,
    signature: signature.summary,
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
    signature: signature.summary,
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
  await writeStorePolicy(root, {
    requiresSignature: signature.summary.verified,
    anchor: releasePolicy.anchor,
    signedVersion: signature.summary.verified ? version : null,
    signedManifestSha256: signature.summary.verified ? signature.summary.manifestSha256 : null,
  });
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
  const releasePolicy = await loadReleasePolicy(options.policy);
  const { ok, problems } = await verifyStoredVersion(root, version, { anchor: releasePolicy.anchor, policyProblem: releasePolicy.problem });
  if (!ok) {
    for (const problem of problems) console.error(`problem: ${problem}`);
    console.error(`active: ${version}`);
    console.error('verify: failed');
    process.exitCode = 1;
    return null;
  }
  console.log(`active: ${version}`);
  if (await exists(join(root, 'versions', version, SIGNATURE_FILE_NAME))) {
    console.log(`signature: verified against ${releasePolicy.policyPath}`);
  }
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
  const releasePolicy = await loadReleasePolicy(options.policy);
  const { ok, problems } = await verifyStoredVersion(root, target, { anchor: releasePolicy.anchor, policyProblem: releasePolicy.problem });
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
    console.log('usage: node scripts/release/install.mjs <install|update|verify|rollback> [--root <dir>] [--pack <dir>] [--manifest <path>] [--version <v>] [--simulate-crash-after <stage>] [--signature <file>] [--policy <installers.json>]');
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
