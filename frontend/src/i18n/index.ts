/**
 * i18n runtime (P3-1). A module-singleton react-i18next instance — importing
 * this file initializes it (synchronously, resources are bundled) so
 * `useTranslation()` works app-wide with no provider component and no change to
 * the three app roots in App.tsx. Import once in main.tsx before render.
 *
 * Bilingual zh-CN / en, default + fallback zh-CN. Language selection persists to
 * localStorage via {@link @/lib/uiLanguage}; changing it re-renders subscribers.
 *
 * Coverage is progressive (see docs): only converted screens read from here;
 * everything else stays as literal zh-CN, which matches the default language.
 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import {
  getUiLanguage,
  persistUiLanguage,
  DEFAULT_LANGUAGE,
  LANGUAGE_KEY,
  type UiLanguage,
} from '@/lib/uiLanguage';

import commonZh from './locales/zh-CN/common.json';
import settingsZh from './locales/zh-CN/settings.json';
import statusbarZh from './locales/zh-CN/statusbar.json';
import appZh from './locales/zh-CN/app.json';
import tasksZh from './locales/zh-CN/tasks.json';
import dialogsZh from './locales/zh-CN/dialogs.json';
import conversationZh from './locales/zh-CN/conversation.json';
import panelsZh from './locales/zh-CN/panels.json';
import commonEn from './locales/en/common.json';
import settingsEn from './locales/en/settings.json';
import statusbarEn from './locales/en/statusbar.json';
import appEn from './locales/en/app.json';
import tasksEn from './locales/en/tasks.json';
import dialogsEn from './locales/en/dialogs.json';
import conversationEn from './locales/en/conversation.json';
import panelsEn from './locales/en/panels.json';

export const NAMESPACES = [
  'common',
  'settings',
  'statusbar',
  'app',
  'tasks',
  'dialogs',
  'conversation',
  'panels',
] as const;

export const resources = {
  'zh-CN': {
    common: commonZh,
    settings: settingsZh,
    statusbar: statusbarZh,
    app: appZh,
    tasks: tasksZh,
    dialogs: dialogsZh,
    conversation: conversationZh,
    panels: panelsZh,
  },
  en: {
    common: commonEn,
    settings: settingsEn,
    statusbar: statusbarEn,
    app: appEn,
    tasks: tasksEn,
    dialogs: dialogsEn,
    conversation: conversationEn,
    panels: panelsEn,
  },
} as const;

void i18n.use(initReactI18next).init({
  resources,
  lng: getUiLanguage(),
  fallbackLng: DEFAULT_LANGUAGE,
  ns: NAMESPACES,
  defaultNS: 'common',
  interpolation: { escapeValue: false },
  returnNull: false,
  // Resources are bundled (synchronous) — never suspend on load, and stay safe
  // in unit tests that render a translated component without importing this
  // module (t() then returns the key instead of throwing a Suspense promise).
  react: { useSuspense: false },
});

/** Persist + apply a language change; subscribers re-render via i18next events. */
export function setUiLanguage(language: UiLanguage): void {
  persistUiLanguage(language);
  void i18n.changeLanguage(language);
}

// Cross-window sync: the Settings webview is a separate JS context with its own
// i18n singleton. localStorage is shared and fires a `storage` event in the OTHER
// windows when it changes, so mirror the language change into this window's i18n
// (e.g. main window re-localizes when Settings switches language).
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== LANGUAGE_KEY) return;
    const next = getUiLanguage();
    if (i18n.language !== next) {
      void i18n.changeLanguage(next);
    }
  });
}

export default i18n;
