import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  createSettingsStore,
  defaultSettingsSchema,
  type SettingsImportResult,
  type SettingsStore,
} from '../../../../packages/core/src/settings/index';

type ProfileDocument = { version: 1; values: Record<string, string> };

export type ProductRuntime = Readonly<{
  settings(): ReturnType<SettingsStore['effective']>;
  setSetting(key: string, value: string): ReturnType<SettingsStore['effective']>;
  resetFamily(family: string): ReturnType<SettingsStore['effective']>;
  exportSettings(): string;
  importSettings(text: string): SettingsImportResult;
  diagnostics(): Readonly<{
    assets: readonly Readonly<{ id: string; ready: boolean; description: string; required: boolean }>[];
    settingsError: string | null;
    releaseIssues: readonly string[];
  }>;
}>;

/** The profile store only persists values admitted by the shipped schema. */
export function createProductRuntime(userData: string, appRoot: string): ProductRuntime {
  const path = join(userData, 'settings', 'profile.json');
  const schema = defaultSettingsSchema();
  const admissible = new Map(schema.map((entry) => [entry.key, entry]));
  let profile: Record<string, string> = {};
  let settingsError: string | null = null;
  try {
    const document: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof document !== 'object' || document === null || Array.isArray(document)
      || (document as ProfileDocument).version !== 1
      || typeof (document as ProfileDocument).values !== 'object'
      || (document as ProfileDocument).values === null
      || Array.isArray((document as ProfileDocument).values)) {
      throw new Error('Profile settings have an unsupported format.');
    }
    for (const [key, value] of Object.entries((document as ProfileDocument).values)) {
      const entry = admissible.get(key);
      if (entry && typeof value === 'string' && (!entry.values || entry.values.includes(value)) && !entry.privileged) {
        profile[key] = value;
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      settingsError = error instanceof Error ? error.message : 'Profile settings could not be read.';
    }
  }

  const makeStore = (): SettingsStore => createSettingsStore({
    schema,
    layers: [{ scope: 'profile', values: profile }],
  });
  let store = makeStore();

  function save(): void {
    mkdirSync(join(userData, 'settings'), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, values: profile }) + '\n', { mode: 0o600 });
    renameSync(temporary, path);
    settingsError = null;
  }

  function commit(): ReturnType<SettingsStore['effective']> {
    const effective = store.applyAtSafeBoundary();
    profile = Object.fromEntries(effective
      .filter((entry) => entry.source === 'profile' && !entry.privileged)
      .map((entry) => [entry.key, entry.value]));
    save();
    return effective;
  }

  return {
    settings: () => store.effective(),
    setSetting(key, value) {
      const entry = admissible.get(key);
      if (!entry) throw new TypeError(`Unknown setting: ${key}`);
      if (entry.privileged) throw new TypeError(`${entry.label} requires a separate permission grant.`);
      store.stageChange({ scope: 'profile', key, value });
      return commit();
    },
    resetFamily(family) {
      if (!schema.some((entry) => entry.family === family)) throw new TypeError(`Unknown setting section: ${family}`);
      profile = Object.fromEntries(Object.entries(profile).filter(([key]) => admissible.get(key)?.family !== family));
      store = makeStore();
      save();
      return store.effective();
    },
    exportSettings() {
      return JSON.stringify({ version: 1, values: profile }, null, 2);
    },
    importSettings(text) {
      if (text.length > 100_000) throw new TypeError('Settings import is too large.');
      const result = store.importDocument(text, { scope: 'profile' });
      if (result.staged.length > 0) commit();
      return result;
    },
    diagnostics() {
      const assets = [
        { id: 'native-helper', description: 'Native platform helper', paths: ['dist/native/PlatformHost'] },
        { id: 'secrets-helper', description: 'Keychain and capture helper', paths: ['dist/native/echopilot-secrets', 'dist/native/macos/.build/release/echopilot-secrets', 'dist/native/macos/.build/debug/echopilot-secrets', 'native/macos/.build/release/echopilot-secrets', 'native/macos/.build/debug/echopilot-secrets'] },
        { id: 'voice-worker', description: 'Local voice worker', paths: ['dist/native/EchoPilotVoice.app/Contents/MacOS/echopilot-voice', 'dist/native/echopilot-voice', 'native/macos/.build/debug/echopilot-voice'] },
        { id: 'reasoner-worker', description: 'Local reasoning worker', paths: ['dist/native/echopilot-reasoner', 'native/macos/.build/debug/echopilot-reasoner'] },
        { id: 'desktop-helper', description: 'Desktop accessibility helper', paths: ['dist/native/echopilot-desktop', 'native/macos/Sources/Accessibility/.build/debug/echopilot-desktop'] },
        { id: 'execution-helper', description: 'Process observation helper', paths: ['dist/native/echopilot-exec-observation', 'native/macos/Sources/Execution/.build/debug/echopilot-exec-observation'] },
        { id: 'asr', description: 'Whisper speech recognition', paths: ['models/asr/small.en'] },
        { id: 'vad', description: 'Silero voice activity model', paths: ['models/asr/silero_vad.mlmodelc', 'models/asr/silero_vad.mlmodel', 'models/vad/silero_vad.mlmodelc'] },
        { id: 'reasoner', description: 'Local reasoning model', paths: ['models/reasoner/qwen3.5-4b-q4'] },
        { id: 'speech', description: 'Pocket TTS voice model', paths: ['models/pocket-tts/english_2026-04'] },
        { id: 'speech-runtime', description: 'Bundled speech runtime', paths: ['workers/pocket-tts/python/bin/python3'] },
      ].map(({ id, description, paths }) => ({ id, description,
        required: !['reasoner-worker', 'reasoner', 'speech', 'speech-runtime'].includes(id),
        ready: paths.some((relative) => existsSync(resolve(appRoot, relative))) }));
      const releaseIssues: string[] = [];
      try {
        const policy = JSON.parse(readFileSync(resolve(appRoot, 'scripts/release/installers.json'), 'utf8')) as {
          distribution?: { teamIdentifier?: string; signingIdentity?: string };
        };
        if (!policy.distribution?.teamIdentifier || policy.distribution.teamIdentifier === 'TEAMID') {
          releaseIssues.push('Apple Developer signing identity has not been provisioned.');
        }
      } catch { releaseIssues.push('Release signing policy could not be read.'); }
      try {
        const packageFile = JSON.parse(readFileSync(resolve(appRoot, 'package.json'), 'utf8')) as { scripts?: { package?: string } };
        if (!packageFile.scripts?.package) releaseIssues.push('No reproducible packaging command is defined.');
      } catch { releaseIssues.push('Packaging configuration could not be read.'); }
      if (assets.some((asset) => !asset.ready && ['asr', 'vad', 'reasoner', 'speech', 'speech-runtime'].includes(asset.id))) {
        releaseIssues.push('The verified offline model pack is incomplete.');
      }
      return { assets, settingsError, releaseIssues };
    },
  };
}
