"use client"

import { Suspense } from "react"
import { useTranslations } from "next-intl"
import { AcpAgentSettings } from "@/components/settings/acp-agent-settings"

export default function SettingsAgentsPage() {
  const t = useTranslations("SettingsPages")

  return (
    <Suspense
      fallback={
        <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
          {t("agentsLoading")}
        </div>
      }
    >
      <AcpAgentSettings />
    </Suspense>
  )
}
