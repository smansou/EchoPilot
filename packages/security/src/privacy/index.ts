/**
 * S03 privacy seam — private session, passphrase-sealed export, restore into a new profile.
 *
 * The ticket path is a choice the user makes, and every surface afterwards has to reflect it:
 *
 *  - **Private session.** A private session is a *memory-only* buffer. It is constructed without a
 *    store handle and it holds no path, so there is nothing it could write to; when it ends it hands
 *    the transcript back and drops it. The durable pipeline is untouched by construction rather
 *    than by a flag a later code path could forget to check.
 *  - **Export.** `exportProfile` seals the profile directory into one archive under a key derived
 *    from the user's passphrase (scrypt, then AES-256-GCM over the whole manifest). The archive is
 *    ciphertext: neither the store's encrypted databases nor the derived M02/M04 sidecars are
 *    readable in it, and the passphrase itself is never written anywhere.
 *  - **Restore.** `importProfile` authenticates and verifies the *whole* archive in memory before
 *    it writes a single byte, so a wrong passphrase fails with the destination exactly as it was —
 *    no re-initialization, no partial tree, no half-restored profile. A successful restore lands in
 *    a fresh directory with the evidence intact (the profile database, project databases, and the
 *    derived state travel together, so the restored readers can answer again).
 *
 * What is deliberately *not* here: the retention policy that decides when a profile may be sealed,
 * and the deletion semantics (`forget`) that live in `@echopilot/memory/deletion`. This module only
 * carries a profile across a passphrase boundary.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

const EXPORT_MAGIC = 'echopilot-private-export-v1';
const EXPORT_VERSION = 1;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const MIN_PASSPHRASE_LENGTH = 12;
/** scrypt cost: interactive-grade work factor, with the memory limit raised to match it. */
const SCRYPT_COST = { N: 2 ** 15, r: 8, p: 1, maxmem: 96 * 1024 * 1024 } as const;

export type PrivateSessionEntry = Readonly<{
  sequence: number;
  kind: 'utterance' | 'observation';
  text: string;
  at: string;
}>;

export interface PrivateSession {
  /** True while the session accepts entries; false after `end()`. */
  active(): boolean;
  /** Buffers one entry in memory only. Persisting it is not offered, not even on request. */
  record(entry: Readonly<{ kind: PrivateSessionEntry['kind']; text: string }>): PrivateSessionEntry;
  /** The in-memory transcript, oldest first. */
  transcript(): readonly PrivateSessionEntry[];
  /** Ends the session and returns what the UI may show once; the buffer is dropped here. */
  end(): readonly PrivateSessionEntry[];
}

export type CreatePrivateSessionOptions = Readonly<{
  /** Identity shown in the UI while the private indicator is on; never persisted. */
  scope: Readonly<{ profileId: string; projectId?: string; sessionId: string }>;
  now?: () => Date;
}>;

export type ExportProfileRequest = Readonly<{
  /** Profile directory to seal: the store databases plus the derived state next to them. */
  directory: string;
  /** Archive path to write; it must not live inside `directory`. */
  destination: string;
  passphrase: string;
  now?: () => Date;
}>;

export type ExportReceipt = Readonly<{
  destination: string;
  /** Relative paths carried by the archive, sorted; the export reports what it actually sealed. */
  files: readonly string[];
  bytes: number;
}>;

export type ImportProfileRequest = Readonly<{
  archive: string;
  /** Destination profile directory; it must be absent so a restore cannot mix with existing data. */
  directory: string;
  passphrase: string;
}>;

export type ImportReceipt = Readonly<{
  directory: string;
  files: readonly string[];
}>;

type Manifest = Readonly<{
  version: number;
  createdAt: string;
  files: readonly Readonly<{ path: string; sha256: string; bytes: string }>[];
}>;

function requirePassphrase(passphrase: unknown): string {
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new TypeError(`private export requires a passphrase of at least ${MIN_PASSPHRASE_LENGTH} characters`);
  }
  return passphrase;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`privacy requires ${label}`);
  return value;
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_BYTES, SCRYPT_COST);
}

function digestOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Rejects an archive path that would escape the restore directory when joined. */
function safeRelativePath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '');
  const components = normalized.split('/');
  if (normalized.length === 0 || normalized.includes('\0') || isAbsolute(normalized)
    || /^[a-zA-Z]:/.test(normalized)
    || components.some((component) => component.length === 0 || component === '.' || component === '..')) {
    throw new Error(`private export carries an unsafe path: ${value}`);
  }
  return normalized;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return false;
    throw error;
  }
}

