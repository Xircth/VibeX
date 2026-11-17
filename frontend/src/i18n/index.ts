/**
 * i18n runtime (P3-1). A module-singleton react-i18next instance — importing
 * this file starts initialization and loads the active locale bundle
 * dynamically so unused languages stay out of the startup JS budget.
 *
 * Bilingual zh-CN / en, with the initial language derived from the saved choice
 * or primary system locale. Language selection persists to localStorage via
 * {@link @/lib/uiLanguage}; changing it re-renders subscribers.
 */
import i18n, { type BackendModule, type ReadCallback } from 'i18next';
import { initReactI18next } from 'react-i18next';

import {
  getUiLanguage,
  persistUiLanguage,
  DEFAULT_LANGUAGE,
  LANGUAGE_KEY,
  type UiLanguage,
} from '@/lib/uiLanguage';

export const NAMESPACES = [
  'common',
  'settings',
  'statusbar',
  'app',
  'tasks',
  'dialogs',
  'conversation',
  'panels',
  'workflow',
  'basicGuide',
] as const;

export type LocaleNamespace = (typeof NAMESPACES)[number];
export type LocaleBundle = Record<LocaleNamespace, Record<string, unknown>>;

const bundleCache = new Map<UiLanguage, LocaleBundle>();
const bundleInFlight = new Map<UiLanguage, Promise<LocaleBundle>>();

export async function loadLocaleBundle(
  language: UiLanguage
): Promise<LocaleBundle> {
  const cached = bundleCache.get(language);
  if (cached) return cached;

  const existing = bundleInFlight.get(language);
  if (existing) return existing;

  const promise = (
    language === 'zh-CN' ? import('./locales/zh-CN') : import('./locales/en')
  )
    .then((mod) => {
      const bundle = mod.default as unknown as LocaleBundle;
      bundleCache.set(language, bundle);
      return bundle;
    })
    .finally(() => {
      bundleInFlight.delete(language);
    });

  bundleInFlight.set(language, promise);
  return promise;
}

export async function ensureLanguageLoaded(
  language: UiLanguage
): Promise<void> {
  await i18nReady;
  const bundle = await loadLocaleBundle(language);
  for (const ns of NAMESPACES) {
    if (!i18n.hasResourceBundle(language, ns)) {
      i18n.addResourceBundle(language, ns, bundle[ns], true, true);
    }
  }
}

const localeBackend: BackendModule = {
  type: 'backend',
  init() {},
  read(language: string, namespace: string, callback: ReadCallback) {
    if (language !== 'zh-CN' && language !== 'en') {
      callback(null, false);
      return;
    }
    void loadLocaleBundle(language)
      .then((bundle) => {
        const resource = (bundle as Record<string, Record<string, unknown>>)[
          namespace
        ];
        callback(null, resource ?? false);
      })
      .catch((error: unknown) => {
        callback(
          error instanceof Error ? error : new Error(String(error)),
          false
        );
      });
  },
};

function applyDocumentLanguage(language: string): void {
  if (typeof document !== 'undefined') {
    document.documentElement.lang = language;
  }
}

const initialLanguage = getUiLanguage();
applyDocumentLanguage(initialLanguage);

i18n.on('languageChanged', (language) => {
  applyDocumentLanguage(language);
});

export const i18nReady: Promise<unknown> = i18n
  .use(localeBackend)
  .use(initReactI18next)
  .init({
    lng: initialLanguage,
    fallbackLng: DEFAULT_LANGUAGE,
    ns: NAMESPACES,
    defaultNS: 'common',
    interpolation: { escapeValue: false },
    returnNull: false,
    react: { useSuspense: false },
  });

/** Persist + apply a language change; subscribers re-render via i18next events. */
export function setUiLanguage(language: UiLanguage): void {
  persistUiLanguage(language);
  applyDocumentLanguage(language);
  void ensureLanguageLoaded(language).then(() => i18n.changeLanguage(language));
}

// Cross-window sync: the Settings webview is a separate JS context with its own
// i18n singleton. localStorage is shared and fires a `storage` event in the OTHER
// windows when it changes, so mirror the language change into this window's i18n
// (e.g. main window re-localizes when Settings switches language).
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== LANGUAGE_KEY) return;
    const next = getUiLanguage();
    applyDocumentLanguage(next);
    if (i18n.language !== next) {
      void ensureLanguageLoaded(next).then(() => i18n.changeLanguage(next));
    }
  });
}

export default i18n;
