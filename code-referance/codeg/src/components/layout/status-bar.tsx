"use client"

import { StatusBarStats } from "@/components/layout/status-bar-stats"
import { StatusBarSessionInfo } from "@/components/layout/status-bar-session-info"
import { StatusBarTasks } from "@/components/layout/status-bar-tasks"
import { StatusBarTokens } from "@/components/layout/status-bar-tokens"
import { StatusBarConnection } from "@/components/layout/status-bar-connection"
import { StatusBarAlerts } from "@/components/layout/status-bar-alerts"

export function StatusBar() {
  return (
    <div className="h-8 shrink-0 border-t border-border bg-muted px-4 flex items-center justify-between text-xs text-muted-foreground">
      <div className="flex items-center">
        <StatusBarStats />
      </div>
      <div className="flex items-center gap-4">
        <StatusBarTasks />
        <StatusBarSessionInfo />
        <StatusBarTokens />
        <StatusBarConnection />
        <StatusBarAlerts />
      </div>
    </div>
  )
}
