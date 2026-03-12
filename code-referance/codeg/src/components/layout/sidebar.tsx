"use client"

import { useCallback, useRef } from "react"
import { ChevronsDownUp, ChevronsUpDown, Crosshair, Plus } from "lucide-react"
import { useTranslations } from "next-intl"
import { useFolderContext } from "@/contexts/folder-context"
import { useTabContext } from "@/contexts/tab-context"
import { useSidebarContext } from "@/contexts/sidebar-context"
import {
  SidebarConversationList,
  type SidebarConversationListHandle,
} from "@/components/conversations/sidebar-conversation-list"
import { Button } from "@/components/ui/button"

export function Sidebar() {
  const t = useTranslations("Folder.sidebar")
  const { folder } = useFolderContext()
  const { openNewConversationTab } = useTabContext()
  const { isOpen } = useSidebarContext()
  const listRef = useRef<SidebarConversationListHandle>(null)

  const handleNewConversation = useCallback(() => {
    if (!folder) return
    openNewConversationTab("codex", folder.path)
  }, [folder, openNewConversationTab])

  if (!isOpen) return null

  return (
    <aside className="group/sidebar flex h-full min-h-0 flex-col overflow-hidden bg-sidebar text-sidebar-foreground select-none">
      <div className="flex h-10 items-center justify-between border-b border-border px-4">
        <h2 className="text-xs font-bold">{t("title")}</h2>
        <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover/sidebar:opacity-100">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0 text-muted-foreground"
            onClick={() => listRef.current?.scrollToActive()}
            title={t("locateActiveConversation")}
          >
            <Crosshair className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0 text-muted-foreground"
            onClick={() => listRef.current?.expandAll()}
            title={t("expandAllGroups")}
          >
            <ChevronsUpDown className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0 text-muted-foreground"
            onClick={() => listRef.current?.collapseAll()}
            title={t("collapseAllGroups")}
          >
            <ChevronsDownUp className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0 text-muted-foreground"
            onClick={handleNewConversation}
            title={t("newConversation")}
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <SidebarConversationList ref={listRef} />
    </aside>
  )
}
