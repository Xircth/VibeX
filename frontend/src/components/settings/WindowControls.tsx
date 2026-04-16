import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { cn } from '@/lib/utils';

export function WindowControls() {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    let disposed = false;
    let unlistenResize: (() => void) | null = null;
    let resizeFrame: number | null = null;
    const appWindow = getCurrentWindow();

    const syncMaximized = async () => {
      try {
        const maximized = await appWindow.isMaximized();
        if (!disposed) {
          setIsMaximized(maximized);
        }
      } catch {
        if (!disposed) {
          setIsMaximized(false);
        }
      }
    };

    const scheduleSync = () => {
      if (resizeFrame !== null) return;
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = null;
        void syncMaximized();
      });
    };

    void syncMaximized();

    appWindow
      .onResized(() => {
        scheduleSync();
      })
      .then((unlisten) => {
        unlistenResize = unlisten;
      })
      .catch(() => {
        unlistenResize = null;
      });

    return () => {
      disposed = true;
      if (resizeFrame !== null) {
        window.cancelAnimationFrame(resizeFrame);
      }
      if (unlistenResize) {
        unlistenResize();
      }
    };
  }, []);

  const appWindow = getCurrentWindow();

  return (
    <div className="flex h-8 items-stretch [-webkit-app-region:no-drag]">
      <button
        type="button"
        className={buttonClass}
        onClick={() => {
          appWindow.minimize().catch(() => {});
        }}
        aria-label="Minimize"
        title="Minimize"
      >
        <MinimizeIcon />
      </button>
      <button
        type="button"
        className={buttonClass}
        onClick={() => {
          appWindow.toggleMaximize().catch(() => {});
        }}
        aria-label={isMaximized ? 'Restore' : 'Maximize'}
        title={isMaximized ? 'Restore' : 'Maximize'}
      >
        {isMaximized ? <RestoreIcon /> : <MaximizeIcon />}
      </button>
      <button
        type="button"
        className={cn(
          buttonClass,
          'hover:bg-[#e81123] hover:text-white active:bg-[#c50f1f] active:text-white'
        )}
        onClick={() => {
          appWindow.close().catch(() => {});
        }}
        aria-label="Close"
        title="Close"
      >
        <CloseIcon />
      </button>
    </div>
  );
}

const buttonClass =
  'flex h-8 w-[46px] items-center justify-center text-foreground/85 transition-colors duration-75 hover:bg-foreground/10 active:bg-foreground/15';

function MinimizeIcon() {
  return (
    <span
      aria-hidden
      className="inline-block h-px w-[10px] translate-y-[2px] bg-current"
    />
  );
}

function MaximizeIcon() {
  return (
    <span
      aria-hidden
      className="inline-block h-[10px] w-[10px] border border-current"
    />
  );
}

function RestoreIcon() {
  return (
    <span aria-hidden className="relative inline-block h-[10px] w-[10px]">
      <span className="absolute right-0 top-0 h-[7px] w-[7px] border border-current" />
      <span className="absolute bottom-0 left-0 h-[7px] w-[7px] border border-current" />
    </span>
  );
}

function CloseIcon() {
  return (
    <span aria-hidden className="relative inline-block h-[10px] w-[10px]">
      <span className="absolute left-1/2 top-0 h-[10px] w-px -translate-x-1/2 rotate-45 bg-current" />
      <span className="absolute left-1/2 top-0 h-[10px] w-px -translate-x-1/2 -rotate-45 bg-current" />
    </span>
  );
}
