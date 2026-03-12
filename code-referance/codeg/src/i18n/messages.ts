import type { AbstractIntlMessages } from "next-intl"
import enMessages from "@/i18n/messages/en.json"
import type { AppLocale } from "@/lib/types"

const MESSAGE_CACHE = new Map<AppLocale, AbstractIntlMessages>([
  ["en", enMessages],
])

async function loadMessages(locale: AppLocale): Promise<AbstractIntlMessages> {
  switch (locale) {
    case "zh_cn":
      return (await import("@/i18n/messages/zh-CN.json")).default
    case "zh_tw":
      return (await import("@/i18n/messages/zh-TW.json")).default
    case "ja":
      return (await import("@/i18n/messages/ja.json")).default
    case "ko":
      return (await import("@/i18n/messages/ko.json")).default
    case "es":
      return (await import("@/i18n/messages/es.json")).default
    case "de":
      return (await import("@/i18n/messages/de.json")).default
    case "fr":
      return (await import("@/i18n/messages/fr.json")).default
    case "pt":
      return (await import("@/i18n/messages/pt.json")).default
    case "ar":
      return (await import("@/i18n/messages/ar.json")).default
    case "en":
    default:
      return enMessages
  }
}

export function getFallbackMessages(): AbstractIntlMessages {
  return enMessages
}

export async function getMessagesForLocale(
  locale: AppLocale
): Promise<AbstractIntlMessages> {
  const cached = MESSAGE_CACHE.get(locale)
  if (cached) return cached

  const messages = await loadMessages(locale)
  MESSAGE_CACHE.set(locale, messages)
  return messages
}
