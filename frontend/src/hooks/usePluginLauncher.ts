import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { Plugin, PluginActivation } from 'shared/types';
import { usePanelActionsContext } from '@/contexts/PanelActionsContext';
import { pluginApi } from '@/lib/api/plugins';
import { requestPluginHook } from '@/lib/pluginHookBus';

/** The agent needs time to read the hook and start the console — poll gently
 *  but for long enough to cover a slow first `npx` download. */
const PROBE_INTERVAL_MS = 2_000;
const PROBE_TOTAL_TIMEOUT_MS = 10 * 60_000;

export function isPluginExpired(plugin: Plugin): boolean {
  return (
    plugin.expires_at !== null &&
    new Date(plugin.expires_at).getTime() <= Date.now()
  );
}

export function renderHookMessage(
  plugin: Plugin,
  activation: PluginActivation,
  consoleUrlFallback: string
): string {
  return plugin.hook_message
    .replaceAll('{{pluginName}}', plugin.name)
    .replaceAll('{{skillName}}', plugin.skill_name)
    .replaceAll('{{consoleCommand}}', activation.console_command)
    .replaceAll('{{consoleUrl}}', activation.console_url ?? consoleUrlFallback)
    .replaceAll(
      '{{port}}',
      activation.port !== null ? String(activation.port) : ''
    );
}

export function usePlugins() {
  return useQuery({
    queryKey: ['plugins'],
    queryFn: pluginApi.list,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

/**
 * Click orchestration for a right-sidebar plugin button, agent-driven:
 * composer must be idle and empty → allocate port / render templates →
 * prefill the hook (which tells the agent how and where to start the
 * console) → poll the agreed URL and open it in the Web Preview once the
 * agent has brought it up.
 */
export function usePluginLauncher(workspaceId: string | undefined) {
  const { t } = useTranslation(['panels']);
  const { openWebPreview } = usePanelActionsContext();
  const [launchingPluginId, setLaunchingPluginId] = useState<string | null>(
    null
  );
  /** URLs currently being watched, so a re-click doesn't stack watchers. */
  const watchedUrlsRef = useRef(new Set<string>());
  const unmountedRef = useRef(false);

  useEffect(() => {
    unmountedRef.current = false;
    const watched = watchedUrlsRef.current;
    return () => {
      unmountedRef.current = true;
      watched.clear();
    };
  }, []);

  const watchConsole = useCallback(
    (plugin: Plugin, url: string) => {
      const watched = watchedUrlsRef.current;
      if (watched.has(url)) return;
      watched.add(url);

      const startedAt = Date.now();
      const poll = async () => {
        if (unmountedRef.current || !watched.has(url)) return;
        if (Date.now() - startedAt > PROBE_TOTAL_TIMEOUT_MS) {
          watched.delete(url);
          return;
        }
        const reachable = await pluginApi.probeConsole(url).catch(() => false);
        if (unmountedRef.current || !watched.has(url)) return;
        if (reachable) {
          watched.delete(url);
          openWebPreview(url);
          toast.success(
            t('rightPanelSidebar.pluginConsoleOpened', { name: plugin.name })
          );
          return;
        }
        window.setTimeout(() => void poll(), PROBE_INTERVAL_MS);
      };
      void poll();
    },
    [openWebPreview, t]
  );

  const launch = useCallback(
    async (plugin: Plugin) => {
      if (!workspaceId || launchingPluginId) return;

      if (requestPluginHook({ workspaceId, action: 'check' }) !== 'ok') {
        toast.error(t('rightPanelSidebar.pluginHookBlocked'));
        return;
      }

      setLaunchingPluginId(plugin.id);
      try {
        const activation = await pluginApi.activate(plugin.id);
        const hook = renderHookMessage(
          plugin,
          activation,
          t('rightPanelSidebar.pluginConsoleUrlUnknown')
        );
        if (
          requestPluginHook({ workspaceId, action: 'insert', text: hook }) !==
          'ok'
        ) {
          toast.error(t('rightPanelSidebar.pluginHookBlocked'));
          return;
        }
        // The agent starts the console; watch the agreed URL in the
        // background and pop the Web Preview once it is reachable.
        if (activation.console_url) {
          watchConsole(plugin, activation.console_url);
        }
      } catch (error) {
        toast.error(
          t('rightPanelSidebar.pluginStartFailed', { error: String(error) })
        );
      } finally {
        setLaunchingPluginId(null);
      }
    },
    [workspaceId, launchingPluginId, watchConsole, t]
  );

  return { launch, launchingPluginId };
}
