import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from 'react';
import { cn } from '@/lib/utils';
import { isWindows } from '@/utils/platform';

interface AppTitleBarProps {
  left?: ReactNode;
  center?: ReactNode;
  right?: ReactNode;
  className?: string;
}

function isNoWindowDragTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      'button, a, input, textarea, select, [role="button"], [role="menuitem"], [role="combobox"]'
    )
  );
}

function startDesktopWindowDrag(): void {
  void import('@tauri-apps/api/window')
    .then(({ getCurrentWindow }) => getCurrentWindow().startDragging())
    .catch(() => undefined);
}

function toggleDesktopWindowMaximize(): void {
  void import('@tauri-apps/api/window')
    .then(({ getCurrentWindow }) => getCurrentWindow().toggleMaximize())
    .catch(() => undefined);
}

export function AppTitleBar({
  left,
  center,
  right,
  className,
}: AppTitleBarProps) {
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if (isNoWindowDragTarget(event.target)) return;
    if (!isWindows()) return;
    startDesktopWindowDrag();
  };

  const onDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (isNoWindowDragTarget(event.target)) return;
    if (!isWindows()) return;
    toggleDesktopWindowMaximize();
  };

  return (
    <div
      data-tauri-drag-region
      className={cn(
        'settings-titlebar window-chrome relative h-9 shrink-0 select-none text-foreground',
        className
      )}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
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
        <div
          data-tauri-drag-region
          className="pointer-events-none absolute left-1/2 top-1/2 z-20 -translate-x-1/2 -translate-y-1/2"
        >
          <div>{center}</div>
        </div>
      ) : null}
    </div>
  );
}
