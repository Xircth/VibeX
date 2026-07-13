import { useCallback } from 'react';
import { useOptionalUserSystem } from '@/components/ConfigProvider';
import { useOptionalPanelActionsContext } from '@/contexts/PanelActionsContext';

/** Opens a URL with the system default browser (Tauri shell, window fallback). */
export async function openInSystemBrowser(url: string): Promise<void> {
  try {
    const { open } = await import('@tauri-apps/plugin-shell');
    await open(url);
  } catch {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

/**
 * Returns a click handler that opens external links according to the user's
 * configured link_open_behavior: the system default browser, or the built-in
 * Web Preview panel. Falls back to the system browser when no panel context
 * (or config) is available.
 */
export function useOpenLink(): (url: string) => void {
  const userSystem = useOptionalUserSystem();
  const panelActions = useOptionalPanelActionsContext();
  const behavior = userSystem?.config?.link_open_behavior ?? 'ExternalBrowser';

  return useCallback(
    (url: string) => {
      if (behavior === 'BuiltinPreview' && panelActions) {
        panelActions.openWebPreview(url);
        return;
      }
      void openInSystemBrowser(url);
    },
    [behavior, panelActions]
  );
}
