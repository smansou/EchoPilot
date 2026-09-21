#!/usr/bin/env node
/**
 * Q03 release-time pack verification.
 *
 *   node scripts/release/verify-pack.mjs --manifest <manifest.json> --pack <directory>
 *
 * Exits 0 only when every asset declared in `models/manifest.json` resolves inside the pack to
 * bytes of the declared length and digest. Nothing here touches the network: the pack is the
 * candidate payload (a vendored model directory, a release DMG payload, an update pack) and the
 * manifest is the pin record the app ships with.
 *
 * Digest rules (the frozen Q03 seam):
 *   - file asset: sha256 of its bytes, `bytes` is its length;
 *   - directory asset: sha256 of the sorted lines
 *     `"<sha256(file bytes)>  <path relative to the asset directory>\n"` (POSIX separators), so an
 *     added, removed or edited file inside the declared directory is a mismatch.
 *
 * `path` and `licenseFile` resolve relative to the pack root, so a pack that lost an asset's
 * license notice is a mismatch too. Every violation prints one `problem: <detail>` line naming the
 * offending asset id, and the process exits nonzero.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HEX64 = /^[0-9a-f]{64}$/;

export class PackProblems extends Error {
  constructor(problems) {
    super(`${problems.length} pack problem(s)`);
    this.name = 'PackProblems';
    this.problems = problems;
  }
}

export function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Rejects absolute paths, `..` segments and Windows separators: every reference stays in the pack. */
export function isSafeRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value.startsWith('/') || value.includes('\\')) return false;
  const segments = value.split('/');
  return segments.every((segment) => segment.length > 0 && segment !== '..' && segment !== '.');
}

/** `path` is POSIX and pack-relative; this refuses anything that could escape the pack root. */
export function resolveInPack(packRoot, relativePath) {
  if (!isSafeRelativePath(relativePath)) return null;
  const absolute = resolve(packRoot, relativePath);
  if (absolute !== packRoot && !absolute.startsWith(`${packRoot}${sep}`)) return null;
  return absolute;
}

async function listFilesRecursive(directory, relative = '.') {
  const found = [];
  for (const entry of await readdir(join(directory, relative === '.' ? '' : relative), { withFileTypes: true })) {
    const child = relative === '.' ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) found.push(...(await listFilesRecursive(directory, child)));
    else if (entry.isFile()) found.push(child);
  }
  return found;
}

