/**
 * Electron Forge packaging configuration for the signed, notarized EchoPilot desktop app.
 *
 * The offline installer is the DMG this config produces: every asset the A+B journey needs —
 * the Whisper small.en pack, the Qwen3.5-4B reasoner bundle, the Pocket TTS weights and voice
 * presets, and the bundled pocket-tts worker interpreter — is embedded with `extraResource`
 * from the repository (or from the vendored pack the release job staged next to it). Nothing is
 * fetched after installation: there is no download URL anywhere in the embed list, and
 * `hooks.packageAfterCopy` verifies the vendored pack against models/manifest.json before the
 * bundle is signed, so a tampered or incomplete pack cannot be packaged.
 */
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerZIP } from '@electron-forge/maker-zip';
import { VitePlugin } from '@electron-forge/plugin-vite';

const repoRoot = resolve(__dirname, '..', '..');


const appVersion = process.env.ECHOPILOT_VERSION ?? '0.0.0';
const signingIdentity = process.env.ECHOPILOT_SIGN_IDENTITY;

const config: ForgeConfig = {
  packagerConfig: {
    name: 'EchoPilot',
    appBundleId: 'com.echopilot.desktop',
    appVersion,
    asar: {
      unpack: '**/{models,workers/pocket-tts,echopilot-helper}/**',
    },
    // Repository-relative payloads the app must carry so it works with no network. The embed
    // list is the offline installer's asset set; a download URL may never appear here.
    extraResource: ['models', 'workers/pocket-tts', 'native/macos/.build/release/echopilot-helper'].map(
      (relativePath) => join(repoRoot, relativePath),
    ),
    osxSign: {
      identity: signingIdentity,
      hardenedRuntime: true,
      gatekeeperAssess: false,
      entitlements: join(__dirname, 'build', 'entitlements.mac.plist'),
      'entitlements-inherit': join(__dirname, 'build', 'entitlements.mac.plist'),
    },
    osxNotarize: {
      appleId: process.env.APPLE_ID ?? '',
      appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD ?? '',
      teamId: process.env.APPLE_TEAM_ID ?? '',
    },
  },
  makers: [
    new MakerDMG(
      {
        name: `EchoPilot-${appVersion}-offline`,
        format: 'ULFO',
        icon: join(__dirname, 'build', 'icon.icns'),
        overwrite: true,
      },
      ['darwin'],
    ),
    new MakerZIP({}, ['darwin']),
  ],
  plugins: [
    new VitePlugin({
      build: [
        { entry: 'src/main/index.ts', config: 'vite.main.config.ts' },
        { entry: 'src/preload/index.ts', config: 'vite.preload.config.ts' },
      ],
      renderer: [{ name: 'main_window', config: 'vite.renderer.config.ts' }],
    }),
  ],
  hooks: {
    /**
     * Release guard: the model pack that is about to be bundled must verify against the manifest
     * pins first (scripts/release/verify-pack.mjs). A mismatch aborts packaging instead of
     * shipping bytes that the worker would refuse to load.
     */
    packageAfterCopy: async (_forgeConfig, buildPath) => {
      const pack = process.env.ECHOPILOT_MODEL_PACK_DIR ?? repoRoot;
      execFileSync(
        process.execPath,
        [join(repoRoot, 'scripts', 'release', 'verify-pack.mjs'), '--manifest', join(repoRoot, 'models', 'manifest.json'), '--pack', pack],
        { cwd: buildPath, stdio: 'inherit' },
      );
    },
  },
};

export default config;
