/**
 * F03 — user setting → effective project policy (plan §4.3 "Configuration and UI", §5.3 shared
 * contracts).
 *
 * `createSettingsStore({ schema, layers, storage })` resolves exactly one effective value per schema
 * entry under the `default < profile < project < session` precedence. Every row reports the scope
 * that supplied the value in force plus the lower-precedence values it shadowed — the value, its
 * source and the conflict explanation Mission Control displays.
 *
 * Rules the store keeps:
 *
 *   - The schema is the only door into the policy. `stageChange` refuses a key the schema does not
 *     define and a value its entry does not declare, and a `privileged` setting additionally needs
 *     the explicit `confirmed: true` user action. `importDocument` can only ever *propose* a
 *     privileged setting: an imported document cannot mint the capability grant.
 *   - Staging never changes what is in force. `applyAtSafeBoundary` drains the queue in stage order,
 *     attributes every change to the scope that made it, and writes project overrides through the
 *     `storage` port. Session overrides are runtime state for one session and are deliberately not
 *     persisted, so after a restart that setting resolves back to its lower layer.
 *   - Every document read — the durable restart reload and `importDocument` alike — is versioned and
 *     validated before it can touch the policy. An unknown key, a declined value or an unsupported
 *     version is refused by name and leaves no trace in the effective settings, the pending queue or
 *     the durable document.
 *
 * `apps/desktop/src/renderer/control/settings/settings-surface.ts` projects these rows verbatim; it
 * re-derives nothing.
 */
import type { AttentionPreset } from '../../../attention/src/index.js';
import { NARRATION_VERBOSITIES } from '../../../narration/src/compiler/index.js';

export type SettingsScope = 'default' | 'profile' | 'project' | 'session';
export type SettingsOverrideScope = Exclude<SettingsScope, 'default'>;
export type SettingsValue = string;

export type SettingsSchemaEntry = Readonly<{
  key: string;
  family: string;
  label: string;
  default: SettingsValue;
  /** The enumerations the setting accepts; absent for a free-form value. */
  values?: readonly SettingsValue[];
  /** Needs an explicit capability grant: an import may only propose it, never activate it. */
  privileged?: boolean;
}>;

export type SettingsShadowedValue = Readonly<{ scope: SettingsScope; value: SettingsValue }>;

export type EffectiveSetting = Readonly<{
  key: string;
  family: string;
  label: string;
  value: SettingsValue;
  /** The scope that supplied the value in force. */
  source: SettingsScope;
  /** The overridden values from the next-lower scope down to the schema default. */
  shadowed: readonly SettingsShadowedValue[];
  privileged: boolean;
  values?: readonly SettingsValue[];
}>;

export type SettingsLayer = Readonly<{
  scope: SettingsOverrideScope;
  values: Readonly<Record<string, SettingsValue>>;
}>;

export type SettingsChange = Readonly<{
  scope: SettingsOverrideScope;
  key: string;
  value: SettingsValue;
  /** The explicit user action a privileged setting requires before it can be staged. */
  confirmed?: boolean;
}>;

/** Durable port for project overrides; a synchronous read/write pair keeps restart behavior testable. */
export type SettingsStorage = Readonly<{ read: () => string | null; write: (text: string) => void }>;

export type SettingsProposal = Readonly<{ key: string; value: SettingsValue; reason: string }>;
export type SettingsRejection = Readonly<{ key: string; reason: string }>;

export type SettingsImportResult = Readonly<{
  staged: readonly string[];
  proposals: readonly SettingsProposal[];
  rejected: readonly SettingsRejection[];
}>;

export type SettingsStore = Readonly<{
  effective: () => readonly EffectiveSetting[];
  effectiveFor: (key: string) => EffectiveSetting;
  pending: () => readonly SettingsChange[];
  stageChange: (change: SettingsChange) => void;
  applyAtSafeBoundary: () => readonly EffectiveSetting[];
  exportDocument: () => string;
  importDocument: (text: string, options: Readonly<{ scope: SettingsOverrideScope }>) => SettingsImportResult;
}>;

