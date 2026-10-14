#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFile, readdir, rename, rm, stat, mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { sha256Directory } from './release/verify-pack.mjs';

const root = resolve(import.meta.dirname, '..');
const asrRoot = join(root, 'models', 'asr');
const final = join(asrRoot, 'small.en');
const manifest = JSON.parse(await readFile(join(root, 'models', 'manifest.json'), 'utf8'));
const pin = manifest.assets.find((asset) => asset.id === 'whisper-small-en-2026-04');
if (!pin) throw new Error('Whisper small.en is absent from models/manifest.json.');

const ARGMAX_REVISION = '0f63a7800b00dd0226abd051b906c246e1907482';
const OPENAI_REVISION = 'e8727524f962ee844a7319d92be39ac1bd25655a';

async function totalBytes(directory) {
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    bytes += entry.isDirectory() ? await totalBytes(path) : (await stat(path)).size;
  }
  return bytes;
}

async function verify(directory) {
  const [hash, bytes] = await Promise.all([sha256Directory(directory), totalBytes(directory)]);
  if (hash !== pin.sha256 || bytes !== pin.bytes) {
    throw new Error(`Whisper pack differs from the pinned manifest: sha256=${hash}, bytes=${bytes}; expected ${pin.sha256}, ${pin.bytes}.`);
  }
  console.log(`Verified WhisperKit small.en: ${hash}, ${bytes} bytes`);
}

function hf(args) {
  const result = spawnSync('uvx', ['--from', 'huggingface_hub', 'hf', 'download', ...args], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Hugging Face download failed (${result.status}).`);
}

await mkdir(asrRoot, { recursive: true });
try {
  await stat(final);
  await verify(final);
  process.exit(0);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

const staging = await mkdtemp(join(asrRoot, '.vendor-'));
try {
  hf(['argmaxinc/whisperkit-coreml', '--revision', ARGMAX_REVISION,
    '--include', 'openai_whisper-small.en/*', '--local-dir', staging]);
  const model = join(staging, 'openai_whisper-small.en');
  hf(['openai/whisper-small.en', 'tokenizer.json', 'tokenizer_config.json',
    '--revision', OPENAI_REVISION, '--local-dir', model]);
  await rm(join(staging, '.cache'), { recursive: true, force: true });
  await rm(join(model, '.cache'), { recursive: true, force: true });
  await verify(model);
  await rename(model, final);
  console.log(`Installed ${final}`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
