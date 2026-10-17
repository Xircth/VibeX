import type { JsonValue } from 'shared/types';

import { persistFrontendPreference } from '@/lib/frontendPreferences';

import {
  BASIC_GUIDE_CHANGED_EVENT,
  BASIC_GUIDE_STORAGE_KEY,
  type PersistedBasicGuide,
  parsePersistedBasicGuide,
} from './basicGuideState';

export function readBasicGuide(): PersistedBasicGuide | null {
  if (typeof window === 'undefined') return null;
  return parsePersistedBasicGuide(
    window.localStorage.getItem(BASIC_GUIDE_STORAGE_KEY)
  );
}

export function writeBasicGuide(state: PersistedBasicGuide): void {
  if (typeof window === 'undefined') return;
  const raw = JSON.stringify(state);
  window.localStorage.setItem(BASIC_GUIDE_STORAGE_KEY, raw);
  persistFrontendPreference(
    BASIC_GUIDE_STORAGE_KEY,
    state as unknown as JsonValue
  );
  window.dispatchEvent(
    new CustomEvent(BASIC_GUIDE_CHANGED_EVENT, { detail: state })
  );
}

export function subscribeBasicGuide(
  onChange: (state: PersistedBasicGuide | null) => void
): () => void {
  const handleCustom = (event: Event) => {
    const detail = (event as CustomEvent<PersistedBasicGuide>).detail;
    onChange(detail ?? readBasicGuide());
  };
  const handleStorage = (event: StorageEvent) => {
    if (event.key !== BASIC_GUIDE_STORAGE_KEY) return;
    onChange(parsePersistedBasicGuide(event.newValue));
  };
  window.addEventListener(BASIC_GUIDE_CHANGED_EVENT, handleCustom);
  window.addEventListener('storage', handleStorage);
  return () => {
    window.removeEventListener(BASIC_GUIDE_CHANGED_EVENT, handleCustom);
    window.removeEventListener('storage', handleStorage);
  };
}
