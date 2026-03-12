import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en";
import zh from "./locales/zh";
import { getClientStoreSync, writeClientStoreValue } from "../services/clientStorage";

const getStoredLanguage = (): string => {
  const stored = getClientStoreSync<string>("app", "language");
  if (stored && (stored === "zh" || stored === "en")) {
    return stored;
  }
  return "zh"; // Default to Chinese
};

export const saveLanguage = (lang: string): void => {
  writeClientStoreValue("app", "language", lang);
};

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    zh: { translation: zh },
  },
  lng: getStoredLanguage(),
  fallbackLng: "en",
  interpolation: {
    escapeValue: false,
  },
});

export default i18n;
