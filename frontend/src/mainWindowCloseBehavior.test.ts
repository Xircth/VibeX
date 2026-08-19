import { afterEach, describe, expect, it } from 'vitest';

import { clearLocalStorageCache } from '@/lib/safeStorage';
import {
  getSavedMainWindowCloseBehavior,
  saveMainWindowCloseBehavior,
} from './mainWindowCloseBehavior';

describe('main window close behavior storage', () => {
  afterEach(() => {
    window.localStorage.clear();
    clearLocalStorageCache();
  });

  it('returns no saved behavior when storage is empty or invalid', () => {
    expect(getSavedMainWindowCloseBehavior()).toBeNull();

    window.localStorage.setItem('vibex.mainWindowCloseBehavior', 'close');

    expect(getSavedMainWindowCloseBehavior()).toBeNull();
  });

  it('persists and reads supported close behaviors', () => {
    saveMainWindowCloseBehavior('exit');
    expect(getSavedMainWindowCloseBehavior()).toBe('exit');

    saveMainWindowCloseBehavior('minimize');
    expect(getSavedMainWindowCloseBehavior()).toBe('minimize');
  });
});
