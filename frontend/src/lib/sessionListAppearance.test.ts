import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const persistFrontendPreference = vi.hoisted(() => vi.fn());

vi.mock('@/lib/frontendPreferences', () => ({ persistFrontendPreference }));

import {
  SESSION_LIST_APPEARANCE_KEY,
  getSessionListAppearance,
  setSessionListAppearance,
  useSessionListAppearance,
} from './sessionListAppearance';

describe('sessionListAppearance', () => {
  beforeEach(() => {
    localStorage.clear();
    persistFrontendPreference.mockReset();
  });

  it('defaults to compact for missing or unsupported preferences', () => {
    expect(getSessionListAppearance()).toBe('compact');
    localStorage.setItem(SESSION_LIST_APPEARANCE_KEY, 'unknown');
    expect(getSessionListAppearance()).toBe('compact');
  });

  it('updates mounted lists and persists the selected style', () => {
    const { result } = renderHook(useSessionListAppearance);
    act(() => setSessionListAppearance('full'));

    expect(result.current).toBe('full');
    expect(localStorage.getItem(SESSION_LIST_APPEARANCE_KEY)).toBe('full');
    expect(persistFrontendPreference).toHaveBeenCalledWith(
      SESSION_LIST_APPEARANCE_KEY,
      'full'
    );
  });

  it('updates mounted lists when another window changes the preference', () => {
    const { result } = renderHook(useSessionListAppearance);
    act(() => {
      localStorage.setItem(SESSION_LIST_APPEARANCE_KEY, 'full');
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: SESSION_LIST_APPEARANCE_KEY,
          newValue: 'full',
        })
      );
    });
    expect(result.current).toBe('full');
  });
});
