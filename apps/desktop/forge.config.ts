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
 *
 * The `@electron-forge/*` packages are release-only tooling: the packaging job installs them, the
 * application and the default developer install do not carry them. They are therefore resolved at
 * configuration-load time through `loadForgePackage` — a runtime import of the package name — while
 * the config keeps its own structural types, so `tsc --noEmit` and the offline install path stay
 * independent of the Forge toolchain and the resolved config keeps the exact same shape.
 */
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(appDirectory, '..', '..');


const appVersion = process.env.ECHOPILOT_VERSION ?? '0.0.0';
const signingIdentity = process.env.ECHOPILOT_SIGN_IDENTITY;

/** Constructor shape shared by the Forge makers this config instantiates. */
type ForgeMaker = new (options: Record<string, unknown>, platforms: readonly string[]) => unknown;

interface PackagerConfig {
  name: string;
  appBundleId: string;
  appVersion: string;
  asar: { unpack: string };
  /** Repository-relative payloads the app must carry so it works with no network. */
  extraResource: string[];
  osxSign: {
    identity: string | undefined;
    hardenedRuntime: boolean;
    gatekeeperAssess: boolean;
    entitlements: string;
    'entitlements-inherit': string;
  };
  osxNotarize: { appleId: string; appleIdPassword: string; teamId: string };
}

interface ForgeConfig {
  packagerConfig: PackagerConfig;
  makers: unknown[];
  plugins: unknown[];
  hooks: { packageAfterCopy: (forgeConfig: unknown, buildPath: string) => Promise<void> };
}

/**
 * Resolve a Forge package that exists only in the packaging job. The specifier is passed as a
 * runtime value so this file typechecks and loads without the Forge dev dependencies installed.
 */
async function loadForgePackage<T>(specifier: string): Promise<T> {
  try {
    return (await import(specifier)) as T;
  } catch (cause) {
    throw new Error(
      `Packaging requires '${specifier}'; install the @electron-forge dev dependencies before running 'electron-forge make'.`,
      { cause },
    );
  }
}

const { MakerDMG } = await loadForgePackage<{ MakerDMG: ForgeMaker }>('@electron-forge/maker-dmg');
const { MakerZIP } = await loadForgePackage<{ MakerZIP: ForgeMaker }>('@electron-forge/maker-zip');
const { VitePlugin } = await loadForgePackage<{ VitePlugin: new (options: Record<string, unknown>) => unknown }>(
  '@electron-forge/plugin-vite',
);

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
      entitlements: join(appDirectory, 'build', 'entitlements.mac.plist'),
      'entitlements-inherit': join(appDirectory, 'build', 'entitlements.mac.plist'),
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
        icon: join(appDirectory, 'build', 'icon.icns'),
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
