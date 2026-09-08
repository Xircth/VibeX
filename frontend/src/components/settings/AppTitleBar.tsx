import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface AppTitleBarProps {
  left?: ReactNode;
  center?: ReactNode;
  right?: ReactNode;
  className?: string;
}

export function AppTitleBar({
  left,
  center,
  right,
  className,
}: AppTitleBarProps) {
  return (
    <div
      className={cn(
        'settings-titlebar window-chrome relative h-8 shrink-0 select-none text-foreground',
        className
      )}
    >
      <div data-tauri-drag-region className="absolute inset-0" />

      <div
        data-tauri-drag-region
        className="relative z-10 flex h-full items-center px-3"
      >
        <div className="min-w-0 flex-1">{left}</div>
        {right ? <div className="ml-auto shrink-0">{right}</div> : null}
      </div>

      {center ? (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
          <div>{center}</div>
        </div>
      ) : null}
    </div>
  );
}
