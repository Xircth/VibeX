import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { WindowControls } from './WindowControls'

interface AppTitleBarProps {
  left?: ReactNode
  center?: ReactNode
  right?: ReactNode
  className?: string
  showWindowControls?: boolean
}

export function AppTitleBar({
  left,
  center,
  right,
  className,
  showWindowControls = true,
}: AppTitleBarProps) {
  // On Windows, always show window controls since we use decorations: false
  const isWindows = navigator.platform.toLowerCase().includes('win')

  return (
    <div
      className={cn(
        'relative h-8 shrink-0 border-b bg-muted/70 select-none',
        className
      )}
    >
      {/* Drag region */}
      <div data-tauri-drag-region className="absolute inset-0" />

      {/* Left + Right content */}
      <div
        data-tauri-drag-region
        className={cn(
          'relative z-10 flex h-full items-center px-3',
          isWindows && showWindowControls && 'pr-[138px]'
        )}
      >
        <div className="min-w-0 flex-1">{left}</div>
        {right ? (
          <div
            className={cn(
              'ml-auto shrink-0',
              isWindows && showWindowControls && 'mr-4'
            )}
          >
            {right}
          </div>
        ) : null}
      </div>

      {/* Center content (absolute positioned) */}
      {center ? (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
          <div>{center}</div>
        </div>
      ) : null}

      {/* Windows controls */}
      {showWindowControls && isWindows ? (
        <div className="absolute right-0 top-0 z-30">
          <WindowControls />
        </div>
      ) : null}
    </div>
  )
}
