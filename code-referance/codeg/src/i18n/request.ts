import { getRequestConfig } from "next-intl/server"
import { getMessagesForLocale } from "@/i18n/messages"
import { resolveRequestLocale } from "@/i18n/resolve-request-locale"
import { APP_LOCALE_TO_INTL_LOCALE } from "@/lib/i18n"

export default getRequestConfig(async () => {
  const appLocale = await resolveRequestLocale()

  return {
    locale: APP_LOCALE_TO_INTL_LOCALE[appLocale],
    messages: await getMessagesForLocale(appLocale),
  }
})
