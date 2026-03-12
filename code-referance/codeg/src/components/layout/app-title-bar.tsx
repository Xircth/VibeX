"use client"

import type { ReactNode } from "react"
import { usePlatform } from "@/hooks/use-platform"
import { cn } from "@/lib/utils"
import { WindowControls } from "./window-controls"

interface AppTitleBarProps {
  left?: ReactNode
  center?: ReactNode
  right?: ReactNode
  className?: string
  rowClassName?: string
  centerInteractive?: boolean
  showWindowControls?: boolean
}

export function AppTitleBar({
  left,
  center,
  right,
  className,
  rowClassName,
  centerInteractive = false,
  showWindowControls = true,
}: AppTitleBarProps) {
  const { isMac, isWindows } = usePlatform()

  const rowPadding = cn(
    "px-3",
    isMac && "pl-[76px]",
    isWindows && showWindowControls && "pr-[138px]"
  )

  return (
    <div
      className={cn(
        "relative h-8 shrink-0 border-b bg-muted/70 select-none",
        className
      )}
    >
      <div data-tauri-drag-region className="absolute inset-0" />

      <div
        data-tauri-drag-region
        className={cn(
          "relative z-10 flex h-full items-center",
          rowPadding,
          rowClassName
        )}
      >
        <div className="min-w-0 flex-1">{left}</div>
        {right ? (
          <div
            className={cn(
              "ml-auto shrink-0",
              isWindows && showWindowControls && "mr-4"
            )}
          >
            {right}
          </div>
        ) : null}
      </div>

      {center ? (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
          <div className={cn(centerInteractive && "pointer-events-auto")}>
            {center}
          </div>
        </div>
      ) : null}

      {showWindowControls && isWindows ? (
        <div className="absolute right-0 top-0 z-30">
          <WindowControls />
        </div>
      ) : null}
    </div>
  )
}
