import { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { tauriInvoke, tauriListen } from '@/lib/tauriApi';

type DesktopToastKind = 'success' | 'error';

type DesktopToastPayload = {
  projectId: string;
  workspaceId: string;
  sessionId: string;
  title: string;
  description: string;
  kind: DesktopToastKind;
  durationMs?: number | null;
};

type DesktopToastItem = DesktopToastPayload & {
  id: string;
};

const DEFAULT_DURATION_MS = 15_000;

export function DesktopToastWindow() {
  const [toasts, setToasts] = useState<DesktopToastItem[]>([]);
  const timersRef = useRef(new Map<string, number>());

  const removeToast = useCallback((toastId: string) => {
    setToasts((previous) => previous.filter((toast) => toast.id !== toastId));

    const timer = timersRef.current.get(toastId);
    if (timer != null) {
      window.clearTimeout(timer);
      timersRef.current.delete(toastId);
    }
  }, []);

  const closeWindow = useCallback(async () => {
    await getCurrentWindow()
      .hide()
      .catch(() => {});
  }, []);

  const scheduleRemoval = useCallback(
    (toastId: string, durationMs?: number | null) => {
      const timeout = window.setTimeout(() => {
        removeToast(toastId);
      }, durationMs ?? DEFAULT_DURATION_MS);
      timersRef.current.set(toastId, timeout);
    },
    [removeToast]
  );

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const timers = timersRef.current;

    tauriListen<DesktopToastPayload>('desktop-toast', (payload) => {
      const toastId = `${payload.sessionId}-${Date.now()}`;
      setToasts((previous) => [
        ...previous,
        {
          ...payload,
          id: toastId,
        },
      ]);
      scheduleRemoval(toastId, payload.durationMs);
    }).then((dispose) => {
      unlisten = dispose;
    });

    return () => {
      unlisten?.();
      timers.forEach((timer) => window.clearTimeout(timer));
      timers.clear();
    };
  }, [scheduleRemoval]);

  useEffect(() => {
    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';
    document.body.style.margin = '0';
    return () => {
      document.documentElement.style.background = '';
      document.body.style.background = '';
      document.body.style.margin = '';
    };
  }, []);

  useEffect(() => {
    if (toasts.length > 0) {
      return;
    }

    const timeout = window.setTimeout(() => {
      void closeWindow();
    }, 150);

    return () => window.clearTimeout(timeout);
  }, [closeWindow, toasts.length]);

  const handleActivate = useCallback(
    async (toast: DesktopToastItem) => {
      removeToast(toast.id);
      await tauriInvoke('activate_desktop_toast', {
        payload: {
          projectId: toast.projectId,
          workspaceId: toast.workspaceId,
          sessionId: toast.sessionId,
          title: toast.title,
          description: toast.description,
          kind: toast.kind,
          durationMs: toast.durationMs ?? DEFAULT_DURATION_MS,
        },
      }).catch(() => {});
    },
    [removeToast]
  );

  return (
    <div className="min-h-screen bg-transparent p-4">
      <div className="pointer-events-none flex min-h-screen items-end justify-end">
        <div className="flex w-[388px] flex-col gap-3">
          {toasts.map((toast) => (
            <div
              key={toast.id}
              className="pointer-events-auto relative overflow-hidden rounded-2xl border border-border bg-background/96 shadow-2xl backdrop-blur-md"
            >
              <button
                type="button"
                className="flex w-full flex-col gap-2 px-4 py-3 pr-10 text-left"
                onClick={() => void handleActivate(toast)}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={
                      toast.kind === 'error'
                        ? 'h-2.5 w-2.5 rounded-full bg-red-500'
                        : 'h-2.5 w-2.5 rounded-full bg-emerald-500 animate-pulse'
                    }
                  />
                  <span className="text-sm font-semibold text-foreground">
                    {toast.title}
                  </span>
                </div>
                <span className="line-clamp-2 text-xs text-muted-foreground">
                  {toast.description}
                </span>
                <span className="text-[11px] font-medium text-primary">
                  Click to open the related session
                </span>
              </button>
              <button
                type="button"
                className="absolute right-2 top-2 inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                aria-label="Close toast"
                onClick={() => removeToast(toast.id)}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
