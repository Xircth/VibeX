import { getCurrentWindow } from '@tauri-apps/api/window';

import { desktopApi } from '@/lib/api/misc';
import { persistFrontendPreference } from '@/lib/frontendPreferences';
import { readLocalStorage, writeLocalStorage } from '@/lib/safeStorage';

const MAIN_WINDOW_CLOSE_BEHAVIOR_KEY = 'vibex.mainWindowCloseBehavior';

export type MainWindowCloseBehavior = 'exit' | 'minimize';

export function getSavedMainWindowCloseBehavior(): MainWindowCloseBehavior | null {
  const value = readLocalStorage(MAIN_WINDOW_CLOSE_BEHAVIOR_KEY);
  return value === 'exit' || value === 'minimize' ? value : null;
}

export function saveMainWindowCloseBehavior(behavior: MainWindowCloseBehavior) {
  writeLocalStorage(MAIN_WINDOW_CLOSE_BEHAVIOR_KEY, behavior);
  persistFrontendPreference(MAIN_WINDOW_CLOSE_BEHAVIOR_KEY, behavior);
}

export async function performMainWindowCloseBehavior(
  behavior: MainWindowCloseBehavior
) {
  if (behavior === 'exit') {
    await desktopApi.exitApp();
    return;
  }
  await getCurrentWindow().minimize();
}