/** The frozen directory-asset digest: sorted `"<sha256(file)>  <relative path>\n"` lines. */
export async function sha256Directory(directory) {
  const digest = createHash('sha256');
  const files = (await listFilesRecursive(directory)).sort();
  for (const relativePath of files) {
    const bytes = await readFile(join(directory, relativePath));
    digest.update(`${sha256Bytes(bytes)}  ${relativePath}\n`);
  }
  return digest.digest('hex');
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Verifies one manifest against one pack. Returns `{ problems, verified }`; never throws for pack
 * content, so callers (install/update) can report every violation in one pass.
 */
export async function verifyPack({ manifest, pack }) {
  const problems = [];
  const packRoot = resolve(pack);
  const seen = new Set();

  if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.assets)) {
    problems.push('manifest: the manifest has no assets[] list to verify');
    return { problems, verified: [] };
  }
  if (!(await isDirectory(packRoot))) {
    problems.push(`pack: ${packRoot} is not a readable pack directory`);
    return { problems, verified: [] };
  }

  if (manifest.offlineInstall) {
    if (manifest.offlineInstall.requiresApiKey !== false) {
      problems.push('manifest: offlineInstall.requiresApiKey must be false for an offline pack');
    }
    if (!Array.isArray(manifest.offlineInstall.runtimeDownloads) || manifest.offlineInstall.runtimeDownloads.length > 0) {
      problems.push('manifest: offlineInstall.runtimeDownloads must be empty for an offline pack');
    }
  }

  const verified = [];
  for (const asset of manifest.assets) {
    const id = typeof asset?.id === 'string' && asset.id.length > 0 ? asset.id : '<unidentified asset>';
    if (typeof asset?.id !== 'string' || asset.id.length === 0) problems.push(`${id}: every asset needs a non-empty id`);
    if (seen.has(asset?.id)) problems.push(`${id}: duplicate asset id in the manifest`);
    seen.add(asset?.id);

    if (!isSafeRelativePath(asset?.path)) {
      problems.push(`${id}: path ${JSON.stringify(asset?.path ?? null)} must be a pack-relative POSIX path without '..'`);
      continue;
    }
    if (!HEX64.test(String(asset?.sha256 ?? ''))) {
      problems.push(`${id}: sha256 ${JSON.stringify(asset?.sha256 ?? null)} must be a lowercase 64-hex digest`);
      continue;
    }
    if (!Number.isInteger(asset?.bytes) || asset.bytes < 0) {
      problems.push(`${id}: bytes ${JSON.stringify(asset?.bytes ?? null)} must be a non-negative integer`);
      continue;
    }

    const target = resolveInPack(packRoot, asset.path);
    if (target === null) {
      problems.push(`${id}: path ${asset.path} escapes the pack root`);
      continue;
    }

    if (typeof asset.licenseFile === 'string' && asset.licenseFile.length > 0) {
      const licensePath = resolveInPack(packRoot, asset.licenseFile);
      if (licensePath === null) {
        problems.push(`${id}: licenseFile ${JSON.stringify(asset.licenseFile)} must be a pack-relative POSIX path without '..'`);
      } else if (!(await isFile(licensePath))) {
        problems.push(`${id}: license notice ${asset.licenseFile} is missing from the pack`);
      }
    } else {
      problems.push(`${id}: licenseFile must record the license notice that travels with the asset`);
    }

    if (await isFile(target)) {
      const bytes = await readFile(target);
      if (bytes.length !== asset.bytes) {
        problems.push(`${id}: ${asset.path} is ${bytes.length} bytes, manifest declares ${asset.bytes}`);
      }
      const digest = sha256Bytes(bytes);
      if (digest !== asset.sha256) {
        problems.push(`${id}: ${asset.path} hashes to ${digest}, manifest pins ${asset.sha256}`);
      }
      if (bytes.length === asset.bytes && digest === asset.sha256) verified.push(asset.id);
      continue;
    }

    if (await isDirectory(target)) {
      const digest = await sha256Directory(target);
      if (digest !== asset.sha256) {
        problems.push(`${id}: directory ${asset.path} hashes to ${digest} (sorted file-line digest), manifest pins ${asset.sha256}`);
      }
      const files = await listFilesRecursive(target);
      const total = (await Promise.all(files.map(async (file) => (await stat(join(target, file))).size)))
        .reduce((sum, size) => sum + size, 0);
      if (total !== asset.bytes) {
        problems.push(`${id}: directory ${asset.path} holds ${total} bytes, manifest declares ${asset.bytes}`);
      }
      if (total === asset.bytes && digest === asset.sha256) verified.push(asset.id);
      continue;
    }

    problems.push(`${id}: ${asset.path} is missing from the pack (no file or directory at that path)`);
  }

  return { problems, verified };
}

function parseArgs(argv) {
  const options = { manifest: null, pack: null };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--manifest' || token === '--pack') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${token} needs a path`);
      options[token.slice(2)] = value;
      index += 1;
    } else if (token === '--help' || token === '-h') {
      options.help = true;
    } else {
      throw new Error(`unknown argument ${token}`);
    }
  }
  return options;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`problem: ${error.message}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log('usage: node scripts/release/verify-pack.mjs --manifest <manifest.json> --pack <pack-directory>');
    return;
  }
  if (!options.manifest || !options.pack) {
    console.error('problem: --manifest <manifest.json> and --pack <pack-directory> are both required');
    process.exitCode = 2;
    return;
  }

  let manifest;
  try {
    manifest = JSON.parse(await readFile(options.manifest, 'utf8'));
  } catch (error) {
    console.error(`problem: manifest ${options.manifest} could not be read as JSON (${error.message})`);
    process.exitCode = 2;
    return;
  }

  const { problems, verified } = await verifyPack({ manifest, pack: options.pack });
  for (const problem of problems) console.error(`problem: ${problem}`);
  if (problems.length > 0) {
    console.error(`verify: ${problems.length} problem(s); the pack is not installable`);
    process.exitCode = 1;
    return;
  }
  console.log(`pack: ${resolve(options.pack)}`);
  console.log(`assets: ${verified.length} verified (${verified.join(', ')})`);
  console.log('verify: ok');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`problem: ${error?.stack ?? error}`);
    process.exitCode = 1;
  });
}
