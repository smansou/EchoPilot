#!/usr/bin/env node
/**
 * Q03 update signature records — the detached Developer ID signature that travels with a pack.
 *
 * An update travels as three things: the pack (the payload bytes), the manifest of record that
 * pins every asset inside it, and a signature record (`signature.json`). The manifest alone proves
 * nothing about authenticity, because it travels with the pack: a substituted pack plus a
 * rewritten, self-consistent manifest would verify against itself. The signature record is the
 * part an attacker cannot produce, because the verifier holds only the public half of the release
 * key — pinned in `scripts/release/installers.json` (`distribution.signingPublicKeyPem`, checked
 * against `distribution.signingPublicKeySha256`) and never taken from the pack.
 *
 * The signed message binds the record format, the sha256 of the exact manifest bytes and the
 * sha256 of the whole pack directory:
 *
 *   echopilot-devid-signature/1
 *   manifest-sha256=<64 hex>
 *   pack-sha256=<64 hex>
 *
 * so the record is only accepted when the bytes being installed are the bytes that were signed.
 * The pack digest covers every file in the pack except the record itself (which sits inside the
 * pack when the pack ships signed), so an undeclared file added anywhere in the pack is a
 * mismatch too.
 *
 * Release tooling creates records with `scripts/release/sign-manifest.mjs`; `install.mjs` verifies
 * them before it stages anything and re-verifies the stored copy from a fresh process.
 */
import { createHash, sign, verify } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export const SIGNATURE_FORMAT = 'echopilot-devid-signature/1';
export const SIGNATURE_FILE_NAME = 'signature.json';
export const SIGNATURE_ALGORITHMS = Object.freeze(['rsa-sha256', 'ecdsa-sha256', 'ed25519']);

const NODE_DIGEST = Object.freeze({ 'rsa-sha256': 'sha256', 'ecdsa-sha256': 'sha256', ed25519: null });

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function isSupportedAlgorithm(algorithm) {
  return typeof algorithm === 'string' && Object.hasOwn(NODE_DIGEST, algorithm);
}

async function listPackFiles(directory, relative = '.') {
  const found = [];
  for (const entry of await readdir(join(directory, relative === '.' ? '' : relative), { withFileTypes: true })) {
    const child = relative === '.' ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) found.push(...(await listPackFiles(directory, child)));
    else if (entry.isFile()) found.push(child);
  }
  return found;
}

/**
 * Digest of a whole pack directory: sha256 of the sorted `"<sha256(file)>  <relative path>\n"`
 * lines, with `exclude` (pack-relative POSIX paths) left out so a pack can carry its own record.
 */
export async function sha256PackDirectory(directory, { exclude = [] } = {}) {
  const digest = createHash('sha256');
  const skipped = new Set(exclude);
  const files = (await listPackFiles(directory)).sort();
  for (const relativePath of files) {
    if (skipped.has(relativePath)) continue;
    const bytes = await readFile(join(directory, relativePath));
    digest.update(`${sha256Hex(bytes)}  ${relativePath}\n`);
  }
  return digest.digest('hex');
}

/** The exact bytes the release key signs, and the exact bytes the verifier reconstructs. */
export function signatureMessage({ format, manifestSha256, packSha256 }) {
  return Buffer.from(`${format}\nmanifest-sha256=${manifestSha256}\npack-sha256=${packSha256}\n`, 'utf8');
}

/** Reads a record from disk. A missing or unparsable file is a problem, never a silent pass. */
export async function readSignatureRecord(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    return { ok: false, problems: [`signature: ${path} could not be read (${error.message})`] };
  }
  try {
    return { ok: true, record: JSON.parse(text) };
  } catch (error) {
    return { ok: false, problems: [`signature: ${path} is not valid JSON (${error.message})`] };
  }
}

/** The pinned trust anchor: who may sign, and which public key verifies them. */
export function trustAnchor(policy) {
  const distribution = policy?.distribution ?? {};
  return {
    signingIdentity: typeof distribution.signingIdentity === 'string' && distribution.signingIdentity.length > 0
      ? distribution.signingIdentity
      : null,
    teamIdentifier: typeof distribution.teamIdentifier === 'string' && distribution.teamIdentifier.length > 0
      ? distribution.teamIdentifier
      : null,
    signatureFormat: typeof distribution.signatureFormat === 'string' && distribution.signatureFormat.length > 0
      ? distribution.signatureFormat
      : SIGNATURE_FORMAT,
    publicKeyPem: typeof distribution.signingPublicKeyPem === 'string' && distribution.signingPublicKeyPem.length > 0
      ? distribution.signingPublicKeyPem
      : null,
    publicKeySha256: typeof distribution.signingPublicKeySha256 === 'string' && distribution.signingPublicKeySha256.length > 0
      ? distribution.signingPublicKeySha256
      : null,
    recordFileName: typeof distribution.signatureRecord === 'string' && distribution.signatureRecord.length > 0
      ? distribution.signatureRecord
      : SIGNATURE_FILE_NAME,
  };
}

/**
 * Builds the record a release job ships with a pack. Throws on a malformed key or an unsupported
 * algorithm so a release job cannot publish a record the verifier would refuse.
 */
