import { cookies, headers } from "next/headers"
import {
  LANGUAGE_COOKIE_KEY,
  LANGUAGE_MODE_COOKIE_KEY,
  parseAcceptLanguageHeader,
  parseLocaleFromCookieValue,
  resolveSystemLocale,
} from "@/lib/i18n"
import type { AppLocale, LanguageMode } from "@/lib/types"

const FALLBACK_LOCALE: AppLocale = "en"

function parseLanguageModeCookie(value: string | undefined): LanguageMode {
  return value === "manual" ? "manual" : "system"
}

export async function resolveRequestLocale(): Promise<AppLocale> {
  let configuredLocale: AppLocale | null = null
  let languageMode: LanguageMode = "system"

  try {
    const cookieStore = await cookies()
    configuredLocale = parseLocaleFromCookieValue(
      cookieStore.get(LANGUAGE_COOKIE_KEY)?.value
    )
    languageMode = parseLanguageModeCookie(
      cookieStore.get(LANGUAGE_MODE_COOKIE_KEY)?.value
    )
  } catch {
    // Ignore when request cookies are unavailable (e.g. static export build).
  }

  if (configuredLocale && languageMode === "manual") {
    return configuredLocale
  }

  try {
    const headerStore = await headers()
    const candidates = parseAcceptLanguageHeader(
      headerStore.get("accept-language")
    )
    const fromHeader = resolveSystemLocale(candidates)
    if (fromHeader) {
      return fromHeader
    }
  } catch {
    // Ignore when request headers are unavailable (e.g. static export build).
  }

  return configuredLocale ?? FALLBACK_LOCALE
}
