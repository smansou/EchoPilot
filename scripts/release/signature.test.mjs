#!/usr/bin/env node
/**
 * Focused checks (not the frozen Q03 oracle) for the update signature seam:
 * `node --test scripts/release/signature.test.mjs`.
 *
 * Q03-4/Q03-5 drive unsigned fixture packs through the same staged transaction, so they cannot
 * show that a *substituted pack with a rewritten, self-consistent manifest* is rejected — the one
 * case pack verification alone cannot catch. These checks generate a throwaway signing key, pin its
 * public half in a policy file shaped like `scripts/release/installers.json`, and drive the real
 * CLI:
 *
 *   - a manifest that requires a signature installs nothing without one;
 *   - a signed pack installs, reports the verified identity, and `verify` re-checks it;
 *   - a self-consistent rewritten manifest (dropping the requirement, or re-pinning its own bytes)
 *     and a pack signed by a key the policy does not pin are both rejected before `stage: commit`;
 *   - once a store committed a signed version, an update may not drop the signature;
 *   - a correctly signed update commits and `rollback` restores the signed previous version.
 *   - the shipped `scripts/release/installers.json` anchor is self-consistent, and the default
 *     policy (no `--policy`) refuses a record signed by a key it does not pin.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { trustAnchor } from './signature-record.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const INSTALL = 'scripts/release/install.mjs';
const SIGN_MANIFEST = 'scripts/release/sign-manifest.mjs';
const IDENTITY = 'Developer ID Application: EchoPilot (TEAMID)';
const TEAM = 'TEAMID';
const STAGES = Object.freeze(['stage: verify', 'stage: stage', 'stage: journal', 'stage: commit', 'stage: cleanup']);

const FIXTURE_FILES = Object.freeze([
  ['payload/model.bin', 'q03-signature-fixture-weights-v1'],
  ['payload/voices/alba/tokens.bin', 'q03-signature-fixture-voice-tokens-v1'],
  ['payload/voices/alba/config.json', '{"voice":"alba","sampleRate":24000}'],
  ['licenses/model.txt', 'CC-BY-4.0 fixture license (signature check)'],
  ['licenses/voice.txt', 'CC-BY-4.0 fixture license (signature check)'],
]);

function runNode(script, args) {
  return spawnSync(process.execPath, [join(REPO_ROOT, script), ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, CI: 'true' },
  });
}

function outputOf(result) {
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

function assertStagesInOrder(text, context) {
  let cursor = -1;
  for (const stage of STAGES) {
    const index = text.indexOf(stage);
    assert.ok(index >= 0, `${context} must print '${stage}'\n${text}`);
    assert.ok(index > cursor, `${context} must print '${stage}' in order\n${text}`);
    cursor = index;
  }
}

function activeVersion(text) {
  return text.match(/active:\s*(\S+)/)?.[1] ?? null;
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function listFiles(directory, relative = '.') {
  const found = [];
  for (const entry of await readdir(join(directory, relative === '.' ? '' : relative), { withFileTypes: true })) {
    const child = relative === '.' ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) found.push(...(await listFiles(directory, child)));
    else if (entry.isFile()) found.push(child);
  }
  return found.sort();
}

async function sha256Directory(directory) {
  const digest = createHash('sha256');
  for (const relativePath of await listFiles(directory)) {
    digest.update(`${sha256Hex(await readFile(join(directory, relativePath)))}  ${relativePath}\n`);
  }
  return digest.digest('hex');
}

/** A minimal schema-faithful pack: one file asset, one directory asset, their licence files. */
async function writeFixturePack(workspace, name, { requiresSignature }) {
  const pack = join(workspace, name);
  for (const [relativePath, text] of FIXTURE_FILES) {
    const absolute = join(pack, relativePath);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, Buffer.from(`${text}\n`));
  }
  const weights = await readFile(join(pack, 'payload/model.bin'));
  const voiceRoot = join(pack, 'payload/voices/alba');
  const voiceBytes = (await Promise.all((await listFiles(voiceRoot)).map((file) => readFile(join(voiceRoot, file)))))
    .reduce((total, bytes) => total + bytes.length, 0);
  const manifest = {
    manifestVersion: 1,
    generatedBy: 'signature seam fixture pack',
    outputFormat: { sampleRate: 24000, channels: 1, packetMs: 20 },
    offlineInstall: { requiresApiKey: false, runtimeDownloads: [] },
    assets: [
      {
        id: 'fixture-model',
        kind: 'model',
        revision: 'fixture-2026-09',
        license: 'CC-BY-4.0',
        licenseFile: 'licenses/model.txt',
        path: 'payload/model.bin',
        bytes: weights.length,
        sha256: sha256Hex(weights),
      },
      {
        id: 'fixture-voice',
        kind: 'voice',
        voiceId: 'alba',
        revision: 'fixture-2026-09',
        license: 'CC-BY-4.0',
        licenseFile: 'licenses/voice.txt',
        path: 'payload/voices/alba',
        bytes: voiceBytes,
        sha256: await sha256Directory(voiceRoot),
      },
    ],
  };
  if (requiresSignature) {
    manifest.authenticity = {
      requiresSignature: true,
      signatureFormat: 'echopilot-devid-signature/1',
      signingIdentity: IDENTITY,
      teamIdentifier: TEAM,
    };
  }
  const manifestPath = join(workspace, `${name}-manifest.json`);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { pack, manifestPath, manifest };
}

