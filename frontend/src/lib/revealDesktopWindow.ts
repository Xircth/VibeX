import { getAppRouteMode } from '@/appRouteMode';
import { isTauriDesktopShell } from '@/utils/platform';

export async function revealDesktopWindow(): Promise<void> {
  if (!isTauriDesktopShell()) return;
  if (getAppRouteMode(window.location.pathname) === 'desktop-toast') return;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  const current = getCurrentWindow();
  await current.show();
  await current.setFocus();
}

export function revealDesktopWindowAfterPaint(): () => void {
  if (!isTauriDesktopShell()) return () => undefined;
  if (getAppRouteMode(window.location.pathname) === 'desktop-toast') {
    return () => undefined;
  }

  let cancelled = false;
  const frame = requestAnimationFrame(() => {
    if (cancelled) return;
    void revealDesktopWindow().catch(() => {
      // Native fallback in src-tauri shows the window if this paint never runs.
    });
  });

  return () => {
    cancelled = true;
    cancelAnimationFrame(frame);
  };
}
