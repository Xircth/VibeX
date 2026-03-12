"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Reorder } from "motion/react"
import { FileText, GitCompare, X } from "lucide-react"
import { useTranslations } from "next-intl"
import { useWorkspaceContext } from "@/contexts/workspace-context"
import { useShortcutSettings } from "@/hooks/use-shortcut-settings"
import { matchShortcutEvent } from "@/lib/keyboard-shortcuts"
import { cn } from "@/lib/utils"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"

export function FileWorkspaceTabBar() {
  const t = useTranslations("Folder.fileWorkspace")
  const {
    mode,
    activePane,
    fileTabs,
    activeFileTabId,
    switchFileTab,
    closeFileTab,
    closeOtherFileTabs,
    closeAllFileTabs,
    reorderFileTabs,
  } = useWorkspaceContext()
  const { shortcuts } = useShortcutSettings()
  const scrollRef = useRef<HTMLDivElement>(null)
  const [isHovered, setIsHovered] = useState(false)

  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    if (e.deltaY !== 0 && scrollRef.current) {
      e.preventDefault()
      scrollRef.current.scrollLeft += e.deltaY
    }
  }, [])

  useEffect(() => {
    if (!activeFileTabId || !scrollRef.current) return
    const el = scrollRef.current.querySelector(
      `[data-file-tab-id="${activeFileTabId}"]`
    )
    el?.scrollIntoView({ block: "nearest", inline: "nearest" })
  }, [activeFileTabId])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const shouldHandleShortcut =
        mode === "files" || (mode === "fusion" && activePane === "files")
      if (!shouldHandleShortcut) return
      if (matchShortcutEvent(event, shortcuts.close_all_file_tabs)) {
        event.preventDefault()
        closeAllFileTabs()
        return
      }
      if (!matchShortcutEvent(event, shortcuts.close_current_tab)) return

      if (!activeFileTabId) return
      event.preventDefault()
      closeFileTab(activeFileTabId)
    }

    window.addEventListener("keydown", onKeyDown)
    return () => {
      window.removeEventListener("keydown", onKeyDown)
    }
  }, [
    activeFileTabId,
    closeAllFileTabs,
    closeFileTab,
    mode,
    activePane,
    shortcuts.close_all_file_tabs,
    shortcuts.close_current_tab,
  ])

  if (fileTabs.length === 0) {
    return (
      <div className="h-10 px-3 flex items-center border-b border-border text-xs text-muted-foreground">
        {t("files")}
      </div>
    )
  }

  return (
    <Reorder.Group
      as="div"
      ref={scrollRef}
      role="tablist"
      axis="x"
      values={fileTabs}
      onReorder={reorderFileTabs}
      onWheel={handleWheel}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className={cn(
        "h-10 pt-1.5 px-1.5 flex items-stretch gap-1.5 border-b border-border",
        "overflow-x-scroll",
        isHovered
          ? [
              "pb-0.5",
              "[&::-webkit-scrollbar]:h-1",
              "[&::-webkit-scrollbar-track]:bg-transparent",
              "[&::-webkit-scrollbar-thumb]:rounded-full",
              "[&::-webkit-scrollbar-thumb]:bg-border",
            ]
          : ["pb-1.5", "[&::-webkit-scrollbar]:h-0"]
      )}
    >
      {fileTabs.map((tab) => {
        const active = tab.id === activeFileTabId
        const isDiff = tab.kind === "diff" || tab.kind === "rich-diff"
        const isDirty = tab.kind === "file" && Boolean(tab.isDirty)

        return (
          <Reorder.Item
            key={tab.id}
            as="div"
            value={tab}
            data-file-tab-id={tab.id}
            className="shrink-0 rounded-full cursor-grab active:cursor-grabbing"
          >
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <div
                  role="tab"
                  aria-selected={active}
                  onClick={() => switchFileTab(tab.id)}
                  className={cn(
                    "group/filetab relative flex items-center h-full gap-1.5 px-3 text-xs rounded-full",
                    "cursor-pointer select-none shrink-0 hover:bg-primary/8 transition-colors",
                    active
                      ? "bg-primary/10 text-foreground"
                      : "text-muted-foreground"
                  )}
                  title={tab.description ?? tab.title}
                >
                  {isDiff ? (
                    <GitCompare className="h-3.5 w-3.5" />
                  ) : (
                    <FileText className="h-3.5 w-3.5" />
                  )}
                  <span className="truncate max-w-[180px]">
                    {tab.title}
                    {isDirty ? " *" : ""}
                  </span>
                  <button
                    type="button"
                    className={cn(
                      "rounded-full p-0.5 hover:bg-muted",
                      active
                        ? "opacity-100"
                        : "opacity-0 group-hover/filetab:opacity-100"
                    )}
                    onClick={(event) => {
                      event.stopPropagation()
                      closeFileTab(tab.id)
                    }}
                    aria-label={t("closeFileTab")}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem onSelect={() => closeFileTab(tab.id)}>
                  {t("close")}
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => closeOtherFileTabs(tab.id)}>
                  {t("closeOthers")}
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={closeAllFileTabs}>
                  {t("closeAll")}
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          </Reorder.Item>
        )
      })}
    </Reorder.Group>
  )
}
