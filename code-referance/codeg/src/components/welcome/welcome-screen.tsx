"use client"

import { useState, useEffect, useCallback } from "react"
import { Settings } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { loadFolderHistory, openSettingsWindow } from "@/lib/tauri"
import type { FolderHistoryEntry } from "@/lib/types"
import { FolderList } from "@/components/welcome/folder-list"
import { FolderActions } from "@/components/welcome/folder-actions"
import { SoftwareInfo } from "@/components/welcome/software-info"
import { Button } from "@/components/ui/button"
import { AppToaster } from "@/components/ui/app-toaster"
import { resolveWelcomeError } from "@/components/welcome/error-utils"
import { AppTitleBar } from "@/components/layout/app-title-bar"

export function WelcomeScreen() {
  const t = useTranslations("WelcomePage")
  const [history, setHistory] = useState<FolderHistoryEntry[]>([])
  const [loading, setLoading] = useState(true)

  const refreshHistory = useCallback(async () => {
    try {
      setHistory(await loadFolderHistory())
    } catch (err) {
      console.error("[WelcomeScreen] failed to load folder history:", err)
      const resolvedError = resolveWelcomeError(err)
      toast.error(t("toasts.loadFolderHistoryFailed"), {
        description: resolvedError.detail ?? t(resolvedError.key),
      })
      setHistory([])
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    refreshHistory()
  }, [refreshHistory])

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-background text-foreground">
      <AppTitleBar
        center={
          <span className="text-sm font-bold tracking-tight">{t("title")}</span>
        }
        right={
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 hover:text-foreground/80"
            onClick={() => {
              openSettingsWindow().catch((err) => {
                console.error("[WelcomeScreen] failed to open settings:", err)
                const resolvedError = resolveWelcomeError(err)
                toast.error(t("toasts.openSettingsFailed"), {
                  description: resolvedError.detail ?? t(resolvedError.key),
                })
              })
            }}
            title={t("openSettings")}
            aria-label={t("openSettings")}
            type="button"
          >
            <Settings className="h-3.5 w-3.5" />
          </Button>
        }
      />

      <div className="flex-1 flex overflow-hidden">
        <div className="w-60 shrink-0 flex flex-col border-r">
          <SoftwareInfo />
          <FolderActions />
        </div>
        <FolderList
          history={history}
          loading={loading}
          onRefresh={refreshHistory}
        />
      </div>
      <AppToaster position="bottom-right" closeButton duration={4000} />
    </div>
  )
}
