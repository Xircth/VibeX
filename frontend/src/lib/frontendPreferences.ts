import type { JsonValue } from 'shared/types';

import { frontendPreferencesApi } from '@/lib/api/config';
import { configuredBackendTransport } from '@/lib/backendTransport';

export const SETTINGS_CHANGED_EVENT = 'vibex://settings-file-changed';

const STORAGE_KEYS = {
  'vibex:ui-zoom': 'ui_zoom',
  'vibex:accent-color': 'accent_color',
  'vibex:mono-font': 'mono_font',
  'vibex:ui-language': 'language',
  'vibex:app-icon-style': 'app_icon_style',
  'vibex:layout-arrangement': 'workspace_layout',
  'vibex:kanban-layout-arrangement': 'kanban_layout',
  'vibex:kanban-session-list-view': 'kanban_session_list_view',
  'vibex:kanban-board-style': 'kanban_board_style',
  'vibex:kanban-canvas-list-visible': 'kanban_canvas_list_visible',
  'vibex:activity-rail-order': 'activity_rail_order',
  'editor-settings': 'editor_settings',
  'vibex:key-overrides': 'key_overrides',
  'vibex.skills.grouping': 'skills_grouping',
  'vibex.skills.hostMode': 'skills_host_mode',
  'vibex:operation-diagnostics': 'operation_diagnostics_enabled',
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

function collectLocalPreferences(): Record<string, JsonValue> {
  const preferences: Record<string, JsonValue> = {};
  for (const [storageKey, preferenceKey] of Object.entries(STORAGE_KEYS)) {
    const raw = localStorage.getItem(storageKey);
    if (raw !== null) preferences[preferenceKey] = decodeStoredValue(raw);
  }
  return preferences;
}

function applyPreferences(preferences: Record<string, JsonValue>): void {
  for (const [storageKey, preferenceKey] of Object.entries(STORAGE_KEYS)) {
    if (!(preferenceKey in preferences)) continue;
    const raw = encodeStoredValue(preferences[preferenceKey]);
    localStorage.setItem(storageKey, raw);
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: storageKey,
        newValue: raw,
      })
    );
  }
}

export async function syncFrontendPreferences(
  api: Pick<
    typeof frontendPreferencesApi,
    'get' | 'update'
  > = frontendPreferencesApi
): Promise<void> {
  if (configuredBackendTransport.environment === 'web') return;
  const remote = await api.get();
  const local = collectLocalPreferences();
  const missing = Object.fromEntries(
    Object.entries(local).filter(([key]) => !(key in remote))
  );
  const effective =
    Object.keys(missing).length > 0 ? await api.update(missing) : remote;
  applyPreferences(effective);
}

export function persistFrontendPreference(
  storageKey: StorageKey,
  value: JsonValue
): void {
  if (configuredBackendTransport.environment === 'web') return;
  const preferenceKey = STORAGE_KEYS[storageKey];
  void frontendPreferencesApi
    .update({ [preferenceKey]: value })
    .catch((error) =>
      console.error('Failed to save frontend preference', error)
    );
}