/** Highest precedence first: the first scope with an explicit value is the one in force. */
const PRECEDENCE: readonly SettingsScope[] = ['session', 'project', 'profile', 'default'];

/** The only durable-document version this store reads or writes. */
const DOCUMENT_VERSION = 1;

/** A whole-document refusal has no setting key, so it is reported under this sentinel. */
const DOCUMENT_KEY = '<document>';

/** R02's preset vocabulary (packages/attention/src/index.ts), in the order the preset list offers it. */
const ATTENTION_PRESETS = [
  'focused-work',
  'hands-free',
  'critical-only',
  'presentation',
] as const satisfies readonly AttentionPreset[];

/** The four cleared Pocket TTS voice presets the asset manifest vendors (models/manifest.json). */
const VOICE_PRESETS = ['alba', 'anna', 'charles', 'jean'] as const;

const SHIPPED_SCHEMA: readonly SettingsSchemaEntry[] = Object.freeze([
  Object.freeze({
    key: 'persona.preset',
    family: 'persona',
    label: 'Persona',
    default: 'balanced-partner',
    values: ['balanced-partner', 'brief', 'soft-natural', 'engineering-direct', 'patient-explainer'],
  }),
  Object.freeze({ key: 'voice.preset', family: 'voice', label: 'Voice', default: 'alba', values: VOICE_PRESETS }),
  Object.freeze({ key: 'voice.systemNarration', family: 'voice', label: 'System narration fallback', default: 'off', values: ['off', 'on'] }),
  Object.freeze({ key: 'voice.systemVoiceURI', family: 'voice', label: 'Installed macOS voice', default: '' }),
  Object.freeze({ key: 'voice.systemRate', family: 'voice', label: 'Speaking speed', default: '1', values: ['0.8', '0.9', '1', '1.1', '1.2', '1.3', '1.4'] }),
  Object.freeze({ key: 'providers.textModel', family: 'providers', label: 'OpenAI model', default: 'gpt-4.1-mini' }),
  Object.freeze({ key: 'providers.active', family: 'providers', label: 'Reasoning provider', default: 'gemini', values: ['openai', 'openrouter', 'gemini', 'anthropic'] }),
  Object.freeze({ key: 'providers.openaiSelectedModel', family: 'providers', label: 'OpenAI assistant model', default: 'gpt-4.1-mini', values: ['gpt-4.1-mini', 'gpt-4.1'] }),
  Object.freeze({ key: 'providers.geminiSelectedModel', family: 'providers', label: 'Gemini assistant model', default: 'gemini-3.5-flash-lite', values: ['gemini-3.5-flash-lite'] }),
  Object.freeze({ key: 'providers.anthropicModel', family: 'providers', label: 'Claude model', default: 'claude-haiku-5-5', values: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'] }),
  Object.freeze({ key: 'providers.geminiModel', family: 'providers', label: 'Gemini reasoning model', default: 'gemini-3.5-flash-lite' }),
  Object.freeze({ key: 'setup.preset', family: 'providers', label: 'Provider setup', default: 'gemini', values: ['gemini', 'openai', 'custom'] }),
  Object.freeze({ key: 'live.provider', family: 'providers', label: 'Live voice provider', default: 'gemini', values: ['openai', 'gemini'] }),
  Object.freeze({ key: 'live.openaiVoice', family: 'voice', label: 'OpenAI voice', default: 'marin', values: ['marin','willow'] }),
  Object.freeze({ key: 'live.geminiVoice', family: 'voice', label: 'Gemini voice', default: 'Kore', values: ['Kore','Puck','Aoede'] }),
  Object.freeze({ key: 'providers.openrouterModel', family: 'providers', label: 'OpenRouter model', default: 'openai/gpt-4.1-mini' }),
  Object.freeze({ key: 'dictation.mode', family: 'dictation', label: 'Dictation', default: 'smart', values: ['smart', 'plain'] }),
  Object.freeze({
    key: 'verbosity.level',
    family: 'verbosity',
    label: 'Verbosity',
    default: 'balanced',
    values: NARRATION_VERBOSITIES,
  }),
  Object.freeze({
    key: 'attention.preset',
    family: 'attention',
    label: 'Attention',
    default: 'focused-work',
    values: ATTENTION_PRESETS,
  }),
  Object.freeze({
    key: 'input.continuousSession',
    family: 'input',
    label: 'Continuous session',
    default: 'off',
    values: ['off', 'on'],
  }),
  Object.freeze({
    key: 'context.captureScope',
    family: 'context',
    label: 'Capture scope',
    default: 'permitted-window',
    values: ['selected-text', 'permitted-window', 'project-windows'],
  }),
  Object.freeze({
    key: 'context.cloudExport',
    family: 'context',
    label: 'Cloud export',
    default: 'off',
    values: ['off', 'project-export'],
    privileged: true,
  }),
  Object.freeze({
    key: 'memory.globalPreferences',
    family: 'memory',
    label: 'Global preferences',
    default: 'on',
    values: ['off', 'on'],
  }),
  Object.freeze({
    key: 'widget.size',
    family: 'widget',
    label: 'Widget size',
    default: 'medium',
    values: ['small', 'medium', 'large'],
  }),
  Object.freeze({
    key: 'widget.reducedMotion',
    family: 'widget',
    label: 'Reduced motion',
    default: 'system',
    values: ['system', 'reduce', 'full'],
  }),
]);

/** The shipped §4.3 settings families, in the order Mission Control lists them. */
export function defaultSettingsSchema(): readonly SettingsSchemaEntry[] {
  return SHIPPED_SCHEMA;
}

type DocumentRead =
  | Readonly<{ ok: true; values: Record<string, unknown> }>
  | Readonly<{ ok: false; reason: string }>;

/** Validate the envelope before any value can reach the policy; the reason always names the document. */
function readDocument(text: string): DocumentRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: `${DOCUMENT_KEY}: the settings document is not valid JSON` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: `${DOCUMENT_KEY}: the settings document must be a JSON object` };
  }
  const document = parsed as Readonly<{ version?: unknown; values?: unknown }>;
  if (document.version !== DOCUMENT_VERSION) {
    return {
      ok: false,
      reason: `${DOCUMENT_KEY}: unsupported settings document version ${String(document.version)}; `
        + `this build reads version ${DOCUMENT_VERSION}`,
    };
  }
  const values = document.values;
  if (typeof values !== 'object' || values === null || Array.isArray(values)) {
    return { ok: false, reason: `${DOCUMENT_KEY}: the settings document carries no values object` };
  }
  return { ok: true, values: values as Record<string, unknown> };
}

