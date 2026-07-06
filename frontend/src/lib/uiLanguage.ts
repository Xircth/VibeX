/**
 * UI language (P3-1, i18n): a frontend-only, localStorage-persisted interface
 * language. Bilingual zh-CN / en, defaulting to zh-CN so existing users see no
 * change. Mirrors the storage pattern of {@link ./uiZoom}.
 *
 * Deliberately NOT wired to the backend `Config.language` field yet — a later
 * slice can sync the two once backend user-visible strings (IM templates,
 * recovery reasons) also localize. Keep this the single source of truth until
 * then to avoid two competing stores.
 */
export const SUPPORTED_LANGUAGES = ['zh-CN', 'en'] as const;
export type UiLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export const LANGUAGE_LABELS: Record<UiLanguage, string> = {
  'zh-CN': '简体中文',
  en: 'English',
};

export const LANGUAGE_KEY = 'vibex:ui-language';
export const DEFAULT_LANGUAGE: UiLanguage = 'zh-CN';

function isSupported(value: string | null): value is UiLanguage {
  return (
    value !== null && SUPPORTED_LANGUAGES.includes(value as UiLanguage)
  );
}

export function getUiLanguage(): UiLanguage {
  return isSupported(localStorage.getItem(LANGUAGE_KEY))
    ? (localStorage.getItem(LANGUAGE_KEY) as UiLanguage)
    : DEFAULT_LANGUAGE;
}

export function persistUiLanguage(language: UiLanguage): void {
  localStorage.setItem(LANGUAGE_KEY, language);
}
