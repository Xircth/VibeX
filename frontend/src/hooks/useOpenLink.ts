import { useCallback, useEffect, useMemo } from 'react';
import { useOptionalUserSystem } from '@/components/ConfigProvider';
import { toast } from '@/components/ui/toast';
import { useOptionalPanelActionsContext } from '@/contexts/PanelActionsContext';
import {
  getBrowserSettingsSnapshot,
  loadBrowserPrefs,
  resolveLinkOpenAction,
  type LinkOpenSource,
} from '@/features/host-browser/browserPrefsStore';
import {
  contributionMetadata,
  usePluginHostContributions,
} from '@/hooks/usePluginHostContributions';
import i18n from '@/i18n';

/** Opens a URL with the system default browser (Tauri shell, window fallback). */
export async function openInSystemBrowser(url: string): Promise<void> {
  try {
    const { open } = await import('@tauri-apps/plugin-shell');
    await open(url);
  } catch {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

export interface OpenLinkOptions {
  source?: LinkOpenSource;
  altKey?: boolean;
}

/**
 * Returns a click handler that opens external links according to the user's
 * browser settings (per-source routing + site rules) or `link_open_behavior`.
 * Falls back to the system browser when no panel context is available.
 */
export function useOpenLink(
  defaultSource: LinkOpenSource = 'transcript'
): (url: string, options?: OpenLinkOptions) => void {
  const userSystem = useOptionalUserSystem();
  const panelActions = useOptionalPanelActionsContext();
  const panels = usePluginHostContributions('app_panel');
  const browserPluginId = useMemo(
    () =>
      panels.find(
        (item) => contributionMetadata(item).engine === 'host-browser'
      )?.pluginId ?? null,
    [panels]
  );
  const behavior = userSystem?.config?.link_open_behavior ?? 'ExternalBrowser';

  useEffect(() => {
    if (browserPluginId) {
      void loadBrowserPrefs(browserPluginId);
    }
  }, [browserPluginId]);

  return useCallback(
    (url: string, options?: OpenLinkOptions) => {
      const source = options?.source ?? defaultSource;
      const settings = getBrowserSettingsSnapshot();
      const hasRules = settings.hostRules.length > 0;

      if (browserPluginId || hasRules || options?.source) {
        const forceAsk =
          source === 'terminal' &&
          Boolean(options?.altKey) &&
          settings.terminalClickMenu;
        const action = forceAsk
          ? 'ask'
          : resolveLinkOpenAction(url, source, settings);

        if (action === 'block') {
          toast.warning(i18n.t('settings:browser.rules.actionBlock'), {
            description: url,
          });
          return;
        }

        if (action === 'ask' && panelActions) {
          toast.info(url, {
            action: {
              label: i18n.t('settings:browser.links.targetBuiltin'),
              onClick: () => panelActions.openWebPreview(url),
            },
            cancel: {
              label: i18n.t('settings:browser.links.targetSystem'),
              onClick: () => void openInSystemBrowser(url),
            },
          });
          return;
        }

        if (action === 'builtin' && panelActions) {
          panelActions.openWebPreview(url);
          return;
        }

        if (action === 'system') {
          void openInSystemBrowser(url);
          return;
        }
      }

      if (behavior === 'BuiltinPreview' && panelActions) {
        panelActions.openWebPreview(url);
        return;
      }
      void openInSystemBrowser(url);
    },
    [behavior, browserPluginId, defaultSource, panelActions]
  );
}
