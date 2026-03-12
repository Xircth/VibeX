"use client"

import { memo, useState, useCallback } from "react"
import { formatDistanceToNow } from "date-fns"
import { enUS, zhCN, zhTW } from "date-fns/locale"
import { GitBranch, Pencil, Trash2, Circle, Download, Plus } from "lucide-react"
import { useLocale, useTranslations } from "next-intl"
import type { DbConversationSummary, ConversationStatus } from "@/lib/types"
import { STATUS_COLORS } from "@/lib/types"
import { cn } from "@/lib/utils"
import { AgentIcon } from "@/components/agent-icon"
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
  ContextMenuSeparator,
} from "@/components/ui/context-menu"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

const ALL_STATUSES: ConversationStatus[] = [
  "in_progress",
  "pending_review",
  "completed",
  "cancelled",
]

interface SidebarConversationCardProps {
  conversation: DbConversationSummary
  isSelected: boolean
  onSelect: (id: number, agentType: string) => void
  onDoubleClick?: (id: number, agentType: string) => void
  onRename: (id: number, newTitle: string) => Promise<void>
  onDelete: (id: number, agentType: string) => Promise<void>
  onStatusChange: (id: number, status: ConversationStatus) => Promise<void>
  onNewConversation?: () => void
  onImport?: () => void
  importing?: boolean
}

export const SidebarConversationCard = memo(function SidebarConversationCard({
  conversation,
  isSelected,
  onSelect,
  onDoubleClick,
  onRename,
  onDelete,
  onStatusChange,
  onNewConversation,
  onImport,
  importing,
}: SidebarConversationCardProps) {
  const t = useTranslations("Folder.conversationCard")
  const tStatus = useTranslations("Folder.statusLabels")
  const locale = useLocale()
  const dateFnsLocale =
    locale === "zh-CN" ? zhCN : locale === "zh-TW" ? zhTW : enUS
  const [renameOpen, setRenameOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [renameValue, setRenameValue] = useState("")

  const timeAgo = formatDistanceToNow(new Date(conversation.updated_at), {
    addSuffix: true,
    locale: dateFnsLocale,
  })

  const handleClick = useCallback(() => {
    onSelect(conversation.id, conversation.agent_type)
  }, [onSelect, conversation.id, conversation.agent_type])

  const handleDblClick = useCallback(() => {
    onDoubleClick?.(conversation.id, conversation.agent_type)
  }, [onDoubleClick, conversation.id, conversation.agent_type])

  const handleRenameOpen = useCallback(() => {
    setRenameValue(conversation.title || "")
    setRenameOpen(true)
  }, [conversation.title])

  const handleRenameConfirm = useCallback(async () => {
    const trimmed = renameValue.trim()
    if (trimmed && trimmed !== conversation.title) {
      await onRename(conversation.id, trimmed)
    }
    setRenameOpen(false)
  }, [renameValue, conversation.id, conversation.title, onRename])

  const handleDeleteConfirm = useCallback(async () => {
    await onDelete(conversation.id, conversation.agent_type)
    setDeleteOpen(false)
  }, [conversation.id, conversation.agent_type, onDelete])

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            data-conversation-id={conversation.id}
            onClick={handleClick}
            onDoubleClick={handleDblClick}
            className={cn(
              "w-full text-left px-3 py-2.5 rounded-md transition-colors",
              "hover:bg-sidebar-accent/50",
              isSelected && "bg-sidebar-accent text-sidebar-accent-foreground"
            )}
          >
            <div className="flex items-center gap-1.5 min-w-0">
              <AgentIcon
                agentType={conversation.agent_type}
                className="size-4 shrink-0"
              />
              <span className="text-sm font-medium truncate">
                {conversation.title || t("untitledConversation")}
              </span>
            </div>
            <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
              <span>{timeAgo}</span>
              {conversation.git_branch && (
                <span className="flex items-center gap-0.5 truncate">
                  <GitBranch className="h-3 w-3 shrink-0" />
                  <span className="truncate">{conversation.git_branch}</span>
                </span>
              )}
            </div>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {onNewConversation && (
            <>
              <ContextMenuItem onSelect={onNewConversation}>
                <Plus className="h-4 w-4" />
                {t("newConversation")}
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          )}
          <ContextMenuItem onSelect={handleRenameOpen}>
            <Pencil className="h-4 w-4" />
            {t("rename")}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <Circle className="h-4 w-4" />
              {t("status")}
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              {ALL_STATUSES.filter((s) => s !== conversation.status).map(
                (s) => (
                  <ContextMenuItem
                    key={s}
                    onSelect={() => onStatusChange(conversation.id, s)}
                  >
                    <span
                      className={cn(
                        "w-2 h-2 rounded-full shrink-0",
                        STATUS_COLORS[s]
                      )}
                    />
                    {tStatus(s)}
                  </ContextMenuItem>
                )
              )}
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuSeparator />
          <ContextMenuItem
            variant="destructive"
            onSelect={() => setDeleteOpen(true)}
          >
            <Trash2 className="h-4 w-4" />
            {t("delete")}
          </ContextMenuItem>
          {onImport && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem disabled={importing} onSelect={onImport}>
                <Download className="h-4 w-4" />
                {importing ? t("importing") : t("importLocalSessions")}
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("renameConversation")}</DialogTitle>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.key === "Process") return
              if (e.key === "Enter") handleRenameConfirm()
            }}
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameOpen(false)}>
              {t("cancel")}
            </Button>
            <Button onClick={handleRenameConfirm}>{t("save")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteConversationTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("deleteConversationDescription", {
                title: conversation.title || t("untitledConversation"),
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteConfirm}>
              {t("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
})
