export const HOST_BROWSER_PLUGIN_ID = 'vibex.browser';
export const HOST_BROWSER_CONTRIBUTION_ID = 'browser';

export function isHostBrowserEngine(
  pluginId?: string | null,
  metadata?: Record<string, unknown> | null
): boolean {
  if (metadata?.engine === 'host-browser') return true;
  return pluginId === HOST_BROWSER_PLUGIN_ID;
}

export function findHostBrowserContribution<
  T extends { pluginId: string; id: string; metadata?: unknown },
>(items: readonly T[]): T | undefined {
  return (
    items.find((item) =>
      isHostBrowserEngine(
        item.pluginId,
        item.metadata &&
          typeof item.metadata === 'object' &&
          !Array.isArray(item.metadata)
          ? (item.metadata as Record<string, unknown>)
          : null
      )
    ) ??
    items.find(
      (item) =>
        item.pluginId === HOST_BROWSER_PLUGIN_ID &&
        item.id === HOST_BROWSER_CONTRIBUTION_ID
    )
  );
}
