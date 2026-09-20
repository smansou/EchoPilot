/**
 * F03 — Mission Control settings display, widget reflection and the keyboard/VoiceOver order
 * (plan §4.3 "Configuration and UI").
 *
 * This module is a projection of the policy rows `packages/core/src/settings/index.ts` resolved. It
 * never re-derives a setting, never applies one early and never grants anything:
 *
 *   - Every effective setting becomes exactly one row, on the page of its family: the value in force
 *     plus the label of the scope that supplied it, and the shadowed values the conflict
 *     explanation needs. A change staged for the next safe boundary is marked `pending: true` while
 *     the row keeps displaying the value in force, so the surface can never show a change the
 *     runtime has not applied.
 *   - The widget mirrors the four runtime settings (persona, verbosity, capture scope, attention)
 *     and quotes the source label of the row it summarizes, so widget and Mission Control can never
 *     disagree about a value or where it came from.
 *   - `navigation` is the deterministic order keyboard traversal and VoiceOver announcement follow:
 *     each page tab followed by that page's primary controls, every control exactly once, every name
 *     non-empty and equal to the control's own accessible name.
 *   - `importReport` is the display half of the core import contract: a rejected key is shown as
 *     rejected and never as a staged, proposed or granted change.
 *
 * Real Electron focus traversal and VoiceOver announcement in a running app are qualified manually;
 * this module owns the order and the names that qualification starts from.
 */
import type {
  EffectiveSetting,
  SettingsImportResult,
  SettingsOverrideScope,
  SettingsScope,
  SettingsShadowedValue,
  SettingsValue,
} from '../../../../../../packages/core/src/settings/index.js';

/** One setting as Mission Control renders it; `value` and `source` are always the value in force. */
export type SettingsControlRow = Readonly<{
  id: string;
  key: string;
  family: string;
  label: string;
  value: SettingsValue;
  source: SettingsScope;
  /** The visible provenance of the value; distinct per scope so the display is unambiguous. */
  sourceLabel: string;
  shadowed: readonly SettingsShadowedValue[];
  /** A change is waiting for the next safe boundary; the displayed value has not changed yet. */
  pending: boolean;
  /** A primary control: keyboard and VoiceOver must reach it. */
  primary: boolean;
  role: SettingsControlRole;
  accessibleName: string;
}>;

/** The control roles the surface uses; all of them are interactive for keyboard and VoiceOver. */
export type SettingsControlRole = 'tab' | 'combobox' | 'switch';

export type SettingsPage = Readonly<{ id: string; title: string; rows: readonly SettingsControlRow[] }>;

export type SettingsWidgetRow = Readonly<{
  key: string;
  label: string;
  value: SettingsValue;
  sourceLabel: string;
}>;

export type SettingsPendingChange = Readonly<{
  scope: SettingsOverrideScope;
  key: string;
  value: SettingsValue;
}>;

export type SettingsNavigationEntry = Readonly<{
  id: string;
  role: SettingsControlRole;
  accessibleName: string;
}>;

export type SettingsSurface = Readonly<{
  pages: readonly SettingsPage[];
  widget: readonly SettingsWidgetRow[];
  pending: readonly SettingsPendingChange[];
  navigation: readonly SettingsNavigationEntry[];
}>;

export type SettingsImportReportRow = Readonly<{
  kind: 'staged' | 'proposal' | 'rejected';
  key: string;
  message: string;
}>;

/** The four runtime settings the floating widget mirrors, in the order it shows them. */
export const RUNTIME_WIDGET_KEYS = [
  'persona.preset',
  'verbosity.level',
  'context.captureScope',
  'attention.preset',
] as const;

/** Curated page titles for the shipped families; an unknown family still gets a readable page. */
const PAGE_TITLES: Readonly<Record<string, string>> = {
  persona: 'Persona',
  voice: 'Voice',
  verbosity: 'Verbosity',
  attention: 'Attention',
  input: 'Input',
  context: 'Context and privacy',
  memory: 'Memory',
  autonomy: 'Autonomy',
  permissions: 'Permissions',
  cost: 'Providers and cost',
  widget: 'Widget',
};

