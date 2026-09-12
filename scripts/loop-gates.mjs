// Bounded, deterministic validation-command collection for EchoPilot loop gates.
// Pure filesystem inspection: no subprocesses, no network, no mutation of caller inputs,
// no symlink traversal, and no invented shell commands or expensive native work.
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, posix, resolve } from 'node:path';

const SCAN_ROOTS = ['apps', 'packages'];
const SKIP_DIRECTORIES = new Set(['node_modules', '.git', '.loop', '.build', 'dist', 'generated']);
const TEST_FILE_PATTERN = /\.(?:test|spec)\.(?:ts|tsx|js|mjs|cjs)$/;
const TEST_BATCH_SIZE = 30;
const MAX_DIRECTORY_DEPTH = 24;
const MANIFEST_NAME = 'Package.swift';
const BASE_GATES = [['pnpm', 'contracts:check'], ['pnpm', 'typecheck'], ['pnpm', 'build']];
const TARGET_DECLARATION = /\.\s*(testTarget|executableTarget|target|macro|plugin|systemLibrary|binaryTarget)\s*\(/g;
const TARGET_NAME = /\bname\s*:\s*"([^"]+)"/;
const TARGET_PATH = /\bpath\s*:\s*"([^"]+)"/;

function comparePaths(left, right) {
  return left === right ? 0 : left < right ? -1 : 1;
}

async function isFile(path) {
  try { return (await lstat(path)).isFile(); } catch { return false; }
}

async function isDirectory(path) {
  try { return (await lstat(path)).isDirectory(); } catch { return false; }
}

