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

export function isHostBrowserPlugin<
  T extends { pluginId: string; metadata?: unknown },
>(
  pluginId: string | null | undefined,
  items: readonly T[],
  itemMetadata?: Record<string, unknown> | null
): boolean {
  if (isHostBrowserEngine(pluginId, itemMetadata)) {
    return true;
  }
  if (!pluginId) {
    return false;
  }
  return items.some(
    (entry) =>
      entry.pluginId === pluginId &&
      isHostBrowserEngine(
        entry.pluginId,
        entry.metadata &&
          typeof entry.metadata === 'object' &&
          !Array.isArray(entry.metadata)
          ? (entry.metadata as Record<string, unknown>)
          : null
      )
  );
}
