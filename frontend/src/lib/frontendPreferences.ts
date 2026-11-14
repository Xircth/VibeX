import type { JsonValue } from 'shared/types';

import { frontendPreferencesApi } from '@/lib/api/config';
import { configuredBackendTransport } from '@/lib/backendTransport';

export const SETTINGS_CHANGED_EVENT = 'vibex://settings-file-changed';

const STORAGE_KEYS = {
  'vibex:ui-zoom': 'ui_zoom',
  'vibex:accent-color': 'accent_color',
  'vibex:color-theme-light': 'color_theme_light',
  'vibex:color-theme-dark': 'color_theme_dark',
  'vibex:user-color-themes': 'user_color_themes',
  'vibex:mono-font': 'mono_font',
  'vibex:ui-language': 'language',
  'vibex:app-icon-style': 'app_icon_style',
  'vibex:layout-arrangement': 'workspace_layout',
  'vibex:kanban-layout-arrangement': 'kanban_layout',
  'vibex:collaboration-layout-arrangement': 'collaboration_layout',
  'vibex:kanban-session-list-view': 'kanban_session_list_view',
  'vibex:session-list-appearance': 'session_list_appearance',
  'vibex:kanban-board-style': 'kanban_board_style',
  'vibex:workspace-stage-style': 'workspace_stage_style',
  'vibex:canvas-dock-position': 'canvas_dock_position',
  'vibex:canvas-viewport-position': 'canvas_viewport_position',
  'vibex:kanban-canvas-list-visible': 'kanban_canvas_list_visible',
  'vibex:kanban-canvas': 'kanban_canvas',
  'vibex:activity-rail-order': 'activity_rail_order',
  'editor-settings': 'editor_settings',
  'vibex:key-overrides': 'key_overrides',
  'vibex.skills.grouping': 'skills_grouping',
  'vibex.skills.hostMode': 'skills_host_mode',
  'vibex:operation-diagnostics': 'operation_diagnostics_enabled',
  'vibex:auto-open-created-previews': 'auto_open_created_previews',
  'vibex:settings-nav-float': 'settings_nav_float',
  'vibex:hide-bot-sessions': 'hide_bot_sessions',
  'vibex:hide-default-workspace': 'hide_default_workspace',
  'vibex:hide-inactive-7d-sessions': 'hide_inactive_7d_sessions',
  'vibex:basic-guide': 'basic_guide',
} as const;

type StorageKey = keyof typeof STORAGE_KEYS;

function decodeStoredValue(raw: string): JsonValue {
  try {
    return JSON.parse(raw) as JsonValue;
  } catch {
    return raw;
  }
}

function encodeStoredValue(value: JsonValue): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function normalizePreferenceValue(
  preferenceKey: string,
  value: JsonValue
): JsonValue {
  if (preferenceKey === 'kanban_board_style' && value === 'fixed') {
    return 'canvas';
  }
  if (
    preferenceKey === 'activity_rail_order' &&
    Array.isArray(value) &&
    value.every((item) => typeof item === 'string') &&
    (value.join('|') === 'file-tree|git|search|session-list|bots' ||
      value.join('|') === 'file-tree|git|search|session-list')
  ) {
    return ['session-list', 'bots', 'file-tree', 'git', 'search'];
  }
  return value;
}

function collectLocalPreferences(): Record<string, JsonValue> {
  const preferences: Record<string, JsonValue> = {};
  for (const [storageKey, preferenceKey] of Object.entries(STORAGE_KEYS)) {
    const raw = localStorage.getItem(storageKey);
    if (raw !== null) {
      preferences[preferenceKey] = normalizePreferenceValue(
        preferenceKey,
        decodeStoredValue(raw)
      );
    }
  }
  return preferences;
}

const SELF_TRIGGERED_SETTINGS_SUPPRESSION_MS = 1_000;
let inFlightPreferenceWrites = 0;
let lastLocalPreferenceWriteAt = 0;

export function isSelfTriggeredSettingsChange(now = Date.now()): boolean {
  return (
    inFlightPreferenceWrites > 0 ||
    (lastLocalPreferenceWriteAt > 0 &&
      now - lastLocalPreferenceWriteAt < SELF_TRIGGERED_SETTINGS_SUPPRESSION_MS)
  );
}

export function resetSelfTriggeredSettingsStateForTests(): void {
  inFlightPreferenceWrites = 0;
  lastLocalPreferenceWriteAt = 0;
}

function applyPreferences(preferences: Record<string, JsonValue>): boolean {
  let changed = false;
  for (const [storageKey, preferenceKey] of Object.entries(STORAGE_KEYS)) {
    if (!(preferenceKey in preferences)) continue;
    const normalized = normalizePreferenceValue(
      preferenceKey,
      preferences[preferenceKey]
    );
    const raw = encodeStoredValue(normalized);
    if (localStorage.getItem(storageKey) === raw) continue;
    changed = true;
    localStorage.setItem(storageKey, raw);
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: storageKey,
        newValue: raw,
      })
    );
  }
  return changed;
}

