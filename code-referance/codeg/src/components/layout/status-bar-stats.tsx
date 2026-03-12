"use client"

import { useMemo } from "react"
import { BarChart3 } from "lucide-react"
import { useTranslations } from "next-intl"
import { useFolderContext } from "@/contexts/folder-context"
import { AGENT_LABELS } from "@/lib/types"
import { AgentIcon } from "@/components/agent-icon"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

export function StatusBarStats() {
  const t = useTranslations("Folder.statusBar.stats")
  const { stats } = useFolderContext()

  const activeAgents = useMemo(
    () => stats?.by_agent.filter((a) => a.conversation_count > 0) ?? [],
    [stats]
  )

  if (!stats) return null

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className="flex items-center gap-1.5 hover:text-foreground transition-colors">
          <BarChart3 className="h-3 w-3" />
          <span>
            {t("conversations", { count: stats.total_conversations })}
          </span>
          <span className="flex items-center gap-1 ml-1">
            {activeAgents.map((a) => (
              <AgentIcon
                key={a.agent_type}
                agentType={a.agent_type}
                className="w-3 h-3"
              />
            ))}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-64 p-3">
        <div className="text-xs font-medium mb-2">
          {t("summary", {
            conversations: stats.total_conversations,
            messages: stats.total_messages,
          })}
        </div>
        <div className="space-y-1.5">
          {activeAgents.map((a) => (
            <div key={a.agent_type} className="flex items-center gap-2 text-xs">
              <AgentIcon agentType={a.agent_type} className="w-3.5 h-3.5" />
              <span className="text-muted-foreground">
                {AGENT_LABELS[a.agent_type]}
              </span>
              <span className="ml-auto text-muted-foreground">
                {a.conversation_count}
              </span>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