export async function createSignatureRecord({
  manifestBytes,
  packRoot,
  privateKeyPem,
  signingIdentity,
  teamIdentifier,
  algorithm = 'ecdsa-sha256',
  signedAt = new Date().toISOString(),
}) {
  if (!isSupportedAlgorithm(algorithm)) {
    throw new Error(`unsupported signature algorithm ${JSON.stringify(algorithm)}; expected ${SIGNATURE_ALGORITHMS.join(', ')}`);
  }
  if (typeof signingIdentity !== 'string' || signingIdentity.length === 0) {
    throw new Error('the signing identity must be the Developer ID identity the policy pins');
  }
  if (typeof teamIdentifier !== 'string' || teamIdentifier.length === 0) {
    throw new Error('the team identifier must be the Developer ID team the policy pins');
  }
  const manifestSha256 = sha256Hex(manifestBytes);
  const packSha256 = await sha256PackDirectory(packRoot, { exclude: [SIGNATURE_FILE_NAME] });
  const message = signatureMessage({ format: SIGNATURE_FORMAT, manifestSha256, packSha256 });
  const signature = sign(NODE_DIGEST[algorithm], message, privateKeyPem);
  return {
    format: SIGNATURE_FORMAT,
    signingIdentity,
    teamIdentifier,
    algorithm,
    manifestSha256,
    packSha256,
    signedAt,
    note: 'Detached Developer ID signature over the manifest and pack digests; verified by scripts/release/install.mjs against the pinned key in scripts/release/installers.json.',
    signature: signature.toString('base64'),
  };
}

/**
 * Verifies one record against the bytes actually being installed and the pinned anchor. Returns
 * `{ ok, problems }` and never throws for record content, so callers can print every violation.
 */
export async function verifySignatureRecord({ record, manifestBytes, packRoot, anchor }) {
  const problems = [];
  const fail = (detail) => problems.push(`signature: ${detail}`);
  const expectedFormat = anchor?.signatureFormat ?? SIGNATURE_FORMAT;

  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    fail('the signature file is not a JSON object');
    return { ok: false, problems };
  }
  if (record.format !== expectedFormat) {
    fail(`record format ${JSON.stringify(record.format ?? null)} is not the pinned format ${JSON.stringify(expectedFormat)}`);
  }
  if (anchor?.signingIdentity) {
    if (record.signingIdentity !== anchor.signingIdentity) {
      fail(`signed by ${JSON.stringify(record.signingIdentity ?? null)}, but the pinned release policy names ${JSON.stringify(anchor.signingIdentity)}`);
    }
  } else {
    fail('the release policy pins no Developer ID identity (installers.json distribution.signingIdentity), so a signature cannot be trusted');
  }
  if (anchor?.teamIdentifier && record.teamIdentifier !== anchor.teamIdentifier) {
    fail(`team identifier ${JSON.stringify(record.teamIdentifier ?? null)} is not the pinned ${JSON.stringify(anchor.teamIdentifier)}`);
  }
  if (!isSupportedAlgorithm(record.algorithm)) {
    fail(`algorithm ${JSON.stringify(record.algorithm ?? null)} is not one of ${SIGNATURE_ALGORITHMS.join(', ')}`);
  }

  const manifestSha256 = sha256Hex(manifestBytes);
  if (record.manifestSha256 !== manifestSha256) {
    fail(
      `the record signs manifest ${record.manifestSha256 ?? '<missing>'}, but the manifest of record hashes to ${manifestSha256}`
      + ' (a substituted pack with a rewritten manifest is not accepted)',
    );
  }
  const packSha256 = await sha256PackDirectory(packRoot, { exclude: [SIGNATURE_FILE_NAME] });
  if (record.packSha256 !== packSha256) {
    fail(
      `the record signs pack ${record.packSha256 ?? '<missing>'}, but the pack directory hashes to ${packSha256}`
      + ' (an added, removed or edited file in the pack is not accepted)',
    );
  }

  let signatureBytes = null;
  if (typeof record.signature !== 'string' || record.signature.length === 0) {
    fail('the record carries no base64 signature');
  } else {
    signatureBytes = Buffer.from(record.signature, 'base64');
    if (signatureBytes.length === 0) {
      fail('the record signature is empty');
      signatureBytes = null;
    }
  }

  if (!anchor?.publicKeyPem) {
    fail('the release policy pins no Developer ID public key (installers.json distribution.signingPublicKeyPem): nothing can verify the signature, so it is rejected');
  } else if (anchor.publicKeySha256 && sha256Hex(Buffer.from(anchor.publicKeyPem, 'utf8')) !== anchor.publicKeySha256) {
    const derived = sha256Hex(Buffer.from(anchor.publicKeyPem, 'utf8'));
    fail(
      `the pinned public key hashes to ${derived}, but distribution.signingPublicKeySha256 records ${anchor.publicKeySha256}`
      + ' (the shipped trust anchor is inconsistent, so no record can be trusted: fix the pin, never trust the pack)',
    );
  } else if (signatureBytes && problems.length === 0) {
    const message = signatureMessage({ format: record.format, manifestSha256: record.manifestSha256, packSha256: record.packSha256 });
    let verified = false;
    try {
      verified = verify(NODE_DIGEST[record.algorithm], message, anchor.publicKeyPem, signatureBytes);
    } catch (error) {
      fail(`the pinned public key could not check the record (${error.message})`);
    }
    if (!verified && problems.length === 0) {
      fail('the detached signature does not verify against the pinned Developer ID public key');
    }
  }

  return { ok: problems.length === 0, problems, manifestSha256, packSha256 };
}
