export const PLUGIN_SURFACE_PREFIX = 'plugin:';

export function pluginSurfaceId(pluginId: string, contributionId: string): string {
  return `${PLUGIN_SURFACE_PREFIX}${pluginId}/${contributionId}`;
}

export function parsePluginSurfaceId(
  value: string
): { pluginId: string; contributionId: string } | null {
  if (!value.startsWith(PLUGIN_SURFACE_PREFIX)) return null;
  const body = value.slice(PLUGIN_SURFACE_PREFIX.length);
  const separator = body.indexOf('/');
  if (separator <= 0 || separator === body.length - 1) return null;
  return {
    pluginId: body.slice(0, separator),
    contributionId: body.slice(separator + 1),
  };
}

export function isPluginSurfaceId(value: string): boolean {
  return parsePluginSurfaceId(value) !== null;
}

export const BUILTIN_WORKSPACE_TABS = ['workspace', 'kanban'] as const;
export type BuiltinWorkspaceTab = (typeof BUILTIN_WORKSPACE_TABS)[number];

export function isBuiltinWorkspaceTab(
  tab: string
): tab is BuiltinWorkspaceTab {
  return tab === 'workspace' || tab === 'kanban';
}

export function fallbackWorkspaceTab(tab: string, availableTabs: readonly string[]): string {
  if (availableTabs.includes(tab)) return tab;
  if (availableTabs.includes('workspace')) return 'workspace';
  return availableTabs[0] ?? 'workspace';
}
