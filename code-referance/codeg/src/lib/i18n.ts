import type { AppLocale, SystemLanguageSettings } from "@/lib/types"

export const APP_LOCALES: readonly AppLocale[] = [
  "en",
  "zh_cn",
  "zh_tw",
  "ja",
  "ko",
  "es",
  "de",
  "fr",
  "pt",
  "ar",
]
const FALLBACK_APP_LOCALE: AppLocale = "en"
export const LANGUAGE_SETTINGS_STORAGE_KEY = "codeg.system_language_settings"
export const LANGUAGE_MODE_COOKIE_KEY = "codeg.language_mode"
export const LANGUAGE_COOKIE_KEY = "codeg.locale"
export type IntlLocale =
  | "en"
  | "zh-CN"
  | "zh-TW"
  | "ja"
  | "ko"
  | "es"
  | "de"
  | "fr"
  | "pt"
  | "ar"

export const DEFAULT_LANGUAGE_SETTINGS: SystemLanguageSettings = {
  mode: "system",
  language: FALLBACK_APP_LOCALE,
}

export const APP_LOCALE_TO_INTL_LOCALE: Record<AppLocale, IntlLocale> = {
  en: "en",
  zh_cn: "zh-CN",
  zh_tw: "zh-TW",
  ja: "ja",
  ko: "ko",
  es: "es",
  de: "de",
  fr: "fr",
  pt: "pt",
  ar: "ar",
}

export const INTL_LOCALE_TO_APP_LOCALE: Record<IntlLocale, AppLocale> = {
  en: "en",
  "zh-CN": "zh_cn",
  "zh-TW": "zh_tw",
  ja: "ja",
  ko: "ko",
  es: "es",
  de: "de",
  fr: "fr",
  pt: "pt",
  ar: "ar",
}

export function isAppLocale(value: unknown): value is AppLocale {
  return APP_LOCALES.includes(value as AppLocale)
}

export function isIntlLocale(value: unknown): value is IntlLocale {
  return (
    value === "en" ||
    value === "zh-CN" ||
    value === "zh-TW" ||
    value === "ja" ||
    value === "ko" ||
    value === "es" ||
    value === "de" ||
    value === "fr" ||
    value === "pt" ||
    value === "ar"
  )
}

export function toIntlLocale(locale: AppLocale): IntlLocale {
  return APP_LOCALE_TO_INTL_LOCALE[locale]
}

export function fromIntlLocale(locale: IntlLocale): AppLocale {
  return INTL_LOCALE_TO_APP_LOCALE[locale]
}

export function normalizeLanguageSettings(
  settings: Partial<SystemLanguageSettings> | null | undefined
): SystemLanguageSettings {
  const mode = settings?.mode === "manual" ? "manual" : "system"
  const language = isAppLocale(settings?.language)
    ? settings.language
    : FALLBACK_APP_LOCALE

  return {
    mode,
    language,
  }
}

export function mapLocaleTagToAppLocale(localeTag: string): AppLocale | null {
  const normalized = localeTag.trim().toLowerCase().replace(/_/g, "-")

  if (!normalized) return null
  if (normalized.startsWith("en")) return "en"

  if (
    normalized.startsWith("zh-hant") ||
    normalized.endsWith("-tw") ||
    normalized.endsWith("-hk") ||
    normalized.endsWith("-mo")
  ) {
    return "zh_tw"
  }

  if (normalized.startsWith("zh")) return "zh_cn"
  if (normalized.startsWith("ja")) return "ja"
  if (normalized.startsWith("ko")) return "ko"
  if (normalized.startsWith("es")) return "es"
  if (normalized.startsWith("de")) return "de"
  if (normalized.startsWith("fr")) return "fr"
  if (normalized.startsWith("pt")) return "pt"
  if (normalized.startsWith("ar")) return "ar"

  return null
}

export function parseAcceptLanguageHeader(value: string | null): string[] {
  if (!value) return []

  return value
    .split(",")
    .map((entry) => entry.split(";")[0]?.trim())
    .filter((entry): entry is string => Boolean(entry))
}

export function parseLocaleFromCookieValue(
  value: string | undefined
): AppLocale | null {
  if (!value) return null

  if (isAppLocale(value)) return value
  if (isIntlLocale(value)) return fromIntlLocale(value)

  return mapLocaleTagToAppLocale(value)
}

export function getSystemLocaleCandidates(): string[] {
  if (typeof navigator === "undefined") return []

  const candidates = [
    ...(navigator.languages ?? []),
    navigator.language,
  ].filter((value): value is string => Boolean(value))

  return [...new Set(candidates)]
}

export function resolveSystemLocale(candidates: string[]): AppLocale | null {
  for (const candidate of candidates) {
    const resolved = mapLocaleTagToAppLocale(candidate)
    if (resolved) return resolved
  }

  return null
}

export function resolveAppLocale(
  settings: SystemLanguageSettings,
  systemLocaleCandidates: string[]
): AppLocale {
  if (settings.mode === "manual") {
    return settings.language
  }

  return resolveSystemLocale(systemLocaleCandidates) ?? FALLBACK_APP_LOCALE
}
