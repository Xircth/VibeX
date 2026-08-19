import { afterEach, describe, expect, it } from 'vitest';

import { clearLocalStorageCache } from './safeStorage';
import { getUiLanguage, LANGUAGE_KEY, type UiLanguage } from './uiLanguage';

const originalLanguage = navigator.language;
const originalLanguages = navigator.languages;

function setSystemLanguages(primary: string, ...secondary: string[]) {
  Object.defineProperties(window.navigator, {
    language: { configurable: true, value: primary },
    languages: { configurable: true, value: [primary, ...secondary] },
  });
}

afterEach(() => {
  Object.defineProperties(window.navigator, {
    language: { configurable: true, value: originalLanguage },
    languages: { configurable: true, value: originalLanguages },
  });
  localStorage.removeItem(LANGUAGE_KEY);
  clearLocalStorageCache(LANGUAGE_KEY);
});

describe('getUiLanguage', () => {
  it.each(['zh-CN', 'zh-TW', 'zh-Hans'])('%s defaults to Chinese', (locale) => {
    setSystemLanguages(locale);
    expect(getUiLanguage()).toBe('zh-CN');
  });

  it.each(['en-US', 'ja-JP', 'fr-FR'])('%s defaults to English', (locale) => {
    setSystemLanguages(locale, 'zh-CN');
    expect(getUiLanguage()).toBe('en');
  });

  it('keeps an explicit saved preference ahead of the system language', () => {
    setSystemLanguages('zh-CN');
    localStorage.setItem(LANGUAGE_KEY, 'en' satisfies UiLanguage);
    expect(getUiLanguage()).toBe('en');
  });
});
