"use client"

import { useState } from "react"
import { ChevronDown, Folder, FolderOpen, GitBranch } from "lucide-react"
import { open } from "@tauri-apps/plugin-dialog"
import { useTranslations } from "next-intl"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  focusFolderWindow,
  listOpenFolders,
  loadFolderHistory,
  openFolderWindow,
} from "@/lib/tauri"
import { useFolderContext } from "@/contexts/folder-context"
import { CloneDialog } from "@/components/welcome/clone-dialog"
import type { FolderHistoryEntry } from "@/lib/types"

export function FolderNameDropdown() {
  const t = useTranslations("Folder.folderNameDropdown")
  const { folder } = useFolderContext()
  const [openFolders, setOpenFolders] = useState<FolderHistoryEntry[]>([])
  const [history, setHistory] = useState<FolderHistoryEntry[]>([])
  const [cloneOpen, setCloneOpen] = useState(false)

  const folderPath = folder?.path ?? ""
  const folderName = folder?.name ?? t("fallbackFolderName")

  async function handleOpenChange(open: boolean) {
    if (open) {
      try {
        const [openEntries, historyEntries] = await Promise.all([
          listOpenFolders(),
          loadFolderHistory(),
        ])
        setOpenFolders(openEntries)
        const openPaths = new Set(openEntries.map((e) => e.path))
        setHistory(historyEntries.filter((e) => !openPaths.has(e.path)))
      } catch {
        setOpenFolders([])
        setHistory([])
      }
    }
  }

  async function handleOpenFolder() {
    const selected = await open({ directory: true, multiple: false })
    if (selected) {
      await openFolderWindow(selected)
    }
  }

  async function handleSelect(path: string) {
    try {
      await openFolderWindow(path)
    } catch {
      // ignore
    }
  }

  return (
    <>
      <DropdownMenu onOpenChange={handleOpenChange}>
        <DropdownMenuTrigger asChild>
          <button
            suppressHydrationWarning
            className="flex items-center gap-1 text-sm tracking-tight truncate hover:text-foreground/80 transition-colors outline-none cursor-default"
          >
            {folderName}
            <ChevronDown className="h-3 w-3 shrink-0 opacity-50" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="min-w-64" align="start">
          <DropdownMenuItem onSelect={handleOpenFolder}>
            <FolderOpen className="h-3.5 w-3.5 shrink-0" />
            {t("openFolder")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setCloneOpen(true)}>
            <GitBranch className="h-3.5 w-3.5 shrink-0" />
            {t("cloneRepository")}
          </DropdownMenuItem>
          {openFolders.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>{t("opened")}</DropdownMenuLabel>
              {openFolders.map((entry) => (
                <DropdownMenuItem
                  key={entry.path}
                  onSelect={() => focusFolderWindow(entry.id)}
                >
                  {entry.path === folderPath ? (
                    <FolderOpen className="h-3.5 w-3.5 shrink-0" />
                  ) : (
                    <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <div className="min-w-0">
                    <div
                      className={`truncate ${entry.path === folderPath ? "font-medium text-foreground" : ""}`}
                    >
                      {entry.name}
                    </div>
                    <div className="text-[10px] text-muted-foreground truncate">
                      {entry.path}
                    </div>
                  </div>
                </DropdownMenuItem>
              ))}
            </>
          )}
          {history.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>{t("recentOpen")}</DropdownMenuLabel>
              {history.map((entry) => (
                <DropdownMenuItem
                  key={entry.path}
                  onSelect={() => handleSelect(entry.path)}
                >
                  <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <div className="truncate">{entry.name}</div>
                    <div className="text-[10px] text-muted-foreground truncate">
                      {entry.path}
                    </div>
                  </div>
                </DropdownMenuItem>
              ))}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <CloneDialog open={cloneOpen} onOpenChange={setCloneOpen} />
    </>
  )
}
