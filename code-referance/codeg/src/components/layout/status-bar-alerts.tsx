"use client"

import { CircleAlert, X, Trash2 } from "lucide-react"
import { useTranslations } from "next-intl"
import {
  useAlertContext,
  type AlertLevel,
  type AlertAction,
} from "@/contexts/alert-context"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { useAcpActions } from "@/contexts/acp-connections-context"
import { openUrl } from "@tauri-apps/plugin-opener"
import { openSettingsWindow } from "@/lib/tauri"
import { AGENT_LABELS, type AgentType } from "@/lib/types"

const KNOWN_AGENT_TYPES = new Set<AgentType>(
  Object.keys(AGENT_LABELS) as AgentType[]
)

function parseAgentType(value: unknown): AgentType | null {
  if (typeof value !== "string") return null
  return KNOWN_AGENT_TYPES.has(value as AgentType) ? (value as AgentType) : null
}

function parseOpenAgentsSettingsPayload(payload: string): {
  agentType: AgentType | null
} {
  const normalized = payload.trim()
  if (!normalized || normalized === "agents") {
    return { agentType: null }
  }

  try {
    const parsed = JSON.parse(normalized)
    if (!parsed || typeof parsed !== "object") {
      return { agentType: null }
    }
    return {
      agentType: parseAgentType(
        (parsed as { agentType?: unknown }).agentType ?? null
      ),
    }
  } catch {
    return { agentType: null }
  }
}

function AlertLevelIcon({ level }: { level: AlertLevel }) {
  if (level === "error") {
    return <CircleAlert className="h-3 w-3 shrink-0 text-red-500" />
  }
  return <CircleAlert className="h-3 w-3 shrink-0 text-yellow-500" />
}

function AlertActionButton({ action }: { action: AlertAction }) {
  const { connect } = useAcpActions()

  const handleClick = async () => {
    switch (action.kind) {
      case "open_url":
        await openUrl(action.payload)
        break
      case "retry_connection": {
        try {
          const data = JSON.parse(action.payload)
          await connect(
            data.contextKey,
            data.agentType,
            data.workingDir,
            data.sessionId
          )
        } catch (e) {
          console.error("[AlertAction] retry_connection failed:", e)
        }
        break
      }
      case "redownload_binary": {
        try {
          const data = JSON.parse(action.payload)
          await connect(
            data.contextKey,
            data.agentType,
            data.workingDir,
            data.sessionId
          )
        } catch (e) {
          console.error("[AlertAction] redownload_binary failed:", e)
        }
        break
      }
      case "open_agents_settings":
        await openSettingsWindow("agents", {
          agentType: parseOpenAgentsSettingsPayload(action.payload).agentType,
        })
        break
    }
  }

  return (
    <button
      onClick={handleClick}
      className="text-[10px] px-1.5 py-0.5 rounded bg-accent hover:bg-accent/80 text-accent-foreground transition-colors"
    >
      {action.label}
    </button>
  )
}

export function StatusBarAlerts() {
  const t = useTranslations("Folder.statusBar.alerts")
  const { alerts, hasAlerts, dismissAlert, clearAll } = useAlertContext()

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className="flex items-center gap-1 hover:text-foreground transition-colors">
          <CircleAlert
            className={`size-3.5 ${hasAlerts ? "text-red-500" : ""}`}
          />
          {hasAlerts && <span className="text-red-500">{alerts.length}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-80 p-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium">{t("title")}</span>
          {hasAlerts && (
            <button
              onClick={clearAll}
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          )}
        </div>
        {!hasAlerts ? (
          <div className="text-xs text-muted-foreground py-2">{t("empty")}</div>
        ) : (
          <div className="space-y-2 max-h-56 overflow-y-auto">
            {alerts.map((alert) => (
              <div
                key={alert.id}
                className="flex items-start gap-2 text-xs group"
              >
                <AlertLevelIcon level={alert.level} />
                <div className="flex-1 min-w-0">
                  <div className="break-words">{alert.message}</div>
                  {alert.detail && (
                    <div className="text-[10px] text-muted-foreground mt-0.5 break-all whitespace-pre-wrap">
                      {alert.detail}
                    </div>
                  )}
                  {alert.actions && alert.actions.length > 0 && (
                    <div className="flex items-center gap-1 mt-1">
                      {alert.actions.map((action, i) => (
                        <AlertActionButton key={i} action={action} />
                      ))}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => dismissAlert(alert.id)}
                  className="shrink-0 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground transition-opacity"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
