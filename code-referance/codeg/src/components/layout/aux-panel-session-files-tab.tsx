"use client"

import { useMemo, useState } from "react"
import { ChevronRight, FileIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { useFolderContext } from "@/contexts/folder-context"
import { useTabContext } from "@/contexts/tab-context"
import { useConversationRuntime } from "@/contexts/conversation-runtime-context"
import { useWorkspaceContext } from "@/contexts/workspace-context"
import { useConversationDetail } from "@/hooks/use-conversation-detail"
import { extractSessionFilesGrouped } from "@/lib/session-files"
import {
  CommitFileAdditions,
  CommitFileDeletions,
} from "@/components/ai-elements/commit"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"

function isRemovedFileDiff(diff: string | null): boolean {
  if (!diff) return false

  return (
    /^\*\*\* Delete File:\s+/m.test(diff) ||
    /^deleted file mode\b/m.test(diff) ||
    /^\+\+\+\s+\/dev\/null$/m.test(diff)
  )
}

function normalizeSlashPath(path: string): string {
  return path.replace(/\\/g, "/")
}

function toFolderRelativePath(filePath: string, folderPath?: string): string {
  const normalizedFilePath = normalizeSlashPath(filePath)
  if (!folderPath) return normalizedFilePath

  const normalizedFolderPath = normalizeSlashPath(folderPath).replace(
    /\/+$/,
    ""
  )
  if (!normalizedFolderPath) return normalizedFilePath

  const folderPrefix = `${normalizedFolderPath}/`
  if (normalizedFilePath.startsWith(folderPrefix)) {
    return normalizedFilePath.slice(folderPrefix.length)
  }

  return normalizedFilePath
}

function SessionFilesContent({ conversationId }: { conversationId: number }) {
  const t = useTranslations("Folder.sessionFiles")
  const { loading } = useConversationDetail(conversationId)
  const { getTimelineTurns } = useConversationRuntime()
  const { openSessionFileDiff } = useWorkspaceContext()
  const { folder } = useFolderContext()
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({})

  const turns = useMemo(
    () => getTimelineTurns(conversationId).map((item) => item.turn),
    [conversationId, getTimelineTurns]
  )
  const groups = useMemo(
    () => (turns.length > 0 ? extractSessionFilesGrouped(turns) : []),
    [turns]
  )

  const handleFileClick = (
    filePath: string,
    diffContent: string | null,
    groupIndex: number,
    changeIndex: number
  ) => {
    openSessionFileDiff(
      filePath,
      diffContent ?? t("noDiffDataAvailable", { filePath }),
      `msg-${groupIndex + 1}-chg-${changeIndex + 1}`
    )
  }

  if (loading && groups.length === 0) {
    return (
      <div className="flex items-center justify-center h-full p-4">
        <p className="text-xs text-muted-foreground text-center">
          {t("loading")}
        </p>
      </div>
    )
  }

  if (groups.length === 0) {
    return (
      <div className="flex items-center justify-center h-full p-4">
        <p className="text-xs text-muted-foreground text-center">
          {t("noFileChangesInConversation")}
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-3 p-3">
      {groups.map((group, groupIndex) => {
        const groupKey = `${group.userTurnId}-${group.timestamp}-${groupIndex}`
        const isOpen = openGroups[groupKey] ?? false
        const totalAdditions = group.files.reduce(
          (sum, f) => sum + f.additions,
          0
        )
        const totalDeletions = group.files.reduce(
          (sum, f) => sum + f.deletions,
          0
        )
        const uniqueFileCount = new Set(
          group.files.map((file) => file.path.replace(/\\/g, "/"))
        ).size

        return (
          <Collapsible
            key={groupKey}
            className="overflow-hidden rounded-xl border border-border bg-card text-card-foreground"
            open={isOpen}
            onOpenChange={(open) =>
              setOpenGroups((prev) => ({
                ...prev,
                [groupKey]: open,
              }))
            }
          >
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="flex w-full items-start gap-3 px-3 py-3 text-left transition-colors hover:bg-accent/40"
              >
                <span
                  className={cn(
                    "mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-md border border-border bg-muted/30 text-muted-foreground transition-colors",
                    isOpen && "bg-accent text-accent-foreground"
                  )}
                >
                  <ChevronRight
                    className={cn(
                      "h-3.5 w-3.5 transition-transform",
                      isOpen && "rotate-90"
                    )}
                  />
                </span>
                <div className="flex-1 min-w-0">
                  <p className="line-clamp-1 text-xs leading-5 text-foreground">
                    {group.userMessage}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <span className="rounded-md border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {t("changeCount", { count: group.files.length })}
                    </span>
                    <span className="rounded-md border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {t("fileCount", { count: uniqueFileCount })}
                    </span>
                    <span className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-foreground">
                      <CommitFileAdditions
                        count={totalAdditions}
                        className="text-[10px]"
                      />
                      <CommitFileDeletions
                        count={totalDeletions}
                        className="text-[10px]"
                      />
                    </span>
                  </div>
                </div>
                <span className="mt-0.5 shrink-0 rounded-md border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
                  #{groupIndex + 1}
                </span>
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent className="border-t border-border bg-card">
              <ul className="space-y-2 p-3">
                {group.files.map((file, fileIndex) => {
                  const normalizedDisplayPath = toFolderRelativePath(
                    file.path,
                    folder?.path
                  )
                  const lastSlash = normalizedDisplayPath.lastIndexOf("/")
                  const fileName =
                    lastSlash >= 0
                      ? normalizedDisplayPath.slice(lastSlash + 1)
                      : normalizedDisplayPath
                  const isRemoved = isRemovedFileDiff(file.diff)

                  return (
                    <li key={file.id}>
                      <button
                        type="button"
                        className={cn(
                          "flex w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left min-w-0",
                          isRemoved
                            ? "border-destructive/30 bg-destructive/10 cursor-not-allowed"
                            : "border-border bg-card transition-colors hover:bg-accent/40"
                        )}
                        disabled={isRemoved}
                        onClick={
                          isRemoved
                            ? undefined
                            : () =>
                                handleFileClick(
                                  file.path,
                                  file.diff,
                                  groupIndex,
                                  fileIndex
                                )
                        }
                        title={normalizedDisplayPath}
                      >
                        <FileIcon
                          className={cn(
                            "h-3.5 w-3.5 shrink-0",
                            isRemoved
                              ? "text-destructive"
                              : "text-muted-foreground"
                          )}
                        />
                        <p
                          className={cn(
                            "min-w-0 flex-1 truncate text-xs",
                            isRemoved ? "text-destructive" : "text-foreground"
                          )}
                        >
                          {fileName}
                        </p>
                        {isRemoved ? (
                          <span className="inline-flex shrink-0 items-center rounded-md border border-destructive/30 bg-destructive/10 px-1.5 py-0.5 font-mono text-[10px] text-destructive">
                            {t("remove")}
                          </span>
                        ) : (
                          <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-foreground">
                            <CommitFileAdditions
                              count={file.additions}
                              className="text-[10px]"
                            />
                            <CommitFileDeletions
                              count={file.deletions}
                              className="text-[10px]"
                            />
                          </span>
                        )}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        )
      })}
    </div>
  )
}

export function SessionFilesTab() {
  const t = useTranslations("Folder.sessionFiles")
  const { tabs, activeTabId } = useTabContext()

  const activeTab = tabs.find((t) => t.id === activeTabId)
  const conversationId =
    activeTab?.runtimeConversationId ?? activeTab?.conversationId

  if (!activeTab) {
    return (
      <div className="flex items-center justify-center h-full p-4">
        <p className="text-xs text-muted-foreground text-center">
          {t("openConversationToSeeChanges")}
        </p>
      </div>
    )
  }

  if (!conversationId) {
    return (
      <div className="flex items-center justify-center h-full p-4">
        <p className="text-xs text-muted-foreground text-center">
          {t("noFileChangesInConversation")}
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 min-h-0 overflow-y-auto">
        <SessionFilesContent conversationId={conversationId} />
      </div>
    </div>
  )
}
