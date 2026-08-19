import { afterEach, describe, expect, it } from 'vitest';

import {
  clearLocalStorageCache,
  readLocalStorage,
  writeLocalStorage,
} from './safeStorage';

describe('safeStorage', () => {
  afterEach(() => {
    window.localStorage.clear();
    clearLocalStorageCache();
  });

  it('reads through a memory cache', () => {
    window.localStorage.setItem('k', 'v1');
    expect(readLocalStorage('k')).toBe('v1');
    window.localStorage.setItem('k', 'v2');
    expect(readLocalStorage('k')).toBe('v1');
    clearLocalStorageCache('k');
    expect(readLocalStorage('k')).toBe('v2');
  });

  it('writes to storage and cache', () => {
    writeLocalStorage('k', 'saved');
    expect(window.localStorage.getItem('k')).toBe('saved');
    expect(readLocalStorage('k')).toBe('saved');
  });
});
