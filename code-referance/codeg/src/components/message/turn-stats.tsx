import type { TurnUsage } from "@/lib/types"

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function formatDuration(ms: number): string {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`
  return `${(ms / 1_000).toFixed(1)}s`
}

interface TurnStatsProps {
  usage?: TurnUsage | null
  duration_ms?: number | null
  model?: string | null
  models?: string[]
}

export function TurnStats({
  usage,
  duration_ms,
  model,
  models,
}: TurnStatsProps) {
  if (!usage && !duration_ms) return null

  const displayModels = models?.length ? models : model ? [model] : []

  const parts: string[] = []
  if (displayModels.length > 0) parts.push(displayModels.join(", "))
  if (usage) {
    parts.push(`${formatTokenCount(usage.input_tokens)} input`)
    parts.push(`${formatTokenCount(usage.output_tokens)} output`)
    if (usage.cache_read_input_tokens > 0)
      parts.push(
        `${formatTokenCount(usage.cache_read_input_tokens)} cache read`
      )
    if (usage.cache_creation_input_tokens > 0)
      parts.push(
        `${formatTokenCount(usage.cache_creation_input_tokens)} cache write`
      )
  }
  if (duration_ms) parts.push(formatDuration(duration_ms))

  return (
    <div className="text-xs text-muted-foreground mt-2">
      {"[ " + parts.join(" · ") + " ]"}
    </div>
  )
}