export async function syncFrontendPreferences(
  api: Pick<
    typeof frontendPreferencesApi,
    'get' | 'update'
  > = frontendPreferencesApi
): Promise<boolean> {
  if (configuredBackendTransport.environment === 'web') return false;
  const remote = await api.get();
  const local = collectLocalPreferences();
  const updates: Record<string, JsonValue> = Object.fromEntries(
    Object.entries(local).filter(([key]) => !(key in remote))
  );
  if (remote.kanban_board_style === 'fixed') {
    updates.kanban_board_style = 'canvas';
  }
  let effective = remote;
  if (Object.keys(updates).length > 0) {
    inFlightPreferenceWrites += 1;
    lastLocalPreferenceWriteAt = Date.now();
    try {
      effective = await api.update(updates);
    } finally {
      inFlightPreferenceWrites = Math.max(0, inFlightPreferenceWrites - 1);
      lastLocalPreferenceWriteAt = Date.now();
    }
  }
  return applyPreferences(effective);
}

const NON_PORTABLE_PREFERENCE_KEYS = new Set<string>([
  'kanban_canvas',
  'basic_guide',
]);

export function isPortablePreferenceKey(preferenceKey: string): boolean {
  return (
    !preferenceKey.startsWith('__') &&
    !NON_PORTABLE_PREFERENCE_KEYS.has(preferenceKey)
  );
}

export async function collectPortableFrontendPreferences(
  api: Pick<typeof frontendPreferencesApi, 'get'> = frontendPreferencesApi
): Promise<Record<string, JsonValue>> {
  const local = collectLocalPreferences();
  let remote: Record<string, JsonValue> = {};
  if (configuredBackendTransport.environment !== 'web') {
    try {
      remote = await api.get();
    } catch {
      remote = {};
    }
  }
  const merged: Record<string, JsonValue> = { ...remote, ...local };
  return Object.fromEntries(
    Object.entries(merged).filter(([key, value]) => {
      return value !== undefined && isPortablePreferenceKey(key);
    })
  );
}

export async function applyImportedFrontendPreferences(
  preferences: Record<string, JsonValue>,
  api: Pick<typeof frontendPreferencesApi, 'update'> = frontendPreferencesApi
): Promise<boolean> {
  const allowedKeys = new Set<string>(Object.values(STORAGE_KEYS));
  const sanitized: Record<string, JsonValue> = Object.fromEntries(
    Object.entries(preferences).filter(
      ([key, value]) =>
        value !== undefined &&
        allowedKeys.has(key) &&
        isPortablePreferenceKey(key)
    )
  );
  if (Object.keys(sanitized).length === 0) {
    return false;
  }

  inFlightPreferenceWrites += 1;
  lastLocalPreferenceWriteAt = Date.now();
  try {
    await api.update(sanitized);
  } catch {
    // Web or test transports without persistent JSON backing still apply to localStorage below.
  } finally {
    inFlightPreferenceWrites = Math.max(0, inFlightPreferenceWrites - 1);
    lastLocalPreferenceWriteAt = Date.now();
  }

  return applyPreferences(sanitized);
}

export async function readDesktopSharedPreferenceSection<T>(
  sectionKey: string
): Promise<T | null> {
  const { isTauriDesktopShell } = await import('@/utils/platform');
  if (!isTauriDesktopShell()) return null;
  try {
    const { tauriBackendTransport } = await import('@/lib/transport');
    const all = (await tauriBackendTransport.call(
      'get_frontend_preferences'
    )) as Record<string, unknown> | null;
    if (!all || typeof all !== 'object' || !(sectionKey in all)) {
      return null;
    }
    return (all[sectionKey] as T) ?? null;
  } catch {
    return null;
  }
}

export async function writeDesktopSharedPreferenceSection(
  sectionKey: string,
  value: JsonValue
): Promise<boolean> {
  const { isTauriDesktopShell } = await import('@/utils/platform');
  if (!isTauriDesktopShell()) return false;
  inFlightPreferenceWrites += 1;
  lastLocalPreferenceWriteAt = Date.now();
  try {
    const { tauriBackendTransport } = await import('@/lib/transport');
    await tauriBackendTransport.call('update_frontend_preferences', {
      preferences: { [sectionKey]: value },
    });
    return true;
  } catch {
    return false;
  } finally {
    inFlightPreferenceWrites = Math.max(0, inFlightPreferenceWrites - 1);
    lastLocalPreferenceWriteAt = Date.now();
  }
}

export function persistFrontendPreference(
  storageKey: StorageKey,
  value: JsonValue
): void {
  if (configuredBackendTransport.environment === 'web') return;
  const preferenceKey = STORAGE_KEYS[storageKey];
  inFlightPreferenceWrites += 1;
  lastLocalPreferenceWriteAt = Date.now();
  void frontendPreferencesApi
    .update({ [preferenceKey]: value })
    .catch((error) =>
      console.error('Failed to save frontend preference', error)
    )
    .finally(() => {
      inFlightPreferenceWrites = Math.max(0, inFlightPreferenceWrites - 1);
      lastLocalPreferenceWriteAt = Date.now();
    });
}
