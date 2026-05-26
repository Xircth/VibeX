import { getCurrentWindow } from '@tauri-apps/api/window';

import { desktopApi } from '@/lib/api/misc';

const MAIN_WINDOW_CLOSE_BEHAVIOR_KEY = 'vibex.mainWindowCloseBehavior';

export type MainWindowCloseBehavior = 'exit' | 'minimize';

export function getSavedMainWindowCloseBehavior(): MainWindowCloseBehavior | null {
  const value = window.localStorage.getItem(MAIN_WINDOW_CLOSE_BEHAVIOR_KEY);
  return value === 'exit' || value === 'minimize' ? value : null;
}

export function saveMainWindowCloseBehavior(
  behavior: MainWindowCloseBehavior
) {
  window.localStorage.setItem(MAIN_WINDOW_CLOSE_BEHAVIOR_KEY, behavior);
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
