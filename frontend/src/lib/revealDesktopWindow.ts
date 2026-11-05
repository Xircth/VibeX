import { getAppRouteMode } from '@/appRouteMode';
import { isTauriDesktopShell } from '@/utils/platform';

export const REVEAL_RETRY_DELAYS_MS = [0, 80, 250] as const;

async function fallbackRevealMainWindow(): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('reveal_main_window');
}

export async function revealDesktopWindow(): Promise<void> {
  if (!isTauriDesktopShell()) return;
  if (getAppRouteMode(window.location.pathname) === 'desktop-toast') return;

  let current: {
    show: () => Promise<void>;
    setFocus: () => Promise<void>;
  } | null = null;
  let showError: unknown = null;

  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    current = getCurrentWindow();
    await current.show();
  } catch (err) {
    showError = err;
  }

  if (showError !== null) {
    try {
      await fallbackRevealMainWindow();
    } catch (fallbackErr) {
      throw fallbackErr ?? showError;
    }
  }

  if (current) {
    try {
      await current.setFocus();
    } catch (focusErr) {
      console.warn(
        '[revealDesktopWindow] Window shown, but setFocus failed:',
        focusErr
      );
    }
  }
}

export async function revealDesktopWindowWithRetry(
  delays: readonly number[] = REVEAL_RETRY_DELAYS_MS,
  shouldCancel?: () => boolean
): Promise<boolean> {
  if (!isTauriDesktopShell()) return false;
  if (getAppRouteMode(window.location.pathname) === 'desktop-toast') {
    return false;
  }

  let lastError: unknown = null;
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (shouldCancel?.()) return false;
    const delayMs = delays[attempt] ?? 0;
    if (delayMs > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, delayMs);
      });
      if (shouldCancel?.()) return false;
    }

    try {
      await revealDesktopWindow();
      return true;
    } catch (err) {
      lastError = err;
    }
  }

  if (!shouldCancel?.() && lastError !== null) {
    console.warn(
      '[revealDesktopWindow] Failed to reveal desktop window after retries; relying on native fallback:',
      lastError
    );
  }
  return false;
}

export function revealDesktopWindowAfterPaint(
  delays: readonly number[] = REVEAL_RETRY_DELAYS_MS
): () => void {
  if (!isTauriDesktopShell()) return () => undefined;
  if (getAppRouteMode(window.location.pathname) === 'desktop-toast') {
    return () => undefined;
  }

  let cancelled = false;
  let innerFrame = 0;
  const outerFrame = requestAnimationFrame(() => {
    if (cancelled) return;
    innerFrame = requestAnimationFrame(() => {
      if (cancelled) return;
      void revealDesktopWindowWithRetry(delays, () => cancelled);
    });
  });

  return () => {
    cancelled = true;
    cancelAnimationFrame(outerFrame);
    if (innerFrame) {
      cancelAnimationFrame(innerFrame);
    }
  };
}
