"use client"

import type { ComponentProps, HTMLAttributes } from "react"
import Ansi from "ansi-to-react"
import { CheckIcon, CopyIcon, TerminalIcon, Trash2Icon } from "lucide-react"
import { useTranslations } from "next-intl"
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { Shimmer } from "./shimmer"

interface TerminalContextType {
  output: string
  isStreaming: boolean
  autoScroll: boolean
  onClear?: () => void
}

const TerminalContext = createContext<TerminalContextType>({
  output: "",
  isStreaming: false,
  autoScroll: true,
})

function normalizeTerminalOutput(output: string): string {
  if (!output) return output

  // Some runtimes deliver ANSI escapes as literal "\\u001b"/"\\x1b".
  // Decode them so ansi-to-react can apply terminal colors.
  const hasEscapedAnsi =
    output.includes("\\u001b") ||
    output.includes("\\u001B") ||
    output.includes("\\x1b") ||
    output.includes("\\x1B") ||
    output.includes("\\u009b") ||
    output.includes("\\u009B")

  if (!hasEscapedAnsi) return output

  return output
    .replace(/\\u001b/gi, "\u001b")
    .replace(/\\x1b/gi, "\u001b")
    .replace(/\\u009b/gi, "\u009b")
}

export type TerminalProps = HTMLAttributes<HTMLDivElement> & {
  output: string
  isStreaming?: boolean
  autoScroll?: boolean
  onClear?: () => void
}

export function Terminal({
  output,
  isStreaming = false,
  autoScroll = true,
  onClear,
  className,
  children,
  ...props
}: TerminalProps) {
  const contextValue = useMemo(
    () => ({ output, isStreaming, autoScroll, onClear }),
    [output, isStreaming, autoScroll, onClear]
  )

  return (
    <TerminalContext.Provider value={contextValue}>
      <div
        className={cn(
          "flex flex-col overflow-hidden rounded-lg border border-border bg-card text-card-foreground",
          className
        )}
        {...props}
      >
        {children ?? (
          <>
            <TerminalHeader>
              <TerminalTitle />
              <div className="flex items-center gap-1">
                <TerminalStatus />
                <TerminalActions>
                  <TerminalCopyButton />
                  {onClear && <TerminalClearButton />}
                </TerminalActions>
              </div>
            </TerminalHeader>
            <TerminalContent />
          </>
        )}
      </div>
    </TerminalContext.Provider>
  )
}

export type TerminalHeaderProps = HTMLAttributes<HTMLDivElement>

export function TerminalHeader({
  className,
  children,
  ...props
}: TerminalHeaderProps) {
  return (
    <div
      className={cn(
        "flex items-center justify-between border-b border-border bg-muted/30 px-4 py-2",
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
}

export type TerminalTitleProps = HTMLAttributes<HTMLDivElement>

export function TerminalTitle({
  className,
  children,
  ...props
}: TerminalTitleProps) {
  const t = useTranslations("Folder.chat.terminal")
  return (
    <div
      className={cn(
        "flex items-center gap-2 text-sm text-muted-foreground",
        className
      )}
      {...props}
    >
      <TerminalIcon className="size-4" />
      {children ?? t("title")}
    </div>
  )
}

export type TerminalStatusProps = HTMLAttributes<HTMLDivElement>

export function TerminalStatus({
  className,
  children,
  ...props
}: TerminalStatusProps) {
  const t = useTranslations("Folder.chat.terminal")
  const { isStreaming } = useContext(TerminalContext)

  if (!isStreaming) {
    return null
  }

  return (
    <div
      className={cn(
        "flex items-center gap-2 text-xs text-muted-foreground",
        className
      )}
      {...props}
    >
      {children ?? <Shimmer>{t("running")}</Shimmer>}
    </div>
  )
}

export type TerminalActionsProps = HTMLAttributes<HTMLDivElement>

export function TerminalActions({
  className,
  children,
  ...props
}: TerminalActionsProps) {
  return (
    <div className={cn("flex items-center gap-1", className)} {...props}>
      {children}
    </div>
  )
}

export type TerminalCopyButtonProps = ComponentProps<typeof Button> & {
  onCopy?: () => void
  onError?: (error: Error) => void
  timeout?: number
}

export function TerminalCopyButton({
  onCopy,
  onError,
  timeout = 2000,
  children,
  className,
  ...props
}: TerminalCopyButtonProps) {
  const [isCopied, setIsCopied] = useState(false)
  const timeoutRef = useRef<number>(0)
  const { output } = useContext(TerminalContext)

  const copyToClipboard = useCallback(async () => {
    if (typeof window === "undefined" || !navigator?.clipboard?.writeText) {
      onError?.(new Error("Clipboard API not available"))
      return
    }

    try {
      await navigator.clipboard.writeText(output)
      setIsCopied(true)
      onCopy?.()
      timeoutRef.current = window.setTimeout(() => setIsCopied(false), timeout)
    } catch (error) {
      onError?.(error as Error)
    }
  }, [output, onCopy, onError, timeout])

  useEffect(
    () => () => {
      window.clearTimeout(timeoutRef.current)
    },
    []
  )

  const Icon = isCopied ? CheckIcon : CopyIcon

  return (
    <Button
      className={cn(
        "size-7 shrink-0 text-muted-foreground hover:bg-accent hover:text-accent-foreground",
        className
      )}
      onClick={copyToClipboard}
      size="icon"
      variant="ghost"
      {...props}
    >
      {children ?? <Icon size={14} />}
    </Button>
  )
}

export type TerminalClearButtonProps = ComponentProps<typeof Button>

export function TerminalClearButton({
  children,
  className,
  ...props
}: TerminalClearButtonProps) {
  const { onClear } = useContext(TerminalContext)

  if (!onClear) {
    return null
  }

  return (
    <Button
      className={cn(
        "size-7 shrink-0 text-muted-foreground hover:bg-accent hover:text-accent-foreground",
        className
      )}
      onClick={onClear}
      size="icon"
      variant="ghost"
      {...props}
    >
      {children ?? <Trash2Icon size={14} />}
    </Button>
  )
}

export type TerminalContentProps = HTMLAttributes<HTMLDivElement>

export function TerminalContent({
  className,
  children,
  ...props
}: TerminalContentProps) {
  const { output, isStreaming, autoScroll } = useContext(TerminalContext)
  const normalizedOutput = useMemo(
    () => normalizeTerminalOutput(output),
    [output]
  )
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight
    }
  }, [output, autoScroll])

  return (
    <div
      className={cn(
        "max-h-96 overflow-auto p-4 font-mono text-sm leading-relaxed",
        className
      )}
      ref={containerRef}
      {...props}
    >
      {children ?? (
        <pre className="whitespace-pre-wrap break-words">
          <Ansi>{normalizedOutput}</Ansi>
          {isStreaming && (
            <span className="ml-0.5 inline-block h-4 w-2 animate-pulse bg-foreground" />
          )}
        </pre>
      )}
    </div>
  )
}
