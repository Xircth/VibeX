import {
  parseThemeDefinition,
  type ThemeContribution,
  type ThemeDefinition,
  type ThemeIssue,
  type ThemeScheme,
} from '@vibex/plugin-sdk';
import type { JsonValue } from 'shared/types';

import { persistFrontendPreference } from '@/lib/frontendPreferences';
import { readLocalStorage, writeLocalStorage } from '@/lib/safeStorage';

import { BUILTIN_THEMES } from './builtinThemes';
import { buildColorThemeStylesheet } from './compileTheme';

/**
 * Single-select color themes, one for light and one for dark. Built-in, user,
 * and plugin themes are peers keyed by source; the user picks each scheme's
 * theme explicitly and a missing pick falls back to the built-in palette.
 */

export type ColorThemeSource = 'builtin' | 'user' | 'plugin';

export interface ColorThemeEntry {
  readonly key: string;
  readonly source: ColorThemeSource;
  readonly pluginId?: string;
  readonly theme: ThemeDefinition;
}

export interface ColorThemeSnapshot {
  readonly themes: readonly ColorThemeEntry[];
  readonly selected: Readonly<Record<ThemeScheme, string>>;
  readonly active: Readonly<Record<ThemeScheme, ColorThemeEntry>>;
  readonly preview: ThemeDefinition | null;
}

export const COLOR_THEME_KEYS = {
  light: 'vibex:color-theme-light',
  dark: 'vibex:color-theme-dark',
} as const;
export const USER_COLOR_THEMES_KEY = 'vibex:user-color-themes';
export const COLOR_THEME_CHANGED_EVENT = 'vibex:color-theme-changed';
const ACTIVE_CACHE_KEY = 'vibex:color-theme-active';
const STYLE_ATTRIBUTE = 'data-vibex-color-theme';
const SCHEMES = ['light', 'dark'] as const;

export const builtinThemeKey = (scheme: ThemeScheme) => `builtin:${scheme}`;
export const userThemeKey = (id: string) => `user:${id}`;
export const pluginThemeKey = (pluginId: string, id: string) =>
  `plugin:${pluginId}/${id}`;

const BUILTIN_ENTRIES: Readonly<Record<ThemeScheme, ColorThemeEntry>> = {
  light: {
    key: builtinThemeKey('light'),
    source: 'builtin',
    theme: BUILTIN_THEMES.light,
  },
  dark: {
    key: builtinThemeKey('dark'),
    source: 'builtin',
    theme: BUILTIN_THEMES.dark,
  },
};

let pluginEntries: readonly ColorThemeEntry[] = [];
let activePluginIds: ReadonlySet<string> | null = null;
let preview: ThemeDefinition | null = null;
let snapshot: ColorThemeSnapshot | null = null;
const listeners = new Set<() => void>();