export function createSettingsStore(input: Readonly<{
  schema: readonly SettingsSchemaEntry[];
  layers?: readonly SettingsLayer[];
  storage?: SettingsStorage;
}>): SettingsStore {
  const { schema, layers = [], storage } = input;
  const byKey = new Map<string, SettingsSchemaEntry>(schema.map((entry) => [entry.key, entry]));
  const overrides: Record<SettingsScope, Record<string, SettingsValue>> = {
    default: {},
    profile: {},
    project: {},
    session: {},
  };
  const staged: SettingsChange[] = [];

  /** Whether a value may enter the policy under this schema: a known key with a declared value. */
  const admits = (key: string, value: unknown): value is SettingsValue => {
    const entry = byKey.get(key);
    if (entry === undefined || typeof value !== 'string') return false;
    return entry.values === undefined || entry.values.includes(value);
  };

  for (const entry of schema) overrides.default[entry.key] = entry.default;
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer.values)) {
      if (admits(key, value)) overrides[layer.scope][key] = value;
    }
  }

  const durable = storage?.read() ?? null;
  if (durable !== null) {
    const document = readDocument(durable);
    // A stale or hand-edited document loses to the schema instead of injecting a setting; a saved
    // project override wins over a construction-time project layer, which must not silently replace it.
    if (document.ok) {
      for (const [key, value] of Object.entries(document.values)) {
        if (admits(key, value)) overrides.project[key] = value;
      }
    }
  }

  function resolve(entry: SettingsSchemaEntry): EffectiveSetting {
    const source = PRECEDENCE.find(
      (scope) => scope === 'default' || overrides[scope][entry.key] !== undefined,
    ) ?? 'default';
    const shadowed: SettingsShadowedValue[] = [];
    for (const scope of PRECEDENCE.slice(PRECEDENCE.indexOf(source) + 1)) {
      const value = scope === 'default' ? entry.default : overrides[scope][entry.key];
      if (value !== undefined) shadowed.push({ scope, value });
    }
    const value = source === 'default' ? entry.default : overrides[source][entry.key] ?? entry.default;
    return {
      key: entry.key,
      family: entry.family,
      label: entry.label,
      value,
      source,
      shadowed,
      privileged: entry.privileged === true,
      ...(entry.values === undefined ? {} : { values: entry.values }),
    };
  }

  function effective(): readonly EffectiveSetting[] {
    return schema.map((entry) => resolve(entry));
  }

  function effectiveFor(key: string): EffectiveSetting {
    const entry = byKey.get(key);
    if (entry === undefined) throw new Error(`Unknown setting: ${key}`);
    return resolve(entry);
  }

  function persistProjectOverrides(): void {
    storage?.write(exportDocument());
  }

  function exportDocument(): string {
    return JSON.stringify({ version: DOCUMENT_VERSION, values: { ...overrides.project } });
  }

  function importDocument(
    text: string,
    options: Readonly<{ scope: SettingsOverrideScope }>,
  ): SettingsImportResult {
    const stagedKeys: string[] = [];
    const proposals: SettingsProposal[] = [];
    const rejected: SettingsRejection[] = [];
    const document = readDocument(text);
    if (!document.ok) {
      rejected.push({ key: DOCUMENT_KEY, reason: document.reason });
      return { staged: stagedKeys, proposals, rejected };
    }
    for (const [key, value] of Object.entries(document.values)) {
      const entry = byKey.get(key);
      if (entry === undefined) {
        rejected.push({
          key,
          reason: `unknown setting ${key}: an import cannot create a setting the schema does not define`,
        });
        continue;
      }
      if (typeof value !== 'string' || (entry.values !== undefined && !entry.values.includes(value))) {
        rejected.push({ key, reason: `invalid value for ${key}: the schema does not declare ${JSON.stringify(value)}` });
        continue;
      }
      if (entry.privileged === true) {
        proposals.push({ key, value, reason: `${key} needs an explicit capability grant; an import can only propose it` });
        continue;
      }
      stagedKeys.push(key);
      staged.push({ scope: options.scope, key, value });
    }
    return { staged: stagedKeys, proposals, rejected };
  }

  return {
    effective,
    effectiveFor,
    pending: () => staged.map((change) => ({ scope: change.scope, key: change.key, value: change.value })),

    stageChange(change: SettingsChange): void {
      const entry = byKey.get(change.key);
      if (entry === undefined) throw new Error(`Unknown setting: ${change.key}`);
      if (typeof change.value !== 'string' || (entry.values !== undefined && !entry.values.includes(change.value))) {
        throw new Error(`Invalid value for ${change.key}: ${String(change.value)}`);
      }
      if (entry.privileged === true && change.confirmed !== true) {
        throw new Error(`Privileged setting ${change.key} needs an explicit confirmation before it can be staged`);
      }
      staged.push({ scope: change.scope, key: change.key, value: change.value });
    },

    applyAtSafeBoundary(): readonly EffectiveSetting[] {
      let projectTouched = false;
      for (const change of staged) {
        overrides[change.scope][change.key] = change.value;
        if (change.scope === 'project') projectTouched = true;
      }
      staged.length = 0;
      if (projectTouched) persistProjectOverrides();
      return effective();
    },

    exportDocument,
    importDocument,
  };
}
