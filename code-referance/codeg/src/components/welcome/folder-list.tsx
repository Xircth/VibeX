"use client"

import { useMemo, useState } from "react"
import { Search, X, FolderOpen } from "lucide-react"
import { formatDistanceToNow } from "date-fns"
import { enUS, zhCN, zhTW } from "date-fns/locale"
import { useLocale, useTranslations } from "next-intl"
import { toast } from "sonner"
import { openFolderWindow, removeFolderFromHistory } from "@/lib/tauri"
import type { FolderHistoryEntry } from "@/lib/types"
import { Input } from "@/components/ui/input"
import { resolveWelcomeError } from "@/components/welcome/error-utils"

interface FolderListProps {
  history: FolderHistoryEntry[]
  loading: boolean
  onRefresh: () => void
}

export function FolderList({ history, loading, onRefresh }: FolderListProps) {
  const t = useTranslations("WelcomePage")
  const locale = useLocale()
  const [search, setSearch] = useState("")
  const dateFnsLocale =
    locale === "zh-CN" ? zhCN : locale === "zh-TW" ? zhTW : enUS

  const filtered = useMemo(() => {
    if (!search) return history
    const lowerCaseSearch = search.toLowerCase()

    return history.filter(
      (h) =>
        h.name.toLowerCase().includes(lowerCaseSearch) ||
        h.path.toLowerCase().includes(lowerCaseSearch)
    )
  }, [history, search])

  const handleOpen = async (path: string) => {
    try {
      await openFolderWindow(path)
    } catch (err) {
      console.error("Failed to open folder:", err)
      const resolvedError = resolveWelcomeError(err)
      toast.error(t("toasts.openFolderFailed"), {
        description: resolvedError.detail ?? t(resolvedError.key),
      })
    }
  }

  const handleRemove = async (e: React.MouseEvent, path: string) => {
    e.stopPropagation()
    try {
      await removeFolderFromHistory(path)
      onRefresh()
    } catch (err) {
      console.error("Failed to remove folder:", err)
      const resolvedError = resolveWelcomeError(err)
      toast.error(t("toasts.removeFromHistoryFailed"), {
        description: resolvedError.detail ?? t(resolvedError.key),
      })
    }
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 p-8">
      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder={t("searchPlaceholder")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9 h-9"
        />
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center h-32 text-sm text-muted-foreground">
            {t("loading")}
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 text-sm text-muted-foreground gap-2">
            <FolderOpen className="h-8 w-8" />
            <span>{t("emptyFolders")}</span>
          </div>
        ) : (
          filtered.map((entry) => (
            <div
              key={entry.id}
              role="button"
              tabIndex={0}
              className="w-full text-left p-3 rounded-lg hover:bg-accent/50 transition-colors group flex items-start gap-3 cursor-pointer"
              onClick={() => handleOpen(entry.path)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault()
                  handleOpen(entry.path)
                }
              }}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium truncate">
                    {entry.name}
                  </span>
                </div>
                <div className="text-xs text-muted-foreground truncate mt-0.5">
                  {entry.path}
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-xs text-muted-foreground">
                    {formatDistanceToNow(new Date(entry.last_opened_at), {
                      addSuffix: true,
                      locale: dateFnsLocale,
                    })}
                  </span>
                </div>
              </div>
              <button
                className="opacity-0 group-hover:opacity-100 transition-opacity p-1 hover:bg-destructive/10 rounded shrink-0 mt-0.5"
                onClick={(e) => handleRemove(e, entry.path)}
                title={t("removeFromHistory")}
                aria-label={t("removeFromHistory")}
                type="button"
              >
                <X className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
