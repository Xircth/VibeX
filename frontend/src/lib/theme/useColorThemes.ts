import { useSyncExternalStore } from 'react';

import {
  getColorThemeSnapshot,
  subscribeColorThemes,
  type ColorThemeSnapshot,
} from './colorThemeStore';

export function useColorThemes(): ColorThemeSnapshot {
  return useSyncExternalStore(
    subscribeColorThemes,
    getColorThemeSnapshot,
    getColorThemeSnapshot
  );
}
