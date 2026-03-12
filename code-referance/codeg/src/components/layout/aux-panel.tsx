"use client"

import { useCallback, useState } from "react"
import { FileDiff, Folder, FolderPen, GitCommit } from "lucide-react"
import { useTranslations } from "next-intl"
import {
  useAuxPanelContext,
  type AuxPanelTab,
} from "@/contexts/aux-panel-context"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { FileTreeTab } from "./aux-panel-file-tree-tab"
import { GitChangesTab } from "./aux-panel-git-changes-tab"
import { GitLogTab } from "./aux-panel-git-log-tab"
import { SessionFilesTab } from "./aux-panel-session-files-tab"

export function AuxPanel() {
  const t = useTranslations("Folder.auxPanel.tabs")
  const { isOpen, activeTab, setActiveTab } = useAuxPanelContext()
  const [hasMountedFileTree, setHasMountedFileTree] = useState(
    activeTab === "file_tree"
  )
  const [hasMountedChanges, setHasMountedChanges] = useState(
    activeTab === "changes"
  )
  const [hasMountedGitLog, setHasMountedGitLog] = useState(
    activeTab === "git_log"
  )

  const handleTabValueChange = useCallback(
    (value: string) => {
      const nextTab = value as AuxPanelTab
      setActiveTab(nextTab)
      if (nextTab === "file_tree") {
        setHasMountedFileTree(true)
      }
      if (nextTab === "changes") {
        setHasMountedChanges(true)
      }
      if (nextTab === "git_log") {
        setHasMountedGitLog(true)
      }
    },
    [setActiveTab]
  )

  if (!isOpen) return null

  return (
    <aside className="group/aux-panel flex h-full min-h-0 flex-col overflow-hidden bg-sidebar text-sidebar-foreground select-none">
      <Tabs
        value={activeTab}
        onValueChange={handleTabValueChange}
        className="flex h-full flex-col gap-0"
      >
        <TabsList
          variant="line"
          className="h-10 w-full shrink-0 justify-start border-b border-border px-3 group-data-horizontal/tabs:h-10"
        >
          <TabsTrigger
            value="session_files"
            title={t("diff")}
            aria-label={t("diff")}
          >
            <FileDiff className="h-3.5 w-3.5" />
          </TabsTrigger>
          <TabsTrigger
            value="file_tree"
            title={t("files")}
            aria-label={t("files")}
          >
            <Folder className="h-3.5 w-3.5" />
          </TabsTrigger>
          <TabsTrigger
            value="changes"
            title={t("changes")}
            aria-label={t("changes")}
          >
            <FolderPen className="h-3.5 w-3.5" />
          </TabsTrigger>
          <TabsTrigger
            value="git_log"
            title={t("commits")}
            aria-label={t("commits")}
          >
            <GitCommit className="h-3.5 w-3.5" />
          </TabsTrigger>
        </TabsList>

        <TabsContent
          value="session_files"
          className="mt-0 flex-1 min-h-0 overflow-hidden"
        >
          <SessionFilesTab />
        </TabsContent>
        <TabsContent
          value="file_tree"
          forceMount
          className="mt-0 flex-1 min-h-0 overflow-hidden"
        >
          {hasMountedFileTree ? <FileTreeTab /> : null}
        </TabsContent>
        <TabsContent
          value="changes"
          forceMount
          className="mt-0 flex-1 min-h-0 overflow-hidden"
        >
          {hasMountedChanges ? <GitChangesTab /> : null}
        </TabsContent>
        <TabsContent
          value="git_log"
          forceMount
          className="mt-0 flex-1 min-h-0 overflow-hidden"
        >
          {hasMountedGitLog ? <GitLogTab /> : null}
        </TabsContent>
      </Tabs>
    </aside>
  )
}
