import {
  type CapturedInternalMessage,
  dispatchCapturedInternalMessage,
  serviceContainer,
  useThemes,
} from '@vibex/plugin-sdk';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef } from 'react';

import { toast } from '@/components/ui/toast';

import {
  loadPluginRuntime,
  unloadPluginRuntime,
  type PluginRuntimeSource,
} from '@/features/plugins/PluginRuntimeLoader';
import { getMonorepoPluginBundle } from '@/features/plugins/monorepoPluginBootstrap';
import { ensureHostProviderServicesRegistered } from '@/features/plugins/providers/hostProviderServices';
import { backendListen } from '@/lib/backendTransport';
import {
  createPluginControlApi,
  type PluginContributionCatalogItem,
} from '@/lib/api/plugins';
import { useBackendTransport } from '@/lib/transport';

export const pluginContributionCatalogQueryKey = [
  'plugin-contribution-catalog',
] as const;

const CONTRIBUTIONS_CHANGED_EVENT = 'plugin-contributions-changed';
const PLUGIN_INTERNAL_MESSAGE_EVENT = 'plugin-internal-message';
const CONVERSATION_AFTER_TURN_EVENT = 'conversation-after-turn';
const CONVERSATION_RUNTIME_EVENT = 'conversation-runtime-event';
const PLUGIN_NOTIFY_TOAST_EVENT = 'plugin-notify-toast';

const EMPTY: PluginContributionCatalogItem[] = [];

/**
 * Keeps Host chrome in step with plugin activation. The Host republishes the
 * catalog whenever a generation is published or withdrawn, so enabling a plugin
 * shows its contributions immediately and disabling removes them atomically
 * (ADR-0069 principle 4) — including when the CLI drives the change.
 */
