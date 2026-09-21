#!/usr/bin/env node
/**
 * Q03 release-side companion to the installer's signature check.
 *
 *   node scripts/release/sign-manifest.mjs --manifest <manifest.json> --pack <dir> --key <private-key.pem>
 *     [--identity <Developer ID identity>] [--team <team id>] [--algorithm rsa-sha256|ecdsa-sha256|ed25519]
 *     [--policy <installers.json>] [--out <signature.json>]
 *   node scripts/release/sign-manifest.mjs --check-policy [--policy <installers.json>]
 *
 * The release job runs this after the pack is final: it hashes the exact manifest bytes and the
 * whole pack directory, signs both digests with the Developer ID private key, and writes the
 * record that `install.mjs` verifies before it stages anything. The private key never enters the
 * repository: it stays in the release keychain, while `scripts/release/installers.json` pins the
 * public half (`distribution.signingPublicKeyPem` / `signingPublicKeySha256`).
 *
 * The default output path is `<pack>/signature.json`, so the record travels inside the pack the
 * same way the manifest does; `install.mjs` also accepts `--signature <file>` for a detached copy.
 * The record is excluded from the pack digest it signs, so signing a pack does not invalidate it.
 *
 * `--check-policy` validates the trust anchor itself before a signing round: the pinned identity,
 * team and record name must be present and `distribution.signingPublicKeySha256` must equal the
 * sha256 of the pinned PEM as JSON decodes it. An inconsistent anchor makes install.mjs reject
 * every record, so this check is what catches a pin that drifted from the shipped key.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SIGNATURE_ALGORITHMS, SIGNATURE_FILE_NAME, createSignatureRecord, sha256Hex, trustAnchor } from './signature-record.mjs';

function fail(message) {
  console.error(`problem: ${message}`);
  process.exitCode = 2;
}

function parseArgs(argv) {
  const options = { manifest: null, pack: null, key: null, identity: null, team: null, algorithm: 'ecdsa-sha256', policy: null, out: null, checkPolicy: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h' || token === '--check-policy') {
      if (token === '--check-policy') options.checkPolicy = true;
      else options.help = true;
      continue;
    }
    const flag = token.replace(/^--/, '');
    if (['manifest', 'pack', 'key', 'identity', 'team', 'algorithm', 'policy', 'out'].includes(flag)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${token} needs a value`);
      options[flag] = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument ${token}`);
  }
  return options;
}

/**
 * Validates the shipped trust anchor before a signing round: everything the verifier will require
 * must be pinned, and the recorded digest must equal the sha256 of the pinned PEM as JSON decodes
 * it. A drifted pin makes install.mjs reject every record, so this check fails loudly here first.
 */
async function checkPolicy(options) {
  const policyPath = options.policy ? resolve(options.policy) : join(dirname(fileURLToPath(import.meta.url)), 'installers.json');
  let policy;
  try {
    policy = JSON.parse(await readFile(policyPath, 'utf8'));
  } catch (error) {
    return fail(`release policy ${policyPath} could not be read as JSON (${error.message})`);
  }

  const anchor = trustAnchor(policy);
  const derived = anchor.publicKeyPem === null ? null : sha256Hex(Buffer.from(anchor.publicKeyPem, 'utf8'));
  const problems = [];
  if (!anchor.signingIdentity) problems.push('distribution.signingIdentity is missing: a record could not be attributed to a Developer ID identity');
  if (!anchor.teamIdentifier) problems.push('distribution.teamIdentifier is missing: the verifier cannot check the signing team');
  if (!anchor.publicKeyPem) problems.push('distribution.signingPublicKeyPem is missing: nothing can verify a record');
  if (!anchor.publicKeySha256) problems.push('distribution.signingPublicKeySha256 is missing: the pinned key would be unverified');
  if (derived !== null && anchor.publicKeySha256 && derived !== anchor.publicKeySha256) {
    problems.push(`the pinned public key hashes to ${derived}, but distribution.signingPublicKeySha256 records ${anchor.publicKeySha256}`);
  }

  console.log(`policy: ${policyPath}`);
  console.log(`identity: ${anchor.signingIdentity ?? '<missing>'}`);
  console.log(`team: ${anchor.teamIdentifier ?? '<missing>'}`);
  console.log(`format: ${anchor.signatureFormat}`);
  console.log(`record: ${anchor.recordFileName}`);
  console.log(`public-key-sha256: ${derived ?? '<missing>'}`);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`problem: ${problem}`);
    console.error('policy-check: failed');
    process.exitCode = 1;
    return null;
  }
  console.log('policy-check: ok');
  return null;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    return fail(error.message);
  }
  if (options.help) {
    console.log('usage: node scripts/release/sign-manifest.mjs --manifest <manifest.json> --pack <dir> --key <private-key.pem> [--identity <id>] [--team <team id>] [--algorithm <a>] [--policy <installers.json>] [--out <signature.json>] | --check-policy [--policy <installers.json>]');
    return null;
  }
  if (options.checkPolicy) return checkPolicy(options);
  if (!options.manifest || !options.pack || !options.key) {
    return fail('sign-manifest needs --manifest <manifest.json> --pack <dir> --key <private-key.pem>');
  }
  if (!SIGNATURE_ALGORITHMS.includes(options.algorithm)) {
    return fail(`--algorithm must be one of ${SIGNATURE_ALGORITHMS.join(', ')}`);
  }

  const policyPath = options.policy ? resolve(options.policy) : join(dirname(fileURLToPath(import.meta.url)), 'installers.json');
  let anchor = { signatureFormat: undefined, signingIdentity: null, teamIdentifier: null };
  try {
    anchor = trustAnchor(JSON.parse(await readFile(policyPath, 'utf8')));
  } catch (error) {
    if (options.policy) return fail(`release policy ${policyPath} could not be read as JSON (${error.message})`);
  }

  const identity = options.identity ?? anchor.signingIdentity;
  const team = options.team ?? anchor.teamIdentifier;
  if (!identity || !team) {
    return fail(`the Developer ID identity and team are not pinned in ${policyPath}; pass --identity and --team`);
  }

  const packRoot = resolve(options.pack);
  const outPath = resolve(options.out ?? join(packRoot, SIGNATURE_FILE_NAME));
  let manifestBytes;
  let privateKeyPem;
  try {
    [manifestBytes, privateKeyPem] = await Promise.all([readFile(options.manifest), readFile(options.key, 'utf8')]);
  } catch (error) {
    return fail(`could not read the manifest or the private key (${error.message})`);
  }

  let record;
  try {
    record = await createSignatureRecord({
      manifestBytes,
      packRoot,
      privateKeyPem,
      signingIdentity: identity,
      teamIdentifier: team,
      algorithm: options.algorithm,
    });
  } catch (error) {
    return fail(error.message);
  }

  await writeFile(outPath, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`manifest: ${record.manifestSha256}`);
  console.log(`pack: ${record.packSha256}`);
  console.log(`signer: ${record.signingIdentity} (${record.teamIdentifier}, ${record.algorithm})`);
  console.log(`signature: ${outPath}`);
  return null;
}

main().catch((error) => {
  console.error(`problem: ${error?.stack ?? error}`);
  process.exitCode = 1;
});