const SOURCE_LABELS: Readonly<Record<SettingsScope, string>> = {
  default: 'Default',
  profile: 'Profile',
  project: 'Project override',
  session: 'This session',
};

function pageTitle(family: string): string {
  const curated = PAGE_TITLES[family];
  if (curated !== undefined) return curated;
  return family
    .split(/[-_]/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || family;
}

/** A declared off/on pair is a switch; every other enumerated setting is a chooser. */
function controlRole(values: readonly SettingsValue[] | undefined): SettingsControlRole {
  const isToggle = values !== undefined && values.length === 2 && values[0] === 'off' && values[1] === 'on';
  return isToggle ? 'switch' : 'combobox';
}

export function projectSettingsSurface(input: Readonly<{
  effective: readonly EffectiveSetting[];
  pending?: readonly SettingsPendingChange[];
}>): SettingsSurface {
  const pending = [...(input.pending ?? [])];
  const pendingKeys = new Set(pending.map((change) => change.key));

  const drafts = input.effective.map((setting) => {
    const sourceLabel = SOURCE_LABELS[setting.source];
    return {
      id: `setting:${setting.key}`,
      key: setting.key,
      family: setting.family,
      label: setting.label,
      value: setting.value,
      source: setting.source,
      sourceLabel,
      shadowed: setting.shadowed.map(({ scope, value }) => ({ scope, value })),
      pending: pendingKeys.has(setting.key),
      primary: true,
      role: controlRole(setting.values),
      accessibleName: `${setting.label}, ${setting.value}, ${sourceLabel}`,
    };
  });

  const byFamily = new Map<string, { title: string; rows: SettingsControlRow[]; announced: Set<string> }>();
  for (const draft of drafts) {
    let family = byFamily.get(draft.family);
    if (family === undefined) {
      family = { title: pageTitle(draft.family), rows: [], announced: new Set<string>() };
      byFamily.set(draft.family, family);
    }
    // Two settings on one page must not announce identically; the key disambiguates a clash.
    const accessibleName = family.announced.has(draft.accessibleName)
      ? `${draft.accessibleName} (${draft.key})`
      : draft.accessibleName;
    family.announced.add(accessibleName);
    family.rows.push({ ...draft, accessibleName });
  }
  const pages: readonly SettingsPage[] = [...byFamily].map(([id, family]) => ({
    id,
    title: family.title,
    rows: family.rows,
  }));

  const widget: SettingsWidgetRow[] = RUNTIME_WIDGET_KEYS.flatMap((key) => {
    const setting = input.effective.find((candidate) => candidate.key === key);
    if (setting === undefined) return [];
    return [{ key, label: setting.label, value: setting.value, sourceLabel: SOURCE_LABELS[setting.source] }];
  });

  const navigation: SettingsNavigationEntry[] = [];
  for (const page of pages) {
    navigation.push({ id: `page:${page.id}`, role: 'tab', accessibleName: page.title });
    for (const row of page.rows) {
      if (row.primary) navigation.push({ id: row.id, role: row.role, accessibleName: row.accessibleName });
    }
  }

  return { pages, widget, pending, navigation };
}

/**
 * The display half of the import contract. A rejected key wins over every other kind, so a refused
 * grant can never be announced as staged or proposed even if the caller's result contradicts itself.
 */
export function importReport(result: SettingsImportResult): readonly SettingsImportReportRow[] {
  const refused = new Set(result.rejected.map((rejection) => rejection.key));
  const report: SettingsImportReportRow[] = [];
  for (const key of result.staged) {
    if (refused.has(key)) continue;
    report.push({ kind: 'staged', key, message: `${key} is staged and applies at the next safe boundary` });
  }
  for (const proposal of result.proposals) {
    if (refused.has(proposal.key)) continue;
    report.push({
      kind: 'proposal',
      key: proposal.key,
      message: `${proposal.key} stays a proposal until it is explicitly confirmed: ${proposal.reason}`,
    });
  }
  for (const rejection of result.rejected) {
    const reason = rejection.reason.trim();
    report.push({ kind: 'rejected', key: rejection.key, message: reason.length > 0 ? reason : `${rejection.key} was refused` });
  }
  return report;
}
