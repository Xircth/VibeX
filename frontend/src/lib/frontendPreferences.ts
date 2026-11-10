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
  'vibex:collaboration-layout-arrangement': 'collaboration_layout',
  'vibex:kanban-session-list-view': 'kanban_session_list_view',
  'vibex:kanban-board-style': 'kanban_board_style',
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