export function usePluginContributionCatalogSync() {
  const queryClient = useQueryClient();
  const items = usePluginHostContributions();
  const pluginThemes = useThemes();
  const knownHostPluginIdsRef = useRef<Set<string>>(new Set());
  const loadedGenerationByPluginRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    ensureHostProviderServicesRegistered();
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined' || !document.head) return;
    const styleId = 'vibex-plugin-theme-variables';
    let styleEl = document.head.querySelector<HTMLStyleElement>(
      `style[data-vibex-plugin-themes="${styleId}"]`
    );
    if (pluginThemes.length === 0) {
      styleEl?.remove();
      return;
    }
    const rules: string[] = [];
    for (const theme of pluginThemes) {
      const entries = Object.entries(theme.cssVariables ?? {}).filter(
        ([k, v]) => typeof k === 'string' && k.trim() && typeof v === 'string'
      );
      if (entries.length === 0) continue;
      const body = entries
        .map(([k, v]) => {
          const prop = k.startsWith('--') ? k : `--${k}`;
          return `  ${prop}: ${v};`;
        })
        .join('\n');
      rules.push(`:root, [data-plugin-theme="${theme.id}"] {\n${body}\n}`);
    }
    if (rules.length === 0) {
      styleEl?.remove();
      return;
    }
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.setAttribute('data-vibex-plugin-themes', styleId);
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = rules.join('\n');
  }, [pluginThemes]);

  useEffect(() => {
    let disposed = false;
    let unlistenCatalog: (() => void) | undefined;
    let unlistenInternal: (() => void) | undefined;
    let unlistenAfterTurn: (() => void) | undefined;
    let unlistenRuntimeEvent: (() => void) | undefined;
    let unlistenPluginToast: (() => void) | undefined;

    void backendListen(CONTRIBUTIONS_CHANGED_EVENT, () => {
      void queryClient.invalidateQueries({
        queryKey: pluginContributionCatalogQueryKey,
      });
    }).then((dispose) => {
      if (disposed) dispose();
      else unlistenCatalog = dispose;
    });

    void backendListen(PLUGIN_INTERNAL_MESSAGE_EVENT, (payload) => {
      if (payload && typeof payload === 'object') {
        dispatchCapturedInternalMessage(payload as CapturedInternalMessage);
      }
    }).then((dispose) => {
      if (disposed) dispose();
      else unlistenInternal = dispose;
    });

    void backendListen(CONVERSATION_AFTER_TURN_EVENT, (payload) => {
      if (payload && typeof payload === 'object') {
        void serviceContainer
          .runWaterfall('conversation.afterTurn', payload)
          .catch(() => undefined);
      }
    }).then((dispose) => {
      if (disposed) dispose();
      else unlistenAfterTurn = dispose;
    });

    void backendListen(CONVERSATION_RUNTIME_EVENT, (payload) => {
      if (payload && typeof payload === 'object') {
        void serviceContainer
          .runWaterfall('runtime.event', payload)
          .catch(() => undefined);
      }
    }).then((dispose) => {
      if (disposed) dispose();
      else unlistenRuntimeEvent = dispose;
    });

    void backendListen(PLUGIN_NOTIFY_TOAST_EVENT, (payload) => {
      if (!payload || typeof payload !== 'object') return;
      const rec = payload as Record<string, unknown>;
      const title =
        typeof rec.title === 'string' && rec.title.trim()
          ? rec.title.trim()
          : typeof rec.message === 'string'
            ? rec.message
            : 'Plugin Notification';
      const description =
        typeof rec.title === 'string' &&
        rec.title.trim() &&
        typeof rec.message === 'string' &&
        rec.message.trim()
          ? rec.message
          : undefined;
      const duration =
        typeof rec.durationMs === 'number' ? rec.durationMs : 4000;
      const variant = typeof rec.variant === 'string' ? rec.variant : 'info';
      const opts = { description, duration };
      if (variant === 'success') toast.success(title, opts);
      else if (variant === 'warning') toast.warning(title, opts);
      else if (variant === 'error') toast.error(title, opts);
      else toast.info(title, opts);
    }).then((dispose) => {
      if (disposed) dispose();
      else unlistenPluginToast = dispose;
    });

    return () => {
      disposed = true;
      unlistenCatalog?.();
      unlistenInternal?.();
      unlistenAfterTurn?.();
      unlistenRuntimeEvent?.();
      unlistenPluginToast?.();
    };
  }, [queryClient]);

  useEffect(() => {
    const activeIds = new Set<string>();
    for (const item of items) {
      activeIds.add(item.pluginId);
      const monorepoBundle = getMonorepoPluginBundle(item.pluginId);
      if (monorepoBundle) {
        if (
          loadedGenerationByPluginRef.current.get(item.pluginId) !==
          item.generation
        ) {
          loadedGenerationByPluginRef.current.set(
            item.pluginId,
            item.generation
          );
          void loadPluginRuntime(
            item.pluginId,
            {
              kind: 'module',
              module: monorepoBundle.module,
              spec: monorepoBundle.spec,
            },
            {
              generation: item.generation,
            }
          );
        }
        continue;
      }

      const meta = contributionMetadata(item);
      const runtimeSource = meta.runtimeSource as
        | PluginRuntimeSource
        | undefined;
      if (
        runtimeSource &&
        typeof runtimeSource === 'object' &&
        'kind' in runtimeSource
      ) {
        if (
          loadedGenerationByPluginRef.current.get(item.pluginId) !==
          item.generation
        ) {
          loadedGenerationByPluginRef.current.set(
            item.pluginId,
            item.generation
          );
          void loadPluginRuntime(item.pluginId, runtimeSource, {
            generation: item.generation,
          });
        }
      }
    }

    for (const previousId of knownHostPluginIdsRef.current) {
      if (!activeIds.has(previousId)) {
        loadedGenerationByPluginRef.current.delete(previousId);
        unloadPluginRuntime(previousId);
      }
    }
    knownHostPluginIdsRef.current = activeIds;
  }, [items]);
}

export function usePluginHostContributions(
  kind?: PluginContributionCatalogItem['kind']
) {
  const transport = useBackendTransport();
  const api = useMemo(() => createPluginControlApi(transport), [transport]);
  const { data } = useQuery({
    queryKey: pluginContributionCatalogQueryKey,
    queryFn: () => api.contributionCatalog(),
    staleTime: 30_000,
    retry: false,
  });

  const items = data?.items ?? EMPTY;
  return useMemo(
    () => (kind ? items.filter((item) => item.kind === kind) : items),
    [items, kind]
  );
}

export function contributionMetadata(
  item: PluginContributionCatalogItem
): Record<string, unknown> {
  if (
    !item.metadata ||
    typeof item.metadata !== 'object' ||
    Array.isArray(item.metadata)
  ) {
    return {};
  }
  return item.metadata as Record<string, unknown>;
}