async function filesUnder(root: string, skip: ReadonlySet<string>): Promise<string[]> {
  const found: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (skip.has(path)) continue;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) found.push(relative(root, path));
    }
  };
  await walk(root);
  return found.sort();
}

/**
 * Seals a profile into one passphrase-encrypted archive. The whole payload is a single GCM
 * envelope, so authentication covers every file at once: an archive that fails its passphrase
 * check can never be partially restored.
 *
 * The manifest is assembled in memory (one base64 copy of the profile's on-disk bytes), which is
 * the profile-sized bound this seam accepts; nothing is written until the seal succeeded.
 */
export async function exportProfile(request: ExportProfileRequest): Promise<ExportReceipt> {
  const directory = resolve(requireText(request?.directory, 'an export directory'));
  const destination = resolve(requireText(request?.destination, 'an export destination'));
  const passphrase = requirePassphrase(request?.passphrase);
  const inside = relative(directory, destination);
  if (!inside.startsWith('..') && !isAbsolute(inside)) {
    throw new TypeError('private export destination must not live inside the exported directory');
  }

  const paths = await filesUnder(directory, new Set([destination, `${destination}.tmp`]));
  const files: { path: string; sha256: string; bytes: string }[] = [];
  for (const path of paths) {
    const bytes = await readFile(join(directory, path));
    files.push({ path, sha256: digestOf(bytes), bytes: bytes.toString('base64') });
  }
  const manifest: Manifest = {
    version: EXPORT_VERSION,
    createdAt: (request.now ?? (() => new Date()))().toISOString(),
    files,
  };
  const sealed = sealArchive(passphrase, Buffer.from(JSON.stringify(manifest), 'utf8'));
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.tmp`;
  await writeFile(temporary, sealed, { mode: 0o600 });
  await rename(temporary, destination);
  return { destination, files: files.map((file) => file.path), bytes: sealed.byteLength };
}

function sealArchive(passphrase: string, plaintext: Buffer): Buffer {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from(`${EXPORT_MAGIC}\n`, 'utf8'), salt, iv, cipher.getAuthTag(), body]);
}

function openArchive(passphrase: string, archive: Buffer): Buffer {
  const header = Buffer.from(`${EXPORT_MAGIC}\n`, 'utf8');
  const fail = (): never => {
    throw new Error('private export could not be decrypted with the provided passphrase (wrong passphrase or damaged archive)');
  };
  if (archive.length < header.length + SALT_BYTES + IV_BYTES + TAG_BYTES || !archive.subarray(0, header.length).equals(header)) {
    fail();
  }
  const salt = archive.subarray(header.length, header.length + SALT_BYTES);
  const iv = archive.subarray(header.length + SALT_BYTES, header.length + SALT_BYTES + IV_BYTES);
  const tag = archive.subarray(header.length + SALT_BYTES + IV_BYTES, header.length + SALT_BYTES + IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(archive.subarray(header.length + SALT_BYTES + IV_BYTES + TAG_BYTES)), decipher.final()]);
  } catch {
    return fail();
  }
}

function parseManifest(plaintext: Buffer): Manifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext.toString('utf8'));
  } catch {
    throw new Error('private export manifest is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error('private export manifest is not an object');
  const candidate = parsed as { version?: unknown; createdAt?: unknown; files?: unknown };
  if (candidate.version !== EXPORT_VERSION || !Array.isArray(candidate.files)) {
    throw new Error(`private export manifest is not a supported v${EXPORT_VERSION} archive`);
  }
  const files: { path: string; sha256: string; bytes: string }[] = [];
  for (const entry of candidate.files) {
    if (typeof entry !== 'object' || entry === null) throw new Error('private export manifest carries a malformed file entry');
    const file = entry as { path?: unknown; sha256?: unknown; bytes?: unknown };
    const path = safeRelativePath(requireText(file.path, 'a file path in the export manifest'));
    const sha256 = requireText(file.sha256, 'a file digest in the export manifest');
    if (typeof file.bytes !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.bytes)) {
      throw new Error(`private export file ${path} is not valid base64`);
    }
    if (!/^[a-f0-9]{64}$/i.test(sha256)) throw new Error(`private export file ${path} has an invalid digest`);
    files.push({ path, sha256, bytes: file.bytes });
  }
  const paths = new Set<string>();
  for (const file of files) {
    if (paths.has(file.path)) throw new Error(`private export manifest repeats the path ${file.path}`);
    paths.add(file.path);
  }
  for (const path of paths) {
    const components = path.split('/');
    for (let index = 1; index < components.length; index += 1) {
      const parent = components.slice(0, index).join('/');
      if (paths.has(parent)) throw new Error(`private export manifest uses ${parent} as both a file and directory`);
    }
  }
  return { version: EXPORT_VERSION, createdAt: typeof candidate.createdAt === 'string' ? candidate.createdAt : '', files };
}

/**
 * Restores an archive into an absent profile directory. Authentication and per-file digest checks
 * run before any write, so a wrong passphrase (or a damaged archive) leaves the destination
 * untouched. Files are assembled in a private sibling directory and installed with one rename;
 * an existing profile is never overlaid or partially replaced.
 */
export async function importProfile(request: ImportProfileRequest): Promise<ImportReceipt> {
  const archivePath = resolve(requireText(request?.archive, 'an archive path'));
  const directory = resolve(requireText(request?.directory, 'a restore directory'));
  const passphrase = requirePassphrase(request?.passphrase);

  const archive = await readFile(archivePath);
  const manifest = parseManifest(openArchive(passphrase, archive));
  const decoded = manifest.files.map((file) => {
    const bytes = Buffer.from(file.bytes, 'base64');
    if (bytes.toString('base64') !== file.bytes) throw new Error(`private export file ${file.path} is not valid base64`);
    const digest = Buffer.from(digestOf(bytes), 'hex');
    const expected = Buffer.from(file.sha256, 'hex');
    if (expected.length !== digest.length || !timingSafeEqual(expected, digest)) {
      throw new Error(`private export file ${file.path} failed its integrity check`);
    }
    return { path: file.path, bytes };
  });

  if (await pathExists(directory)) throw new Error('private export restore destination must be a new, absent profile directory');
  const parent = dirname(directory);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const staging = join(parent, `.${basename(directory)}.restore-${randomBytes(12).toString('hex')}`);
  await mkdir(staging, { mode: 0o700 });
  try {
    for (const file of decoded) {
      const target = join(staging, file.path);
      const inside = relative(staging, target);
      if (inside.length === 0 || inside.startsWith('..') || isAbsolute(inside)) {
        throw new Error(`private export file ${file.path} escapes the restore directory`);
      }
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, file.bytes, { mode: 0o600, flag: 'wx' });
    }
    // Recheck immediately before installation so a destination created during staging is refused.
    if (await pathExists(directory)) throw new Error('private export restore destination must be a new, absent profile directory');
    await rename(staging, directory);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  return { directory, files: decoded.map((file) => file.path) };
}

/**
 * Opens a private session. Nothing this object receives can reach durable storage: it holds the
 * buffered entries and nothing else — no store, no directory, no writer callback.
 */
export async function createPrivateSession(options: CreatePrivateSessionOptions): Promise<PrivateSession> {
  if (options === null || typeof options !== 'object') throw new TypeError('createPrivateSession requires { scope }');
  const sessionId = requireText(options.scope?.sessionId, 'a sessionId');
  requireText(options.scope?.profileId, 'a profileId');
  const now = options.now ?? (() => new Date());
  const entries: PrivateSessionEntry[] = [];
  let open = true;

  return {
    active: (): boolean => open,
    record: (entry): PrivateSessionEntry => {
      if (!open) throw new Error(`private session ${sessionId} has already ended`);
      const text = requireText(entry?.text, 'private session entry text');
      const recorded: PrivateSessionEntry = {
        sequence: entries.length + 1,
        kind: entry.kind === 'observation' ? 'observation' : 'utterance',
        text,
        at: now().toISOString(),
      };
      entries.push(recorded);
      return recorded;
    },
    transcript: (): readonly PrivateSessionEntry[] => entries.map((entry) => ({ ...entry })),
    end: (): readonly PrivateSessionEntry[] => {
      open = false;
      const ended = entries.map((entry) => ({ ...entry }));
      entries.length = 0;
      return ended;
    },
  };
}

/** Removes a restored profile tree; the counterpart a user needs when they choose to discard it. */
export async function discardProfile(directory: string): Promise<void> {
  const target = resolve(requireText(directory, 'a profile directory to discard'));
  await rm(target, { recursive: true, force: true });
}
