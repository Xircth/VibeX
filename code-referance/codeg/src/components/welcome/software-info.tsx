"use client"

import { MessageCircleCode } from "lucide-react"
import { useTranslations } from "next-intl"

export function SoftwareInfo() {
  const t = useTranslations("WelcomePage")

  return (
    <div className="w-full flex gap-4 px-6 py-8">
      <MessageCircleCode className="size-12" />
      <div className="flex flex-col">
        <span className="text-base">Codeg</span>
        <span className="text-sm text-muted-foreground">
          {t("softwareVersion", { version: "0.0.1" })}
        </span>
      </div>
    </div>
  )
}
