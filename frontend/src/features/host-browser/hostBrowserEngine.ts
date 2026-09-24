export const HOST_BROWSER_ENGINE = 'host-browser';

export function isHostBrowserEngine(
  _pluginId?: string | null,
  metadata?: Record<string, unknown> | null
): boolean {
  return metadata?.engine === HOST_BROWSER_ENGINE;
}

export function findHostBrowserContribution<
  T extends { pluginId: string; id: string; metadata?: unknown },
>(items: readonly T[]): T | undefined {
  return items.find((item) =>
    isHostBrowserEngine(
      item.pluginId,
      item.metadata &&
        typeof item.metadata === 'object' &&
        !Array.isArray(item.metadata)
        ? (item.metadata as Record<string, unknown>)
        : null
    )
  );
}
