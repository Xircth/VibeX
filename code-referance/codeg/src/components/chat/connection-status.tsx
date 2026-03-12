import type { ConnectionStatus } from "@/lib/types"
import { cn } from "@/lib/utils"

const STATUS_CONFIG: Record<string, { color: string; label: string }> = {
  connected: { color: "bg-green-500", label: "Agent connected" },
  connecting: {
    color: "bg-blue-500 animate-pulse",
    label: "Connecting...",
  },
  prompting: {
    color: "bg-yellow-500 animate-pulse",
    label: "Agent responding...",
  },
  error: { color: "bg-red-500", label: "Connection error" },
}

interface ConnectionStatusIndicatorProps {
  status: ConnectionStatus | null | undefined
}

export function ConnectionStatusIndicator({
  status,
}: ConnectionStatusIndicatorProps) {
  if (!status || status === "disconnected") return null

  const config = STATUS_CONFIG[status]
  if (!config) return null

  return (
    <div className="px-4 py-1 text-xs text-muted-foreground border-t border-border flex items-center gap-1.5">
      <span
        className={cn("inline-block h-1.5 w-1.5 rounded-full", config.color)}
      />
      {config.label}
    </div>
  )
}
