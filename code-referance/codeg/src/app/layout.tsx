import type { Metadata } from "next"
import "./globals.css"
import { JetBrains_Mono } from "next/font/google"
import { NextIntlClientProvider } from "next-intl"
import { AppI18nProvider } from "@/components/i18n-provider"
import { getMessagesForLocale } from "@/i18n/messages"
import { resolveRequestLocale } from "@/i18n/resolve-request-locale"
import { ThemeProvider } from "@/components/theme-provider"
import { toIntlLocale } from "@/lib/i18n"

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-sans",
})

export const metadata: Metadata = {
  title: "codeg",
  description: "AI Coding Agent Conversation Manager",
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const appLocale = await resolveRequestLocale()
  const initialLocale = toIntlLocale(appLocale)
  const initialMessages = await getMessagesForLocale(appLocale)

  return (
    <html
      lang={initialLocale}
      className={jetbrainsMono.variable}
      suppressHydrationWarning
    >
      <body>
        <NextIntlClientProvider
          locale={initialLocale}
          messages={initialMessages}
        >
          <AppI18nProvider
            initialLocale={initialLocale}
            initialMessages={initialMessages}
          >
            <ThemeProvider
              attribute="class"
              defaultTheme="system"
              enableSystem
              disableTransitionOnChange
            >
              {children}
            </ThemeProvider>
          </AppI18nProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  )
}