function normalizeRelative(value) {
  return String(value).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function isInsidePath(relative, directory) {
  const base = normalizeRelative(directory);
  return !base || base === '.' || relative === base || relative.startsWith(`${base}/`);
}

function looksLikeTestPath(relative) {
  return /(?:^|\/)Tests?\//.test(relative) || /Tests?\.swift$/.test(relative);
}

function validArgv(value) {
  return Array.isArray(value) && value.length > 0 && value.every(part => typeof part === 'string' && part.length > 0);
}

function sameArgv(left, right) {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

// Depth-first walk of one scan root. Symlinks are skipped entirely, excluded directories are
// never entered, and results are returned as sorted repository-relative POSIX paths.
async function walkTests(root, scanRoot) {
  const base = join(root, scanRoot);
  if (!(await isDirectory(base))) return [];
  const files = [];
  const stack = [{ absolute: base, relative: scanRoot, depth: 0 }];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try { entries = await readdir(current.absolute, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const relative = `${current.relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name) || current.depth + 1 > MAX_DIRECTORY_DEPTH) continue;
        stack.push({ absolute: join(current.absolute, entry.name), relative, depth: current.depth + 1 });
      } else if (entry.isFile() && TEST_FILE_PATTERN.test(entry.name)) {
        files.push(relative);
      }
    }
  }
  return files;
}

async function nearestManifest(root, relative) {
  let directory = posix.dirname(relative);
  for (;;) {
    if (directory === '..' || directory.startsWith('../')) return null;
    const candidate = directory === '.' ? MANIFEST_NAME : `${directory}/${MANIFEST_NAME}`;
    if (await isFile(join(root, candidate))) return candidate;
    if (directory === '.') return null;
    directory = posix.dirname(directory);
  }
}

function skipStringLiteral(source, start) {
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === '\\') { index += 1; continue; }
    if (source[index] === '"') return index;
  }
  return source.length - 1;
}

// Finds the closing parenthesis of a declaration while ignoring strings and comments.
function matchParenthesis(source, open) {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (character === '"') { index = skipStringLiteral(source, index); continue; }
    if (character === '/' && source[index + 1] === '/') { const end = source.indexOf('\n', index); if (end < 0) return -1; index = end; continue; }
    if (character === '/' && source[index + 1] === '*') { const end = source.indexOf('*/', index + 2); if (end < 0) return -1; index = end + 1; continue; }
    if (character === '(') depth += 1;
    else if (character === ')') { depth -= 1; if (depth === 0) return index; }
  }
  return -1;
}

// Simple manifest parsing: target type, name, and explicit path, with SwiftPM's default
// Sources/<name> and Tests/<name> directories when no path is declared.
function parseSwiftManifest(source) {
  const targets = [];
  TARGET_DECLARATION.lastIndex = 0;
  let declaration;
  while ((declaration = TARGET_DECLARATION.exec(source))) {
    const open = declaration.index + declaration[0].length - 1;
    const close = matchParenthesis(source, open);
    if (close < 0) break;
    const body = source.slice(open + 1, close);
    const name = TARGET_NAME.exec(body)?.[1];
    if (name) {
      const path = TARGET_PATH.exec(body)?.[1] ?? `${declaration[1] === 'testTarget' ? 'Tests' : 'Sources'}/${name}`;
      targets.push({ type: declaration[1], name, path });
    }
    TARGET_DECLARATION.lastIndex = close + 1;
  }
  return targets;
}

async function loadTargets(root, manifest, cache) {
  if (!cache.has(manifest)) {
    let source = '';
    try { source = await readFile(join(root, manifest), 'utf8'); } catch { source = ''; }
    cache.set(manifest, parseSwiftManifest(source));
  }
  return cache.get(manifest);
}

async function isXCTestFile(root, relative) {
  if (posix.basename(relative) !== 'main.swift') return true;
  try { return /import\s+(?:XCTest|Testing)\b/.test(await readFile(join(root, relative), 'utf8')); } catch { return false; }
}

// Native commands stay bounded: one build per discovered manifest, and a test command only
// when the manifest actually declares a testTarget. Unreferenced or executable-style test
// files are reported as missing wiring instead of being claimed as checked.
async function collectNativeChecks(root, changedFiles, missing) {
  const manifests = [];
  const cache = new Map();
  const swiftFiles = new Set();
  for (const value of Array.isArray(changedFiles) ? changedFiles : []) {
    if (typeof value !== 'string' || !value) continue;
    const relative = normalizeRelative(value);
    if (!relative) continue;
    if (relative.startsWith('..') || posix.isAbsolute(relative)) { missing.push(`changed file outside repository: ${value}`); continue; }
    if (relative.endsWith('.swift')) swiftFiles.add(relative);
  }
  for (const relative of [...swiftFiles].sort(comparePaths)) {
    const manifest = await nearestManifest(root, relative);
    if (!manifest) { missing.push(`swift wiring: ${relative} has no ${MANIFEST_NAME} in its directory ancestry; not validated`); continue; }
    if (!manifests.includes(manifest)) manifests.push(manifest);
    if (posix.basename(relative) === MANIFEST_NAME) continue;
    if (!(await isFile(join(root,relative)))) continue; // Deleted sources need a rebuild, not target membership.
    const targets = await loadTargets(root, manifest, cache);
    const packageDirectory = posix.dirname(manifest);
    const target = targets.find(candidate => {
      const declared = normalizeRelative(candidate.path);
      const fullPath = packageDirectory === '.' ? declared : `${packageDirectory}/${declared}`;
      return isInsidePath(relative, fullPath);
    });
    const label = looksLikeTestPath(relative) ? 'unverified native test' : 'swift wiring';
    if (!target) { missing.push(`${label}: ${relative} is not referenced by any target in ${manifest}; not validated`); continue; }
    if ((looksLikeTestPath(relative) && target.type !== 'testTarget') || (target.type === 'testTarget' && !(await isXCTestFile(root, relative)))) {
      missing.push(`unverified native test: ${relative} is an executable script, not an XCTest case in ${manifest}; not validated`);
    }
  }
  manifests.sort(comparePaths);
  const commands = [];
  for (const manifest of manifests) {
    const packagePath = posix.dirname(manifest);
    commands.push(['swift', 'build', '--package-path', packagePath]);
    const targets = await loadTargets(root, manifest, cache);
    if (targets.some(target => target.type === 'testTarget')) commands.push(['swift', 'test', '--package-path', packagePath]);
  }
  return { commands, packages: manifests };
}

// collectChecks(cwd, { testCommand = [], changedFiles = [] }) =>
//   { commands: string[][], coverage: { testFiles: string[], nativePackages: string[] }, missing: string[] }
// Order is deterministic: all-repo node test batches, the frozen ticket command when it is
// new, the fixed pnpm gates, then per-manifest swift commands.
export async function collectChecks(cwd, options = {}) {
  const root = resolve(typeof cwd === 'string' && cwd ? cwd : '.');
  const { testCommand = [], changedFiles = [] } = options ?? {};
  const missing = [];
  const testFiles = [];
  for (const scanRoot of SCAN_ROOTS) testFiles.push(...await walkTests(root, scanRoot));
  testFiles.sort(comparePaths);
  const native = await collectNativeChecks(root, changedFiles, missing);
  const commands = [];
  for (let index = 0; index < testFiles.length; index += TEST_BATCH_SIZE) {
    commands.push(['node', '--import', 'tsx', '--test', ...testFiles.slice(index, index + TEST_BATCH_SIZE)]);
  }
  const frozen = testCommand ?? [];
  if (Array.isArray(frozen) && frozen.length) {
    if (validArgv(frozen)) {
      const argv = frozen.map(part => String(part));
      if (!commands.some(existing => sameArgv(existing, argv))) commands.push(argv);
    } else {
      missing.push('testCommand: expected a non-empty argv of strings; ignored');
    }
  } else if (!Array.isArray(frozen)) {
    missing.push('testCommand: expected an array of strings; ignored');
  }
  for (const gate of BASE_GATES) if (!commands.some(existing => sameArgv(existing, gate))) commands.push([...gate]);
  commands.push(...native.commands);
  return { commands, coverage: { testFiles, nativePackages: native.packages }, missing };
}