/** A policy file shaped like scripts/release/installers.json, pinning a throwaway key. */
async function writePolicy(workspace, name, publicKeyPem) {
  const path = join(workspace, `${name}-policy.json`);
  await writeFile(path, `${JSON.stringify({
    release: 'echopilot-desktop',
    distribution: {
      signingIdentity: IDENTITY,
      teamIdentifier: TEAM,
      signatureFormat: 'echopilot-devid-signature/1',
      signatureRecord: 'signature.json',
      signingPublicKeyPem: publicKeyPem,
      signingPublicKeySha256: sha256Hex(Buffer.from(publicKeyPem, 'utf8')),
    },
    updates: { staged: true, verifyPackBeforeCommit: true, requiresSignature: true, rollback: true },
  }, null, 2)}\n`);
  return path;
}

async function withWorkspace(prefix, body) {
  const workspace = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await body(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

function writeKeypair(workspace, name) {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicPath = join(workspace, `${name}-public.pem`);
  const privatePath = join(workspace, `${name}-private.pem`);
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
  writeFileSync(publicPath, publicPem);
  writeFileSync(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  return { publicPath, privatePath, publicPem };
}

test('Q03-S1 a manifest that requires a signature installs nothing without one', async () => {
  await withWorkspace('q03-signature-required-', async (workspace) => {
    const key = writeKeypair(workspace, 'release');
    const policy = await writePolicy(workspace, 'release', key.publicPem);
    const pack = await writeFixturePack(workspace, 'pack-1', { requiresSignature: true });
    const root = join(workspace, 'store');

    const unsigned = runNode(INSTALL, ['install', '--root', root, '--pack', pack.pack, '--manifest', pack.manifestPath, '--version', '1.0.0', '--policy', policy]);
    assert.notEqual(unsigned.status, 0, `a signature-requiring manifest must not install unsigned\n${outputOf(unsigned)}`);
    assert.match(outputOf(unsigned), /problem: signature:/, 'the rejection must name the missing signature');
    assert.equal(outputOf(unsigned).includes('stage: commit'), false, 'an unsigned install must never reach the commit stage');
    const status = runNode(INSTALL, ['verify', '--root', root, '--policy', policy]);
    assert.notEqual(status.status, 0, 'an unsigned install must leave no active version behind');
  });
});

test('Q03-S2 a signed pack installs, verifies and rejects a substituted pack', async () => {
  await withWorkspace('q03-signature-signed-', async (workspace) => {
    const key = writeKeypair(workspace, 'release');
    const attacker = writeKeypair(workspace, 'attacker');
    const policy = await writePolicy(workspace, 'release', key.publicPem);
    const attackerPolicy = await writePolicy(workspace, 'attacker', attacker.publicPem);
    const first = await writeFixturePack(workspace, 'pack-1', { requiresSignature: true });
    const root = join(workspace, 'store');
    const record = join(workspace, 'pack-1-signature.json');

    const signed = runNode(SIGN_MANIFEST, ['--manifest', first.manifestPath, '--pack', first.pack, '--key', key.privatePath, '--policy', policy, '--out', record]);
    assert.equal(signed.status, 0, `signing a clean pack must succeed\n${outputOf(signed)}`);
    assert.match(outputOf(signed), /signer: Developer ID Application: EchoPilot/, 'the record must name the pinned identity');

    const install = runNode(INSTALL, ['install', '--root', root, '--pack', first.pack, '--manifest', first.manifestPath, '--version', '1.0.0', '--signature', record, '--policy', policy]);
    assert.equal(install.status, 0, `a signed pack must install\n${outputOf(install)}`);
    assertStagesInOrder(outputOf(install), 'a signed install');
    assert.match(outputOf(install), /signature: verified Developer ID Application: EchoPilot/, 'the install must report the verified identity');

    const verified = runNode(INSTALL, ['verify', '--root', root, '--policy', policy]);
    assert.equal(verified.status, 0, `the signed version must verify\n${outputOf(verified)}`);
    assert.match(outputOf(verified), /signature: verified/, 'verify must re-check the stored record');
    assert.equal(activeVersion(outputOf(verified)), '1.0.0');

    // 1. A new pack signed by a key the policy does not pin is rejected (identity text is not enough).
    const second = await writeFixturePack(workspace, 'pack-2', { requiresSignature: true });
    const forged = join(workspace, 'pack-2-forged.json');
    const forgedSign = runNode(SIGN_MANIFEST, ['--manifest', second.manifestPath, '--pack', second.pack, '--key', attacker.privatePath, '--identity', IDENTITY, '--team', TEAM, '--policy', attackerPolicy, '--out', forged]);
    assert.equal(forgedSign.status, 0, `the attacker can sign with its own key\n${outputOf(forgedSign)}`);
    const forgedUpdate = runNode(INSTALL, ['update', '--root', root, '--pack', second.pack, '--manifest', second.manifestPath, '--version', '2.0.0', '--signature', forged, '--policy', policy]);
    assert.notEqual(forgedUpdate.status, 0, 'a record that does not verify against the pinned key must be rejected');
    assert.match(outputOf(forgedUpdate), /problem: signature:/, 'the rejection must name the signature problem');
    assert.equal(outputOf(forgedUpdate).includes('stage: commit'), false, 'a mis-signed update must never commit');

    // 2. A rewritten, self-consistent manifest (new pins for tampered bytes) with the old record is rejected.
    const substituted = join(workspace, 'pack-2-substituted');
    await cp(second.pack, substituted, { recursive: true });
    await writeFile(join(substituted, 'payload/model.bin'), Buffer.from('q03-signature-fixture-weights-v1-tampered\n'));
    const weights = await readFile(join(substituted, 'payload/model.bin'));
    const rewritten = JSON.parse(await readFile(second.manifestPath, 'utf8'));
    rewritten.assets[0].bytes = weights.length;
    rewritten.assets[0].sha256 = sha256Hex(weights);
    const rewrittenPath = join(workspace, 'pack-2-rewritten-manifest.json');
    await writeFile(rewrittenPath, `${JSON.stringify(rewritten, null, 2)}\n`);
    const staleRecord = join(workspace, 'pack-1-signature.json');
    const substitutedUpdate = runNode(INSTALL, ['update', '--root', root, '--pack', substituted, '--manifest', rewrittenPath, '--version', '2.0.0', '--signature', staleRecord, '--policy', policy]);
    assert.notEqual(substitutedUpdate.status, 0, 'a substituted pack with a rewritten manifest must be rejected');
    assert.match(outputOf(substitutedUpdate), /problem: signature:.*manifest/, 'the rejection must name the manifest binding');
    assert.equal(outputOf(substitutedUpdate).includes('stage: commit'), false, 'a substituted update must never commit');

    // 3. Dropping the requirement and the record entirely does not work once the store is signed.
    const unsignedRewrite = await writeFixturePack(workspace, 'pack-3', { requiresSignature: false });
    const droppedSignature = runNode(INSTALL, ['update', '--root', root, '--pack', unsignedRewrite.pack, '--manifest', unsignedRewrite.manifestPath, '--version', '3.0.0', '--policy', policy]);
    assert.notEqual(droppedSignature.status, 0, 'a signed store must refuse an update that drops the signature');
    assert.match(outputOf(droppedSignature), /problem: signature:.*already committed a signed version/, 'the rejection must explain the carry-forward');
    assert.equal(outputOf(droppedSignature).includes('stage: commit'), false, 'an unsigned rewrite must never commit');

    const stillSigned = runNode(INSTALL, ['verify', '--root', root, '--policy', policy]);
    assert.equal(stillSigned.status, 0, `the signed version must survive the rejected updates\n${outputOf(stillSigned)}`);
    assert.equal(activeVersion(outputOf(stillSigned)), '1.0.0', 'the signed version must stay active');

    // 4. Tampering with the stored pack breaks verify too.
    await writeFile(join(root, 'versions', '1.0.0', 'pack', 'payload', 'model.bin'), Buffer.from('tampered in the store\n'));
    const tampered = runNode(INSTALL, ['verify', '--root', root, '--policy', policy]);
    assert.notEqual(tampered.status, 0, 'a tampered stored version must fail verify');
    assert.match(outputOf(tampered), /problem:/, 'a failed verify must name its problem');
  });
});

test('Q03-S3 a signed update commits and rollback restores the signed previous version', async () => {
  await withWorkspace('q03-signature-update-', async (workspace) => {
    const key = writeKeypair(workspace, 'release');
    const policy = await writePolicy(workspace, 'release', key.publicPem);
    const root = join(workspace, 'store');

    const first = await writeFixturePack(workspace, 'pack-1', { requiresSignature: true });
    const firstRecord = join(workspace, 'pack-1-signature.json');
    assert.equal(runNode(SIGN_MANIFEST, ['--manifest', first.manifestPath, '--pack', first.pack, '--key', key.privatePath, '--policy', policy, '--out', firstRecord]).status, 0);
    const install = runNode(INSTALL, ['install', '--root', root, '--pack', first.pack, '--manifest', first.manifestPath, '--version', '1.0.0', '--signature', firstRecord, '--policy', policy]);
    assert.equal(install.status, 0, `the signed install must succeed\n${outputOf(install)}`);

    // The record defaults to <pack>/signature.json, so a pack can travel signed without --signature.
    const second = await writeFixturePack(workspace, 'pack-2', { requiresSignature: true });
    const signedInPack = runNode(SIGN_MANIFEST, ['--manifest', second.manifestPath, '--pack', second.pack, '--key', key.privatePath, '--policy', policy]);
    assert.equal(signedInPack.status, 0, `signing into the pack must succeed\n${outputOf(signedInPack)}`);
    const recordInPack = await stat(join(second.pack, 'signature.json')).then(() => true, () => false);
    assert.ok(recordInPack, 'the record must travel inside the pack');
    const update = runNode(INSTALL, ['update', '--root', root, '--pack', second.pack, '--manifest', second.manifestPath, '--version', '2.0.0', '--policy', policy]);
    assert.equal(update.status, 0, `an update whose record travels with the pack must succeed\n${outputOf(update)}`);
    assertStagesInOrder(outputOf(update), 'a signed update');
    assert.match(outputOf(update), /signature: verified/, 'the update must report the verified signature');

    const rollback = runNode(INSTALL, ['rollback', '--root', root, '--policy', policy]);
    assert.equal(rollback.status, 0, `rollback must succeed\n${outputOf(rollback)}`);
    assert.equal(activeVersion(outputOf(rollback)), '1.0.0', 'rollback must restore the signed previous version');
    const verified = runNode(INSTALL, ['verify', '--root', root, '--policy', policy]);
    assert.equal(verified.status, 0, `the rolled-back signed version must verify\n${outputOf(verified)}`);
    assert.match(outputOf(verified), /signature: verified/, 'the restored version must still carry its record');
  });
});

test('Q03-S4 a manifest that does not require a signature installs unsigned but says so', async () => {
  await withWorkspace('q03-signature-unsigned-', async (workspace) => {
    const key = writeKeypair(workspace, 'release');
    const policy = await writePolicy(workspace, 'release', key.publicPem);
    const pack = await writeFixturePack(workspace, 'pack-1', { requiresSignature: false });
    const root = join(workspace, 'store');
    const install = runNode(INSTALL, ['install', '--root', root, '--pack', pack.pack, '--manifest', pack.manifestPath, '--version', '1.0.0', '--policy', policy]);
    assert.equal(install.status, 0, `a fixture manifest without an authenticity requirement may install unsigned\n${outputOf(install)}`);
    assertStagesInOrder(outputOf(install), 'an unsigned fixture install');
    assert.match(outputOf(install), /signature: none presented; the manifest of record does not require a signature/, 'the run must not imply the bytes were authenticated');
    const policyState = JSON.parse(await readFile(join(root, 'policy.json'), 'utf8'));
    assert.equal(policyState.requiresSignature, false, 'the store must record that it holds an unsigned version');

    // A pack that ships a record is always held to the check, even when nothing requires one: a
    // pack cannot present an unverifiable record and be treated as unsigned.
    const claimed = await writeFixturePack(workspace, 'pack-2', { requiresSignature: false });
    await writeFile(join(claimed.pack, 'signature.json'), `${JSON.stringify({ format: 'echopilot-devid-signature/1', signature: 'AAAA' }, null, 2)}\n`);
    const rejected = runNode(INSTALL, ['update', '--root', root, '--pack', claimed.pack, '--manifest', claimed.manifestPath, '--version', '2.0.0', '--policy', policy]);
    assert.notEqual(rejected.status, 0, 'a pack whose own record does not verify must be rejected');
    assert.match(outputOf(rejected), /problem: signature:/, 'the rejection must name the signature problem');
    assert.equal(outputOf(rejected).includes('stage: commit'), false, 'an unverifiable record must never commit');
  });
});

test('Q03-S5 the shipped release policy pins a self-consistent anchor that fails closed', async () => {
  await withWorkspace('q03-signature-policy-', async (workspace) => {
    const declaration = JSON.parse(await readFile(join(REPO_ROOT, 'scripts', 'release', 'installers.json'), 'utf8'));
    const anchor = trustAnchor(declaration);
    assert.equal(declaration.updates?.requiresSignature, true, 'installers.json must declare that updates require a signature');
    assert.ok(anchor.signingIdentity, 'the policy must pin the Developer ID identity');
    assert.ok(anchor.teamIdentifier, 'the policy must pin the Developer ID team');
    assert.ok(anchor.publicKeyPem, 'the policy must pin the Developer ID public key');
    assert.ok(anchor.publicKeySha256, 'the policy must pin the public key digest');
    assert.equal(
      sha256Hex(Buffer.from(anchor.publicKeyPem, 'utf8')),
      anchor.publicKeySha256,
      'distribution.signingPublicKeySha256 must equal the sha256 of the pinned PEM as JSON decodes it, or install.mjs rejects every record',
    );

    const policyCheck = runNode(SIGN_MANIFEST, ['--check-policy']);
    assert.equal(policyCheck.status, 0, `the shipped policy must pass its own check\n${outputOf(policyCheck)}`);
    assert.match(outputOf(policyCheck), /policy-check: ok/, 'the check must report success explicitly');

    // The shipped policy is what installs use without --policy. A record that names the pinned
    // identity/team and covers the right bytes, but is signed by a key the anchor does not pin,
    // must be rejected and must never reach the commit stage.
    const attacker = writeKeypair(workspace, 'attacker');
    const pack = await writeFixturePack(workspace, 'pack-1', { requiresSignature: true });
    const forgedRecord = join(workspace, 'pack-1-signature.json');
    const forged = runNode(SIGN_MANIFEST, ['--manifest', pack.manifestPath, '--pack', pack.pack, '--key', attacker.privatePath, '--out', forgedRecord]);
    assert.equal(forged.status, 0, `signing with the throwaway key must succeed locally\n${outputOf(forged)}`);

    const root = join(workspace, 'store');
    const install = runNode(INSTALL, ['install', '--root', root, '--pack', pack.pack, '--manifest', pack.manifestPath, '--version', '1.0.0', '--signature', forgedRecord]);
    assert.notEqual(install.status, 0, `the shipped policy must not accept a key it does not pin\n${outputOf(install)}`);
    assert.match(outputOf(install), /problem: signature:/, 'the rejection must name the signature problem');
    assert.equal(outputOf(install).includes('stage: commit'), false, 'a record the anchor does not pin must never commit');

    const verify = runNode(INSTALL, ['verify', '--root', root]);
    assert.notEqual(verify.status, 0, 'no version may be active after the rejection');
  });
});
