"use client"

import { useMemo } from "react"
import { GitBranch } from "lucide-react"
import { useTabContext } from "@/contexts/tab-context"
import { useFolderContext } from "@/contexts/folder-context"

export function StatusBarSessionInfo() {
  const { tabs, activeTabId } = useTabContext()
  const { conversations } = useFolderContext()

  const activeTab = useMemo(
    () => tabs.find((t) => t.id === activeTabId) ?? null,
    [tabs, activeTabId]
  )

  const summary = useMemo(() => {
    if (!activeTab || activeTab.kind !== "conversation") return null
    return conversations.find(
      (c) =>
        c.id === activeTab.conversationId &&
        c.agent_type === activeTab.agentType
    )
  }, [activeTab, conversations])

  if (!summary) return null

  return (
    <div className="flex items-center gap-4">
      {summary.git_branch && (
        <span className="flex items-center gap-1">
          <GitBranch className="h-3 w-3" />
          {summary.git_branch}
        </span>
      )}
    </div>
  )
}