function readJson(key: string): unknown {
  const raw = readLocalStorage(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function readUserThemes(): ThemeDefinition[] {
  const stored = readJson(USER_COLOR_THEMES_KEY);
  if (!Array.isArray(stored)) return [];
  const themes: ThemeDefinition[] = [];
  for (const value of stored) {
    const parsed = parseThemeDefinition(value);
    if (parsed.theme) themes.push(parsed.theme);
  }
  return themes;
}

function writeUserThemes(themes: readonly ThemeDefinition[]): void {
  const raw = JSON.stringify(themes);
  writeLocalStorage(USER_COLOR_THEMES_KEY, raw);
  persistFrontendPreference(
    USER_COLOR_THEMES_KEY,
    JSON.parse(raw) as JsonValue
  );
}

function readSelection(scheme: ThemeScheme): string {
  return readLocalStorage(COLOR_THEME_KEYS[scheme]) || builtinThemeKey(scheme);
}

/** Last applied plugin themes, so a restart paints them before the plugin
 * runtime has registered again. */
function readActiveCache(): Partial<Record<ThemeScheme, ColorThemeEntry>> {
  const stored = readJson(ACTIVE_CACHE_KEY);
  if (!stored || typeof stored !== 'object') return {};
  const cache: Partial<Record<ThemeScheme, ColorThemeEntry>> = {};
  for (const scheme of SCHEMES) {
    const entry = (stored as Record<string, unknown>)[scheme] as
      | Partial<ColorThemeEntry>
      | undefined;
    const parsed = parseThemeDefinition(entry?.theme);
    if (
      parsed.theme &&
      parsed.theme.scheme === scheme &&
      typeof entry?.key === 'string' &&
      typeof entry.pluginId === 'string'
    ) {
      cache[scheme] = {
        key: entry.key,
        source: 'plugin',
        pluginId: entry.pluginId,
        theme: parsed.theme,
      };
    }
  }
  return cache;
}

function listThemes(): ColorThemeEntry[] {
  const user = readUserThemes().map<ColorThemeEntry>((theme) => ({
    key: userThemeKey(theme.id),
    source: 'user',
    theme,
  }));
  return [
    BUILTIN_ENTRIES.light,
    BUILTIN_ENTRIES.dark,
    ...user,
    ...pluginEntries,
  ];
}

function resolveActive(
  scheme: ThemeScheme,
  key: string,
  themes: readonly ColorThemeEntry[],
  cache: Partial<Record<ThemeScheme, ColorThemeEntry>>
): ColorThemeEntry {
  const match = themes.find(
    (entry) => entry.key === key && entry.theme.scheme === scheme
  );
  if (match) return match;
  const cached = cache[scheme];
  if (cached?.key === key && cached.pluginId) {
    const pluginId = cached.pluginId;
    const pluginActive = activePluginIds?.has(pluginId) ?? true;
    const pluginRegistered = pluginEntries.some(
      (entry) => entry.pluginId === pluginId
    );
    if (pluginActive && !pluginRegistered) return cached;
  }
  return BUILTIN_ENTRIES[scheme];
}

function buildSnapshot(): ColorThemeSnapshot {
  const themes = listThemes();
  const cache = readActiveCache();
  const selected = {
    light: readSelection('light'),
    dark: readSelection('dark'),
  };
  return {
    themes,
    selected,
    active: {
      light: resolveActive('light', selected.light, themes, cache),
      dark: resolveActive('dark', selected.dark, themes, cache),
    },
    preview,
  };
}

function applySnapshot(current: ColorThemeSnapshot): void {
  if (typeof document === 'undefined') return;
  const themes: Partial<Record<ThemeScheme, ThemeDefinition>> = {};
  for (const scheme of SCHEMES) {
    const entry = current.active[scheme];
    if (current.preview?.scheme === scheme) themes[scheme] = current.preview;
    else if (entry.source !== 'builtin') themes[scheme] = entry.theme;
  }
  const css = buildColorThemeStylesheet(themes);
  let style = document.head.querySelector<HTMLStyleElement>(
    `style[${STYLE_ATTRIBUTE}]`
  );
  if (!css) {
    style?.remove();
  } else {
    if (!style) {
      style = document.createElement('style');
      style.setAttribute(STYLE_ATTRIBUTE, '');
      document.head.appendChild(style);
    }
    if (style.textContent !== css) style.textContent = css;
  }
  const cache: Partial<Record<ThemeScheme, ColorThemeEntry>> = {};
  for (const scheme of SCHEMES) {
    if (current.active[scheme].source === 'plugin') {
      cache[scheme] = current.active[scheme];
    }
  }
  writeLocalStorage(ACTIVE_CACHE_KEY, JSON.stringify(cache));
}

function refresh(): void {
  snapshot = buildSnapshot();
  applySnapshot(snapshot);
  for (const listener of listeners) listener();
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(COLOR_THEME_CHANGED_EVENT));
  }
}

export function getColorThemeSnapshot(): ColorThemeSnapshot {
  snapshot ??= buildSnapshot();
  return snapshot;
}

