"use client"

import { useState } from "react"
import { ChevronRight, ChevronDown, Wrench, AlertCircle } from "lucide-react"
import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"

interface ToolCallBlockProps {
  type: "tool_use" | "tool_result"
  toolName?: string
  content: string | null
  isError?: boolean
}

export function ToolCallBlock({
  type,
  toolName,
  content,
  isError = false,
}: ToolCallBlockProps) {
  const t = useTranslations("Folder.chat.toolCallBlock")
  const [expanded, setExpanded] = useState(false)

  return (
    <div
      className={cn(
        "border rounded-md text-xs",
        isError
          ? "border-destructive/30 bg-destructive/5"
          : "border-border bg-muted/30"
      )}
    >
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-muted/50 transition-colors"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0" />
        )}
        {type === "tool_use" ? (
          <>
            <Wrench className="h-3 w-3 shrink-0 text-muted-foreground" />
            <span className="font-medium">{toolName || t("tool")}</span>
          </>
        ) : (
          <>
            {isError ? (
              <AlertCircle className="h-3 w-3 shrink-0 text-destructive" />
            ) : (
              <Wrench className="h-3 w-3 shrink-0 text-muted-foreground" />
            )}
            <span className="font-medium">
              {isError ? t("error") : t("result")}
            </span>
          </>
        )}
      </button>
      {expanded && content && (
        <div className="px-3 pb-2 border-t border-border">
          <pre className="text-xs text-muted-foreground whitespace-pre-wrap break-all mt-2 max-h-64 overflow-auto">
            {content}
          </pre>
        </div>
      )}
    </div>
  )
}
