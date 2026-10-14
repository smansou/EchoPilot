#!/usr/bin/env node
// Public, ungated MIT CoreML model; downloads are build-time only, never application runtime.
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { sha256Directory } from './release/verify-pack.mjs';

const root = resolve(import.meta.dirname, '..');
const modelRoot = join(root, 'models/asr');
const modelName = 'silero_vad.mlmodelc';
const destination = join(modelRoot, modelName);
const manifest = JSON.parse(await readFile(join(root, 'models/manifest.json'), 'utf8'));
const pin = manifest.assets.find((asset) => asset.id === 'silero-vad-coreml-6.2.1');
if (!pin) throw new Error('Silero VAD pin is missing from models/manifest.json');
async function byteSize(directory) {
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    bytes += entry.isDirectory() ? await byteSize(file) : (await stat(file)).size;
  }
  return bytes;
}
async function verify(directory) {
  const [digest, bytes] = await Promise.all([sha256Directory(directory), byteSize(directory)]);
  if (digest !== pin.sha256 || bytes !== pin.bytes) throw new Error(`Silero pack does not match pin: ${digest}, ${bytes} bytes`);
  console.log(`Verified Silero VAD v6.2.1: ${digest}, ${bytes} bytes`);
}
await mkdir(modelRoot, { recursive: true });
try {
  await stat(destination);
  await verify(destination);
  process.exit(0);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const staging = await mkdtemp(join(modelRoot, '.vendor-vad-'));
try {
  const downloaded = spawnSync('uvx', ['--from', 'huggingface_hub', 'hf', 'download',
    pin.repository, '--revision', pin.revision, '--include', `${modelName}/*`, '--local-dir', staging], {
    cwd: root, stdio: 'inherit',
    // This pack is public. Prevent a configured token from turning it into an authenticated fetch.
    env: { ...process.env, HF_HUB_DISABLE_IMPLICIT_TOKEN: '1' },
  });
  if (downloaded.error || downloaded.status !== 0) throw downloaded.error ?? new Error(`Model download exited ${downloaded.status}`);
  await verify(join(staging, modelName));
  await rename(join(staging, modelName), destination);
} finally {
  await rm(staging, { recursive: true, force: true });
}
