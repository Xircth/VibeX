import type enMessages from "@/i18n/messages/en.json"

declare module "next-intl" {
  interface AppConfig {
    Locale:
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
    Messages: typeof enMessages
  }
}