export function subscribeColorThemes(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The palette painting `scheme` right now, preview included. */
export function getActiveColorTheme(scheme: ThemeScheme): ThemeDefinition {
  const current = getColorThemeSnapshot();
  if (current.preview?.scheme === scheme) return current.preview;
  return current.active[scheme].theme;
}

export function selectColorTheme(scheme: ThemeScheme, key: string): void {
  writeLocalStorage(COLOR_THEME_KEYS[scheme], key);
  persistFrontendPreference(COLOR_THEME_KEYS[scheme], key);
  refresh();
}

/** Saves (or replaces by id) a user theme; returns its selection key. */
export function saveUserColorTheme(theme: ThemeDefinition): string {
  const parsed = parseThemeDefinition(theme);
  if (!parsed.theme) {
    throw new TypeError(
      parsed.issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')
    );
  }
  const saved = parsed.theme;
  const themes = readUserThemes().filter((entry) => entry.id !== saved.id);
  writeUserThemes([...themes, saved]);
  refresh();
  return userThemeKey(saved.id);
}

export function deleteUserColorTheme(id: string): void {
  writeUserThemes(readUserThemes().filter((theme) => theme.id !== id));
  for (const scheme of SCHEMES) {
    if (readSelection(scheme) === userThemeKey(id)) {
      writeLocalStorage(COLOR_THEME_KEYS[scheme], builtinThemeKey(scheme));
      persistFrontendPreference(
        COLOR_THEME_KEYS[scheme],
        builtinThemeKey(scheme)
      );
    }
  }
  refresh();
}

/** An id no saved user theme uses yet, derived from `base`. */
export function uniqueUserThemeId(base: string): string {
  const taken = new Set(readUserThemes().map((theme) => theme.id));
  const stem =
    base
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 56) || 'theme';
  if (!taken.has(stem)) return stem;
  for (let index = 2; ; index += 1) {
    const candidate = `${stem}-${index}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Paints `theme` on its scheme without saving; `null` ends the preview. */
export function previewColorTheme(theme: ThemeDefinition | null): void {
  preview = theme;
  refresh();
}

/** Host sync: `pluginIds` is the active plugin set, or null while the plugin
 * catalog is still loading. */
export function setPluginColorThemes(
  contributions: readonly ThemeContribution[],
  pluginIds: ReadonlySet<string> | null
): void {
  pluginEntries = contributions.flatMap<ColorThemeEntry>((contribution) => {
    if (!contribution.pluginId) return [];
    const { id, label, scheme, colors } = contribution;
    return [
      {
        key: pluginThemeKey(contribution.pluginId, id),
        source: 'plugin',
        pluginId: contribution.pluginId,
        theme: { id, label, scheme, colors },
      },
    ];
  });
  activePluginIds = pluginIds;
  refresh();
}

export function exportColorTheme(theme: ThemeDefinition): string {
  const { id, label, scheme, colors } = theme;
  return `${JSON.stringify({ id, label, scheme, colors }, null, 2)}\n`;
}

/** Reads one theme or a list of themes in the plugin `themes[]` format. */
export function parseColorThemeFile(
  text: string
):
  | { readonly themes: readonly ThemeDefinition[]; readonly issues?: undefined }
  | { readonly themes?: undefined; readonly issues: readonly ThemeIssue[] } {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return { issues: [{ path: 'file', message: 'is not valid JSON' }] };
  }
  const entries = Array.isArray(value) ? value : [value];
  const themes: ThemeDefinition[] = [];
  const issues: ThemeIssue[] = [];
  entries.forEach((entry, index) => {
    const parsed = parseThemeDefinition(entry);
    if (parsed.theme) themes.push(parsed.theme);
    else {
      for (const issue of parsed.issues) {
        issues.push({
          path: Array.isArray(value)
            ? issue.path.replace(/^theme/, `themes[${index}]`)
            : issue.path,
          message: issue.message,
        });
      }
    }
  });
  if (issues.length > 0 || themes.length === 0) {
    return {
      issues: issues.length
        ? issues
        : [{ path: 'file', message: 'contains no theme' }],
    };
  }
  return { themes };
}

let storageListenerInstalled = false;

export function initColorThemes(): void {
  refresh();
  if (storageListenerInstalled || typeof window === 'undefined') return;
  storageListenerInstalled = true;
  const keys = new Set<string>([
    COLOR_THEME_KEYS.light,
    COLOR_THEME_KEYS.dark,
    USER_COLOR_THEMES_KEY,
  ]);
  window.addEventListener('storage', (event) => {
    if (event.key === null || keys.has(event.key)) refresh();
  });
}
