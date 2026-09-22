export const PLUGIN_SURFACE_PREFIX = 'plugin:';

export function pluginSurfaceId(
  pluginId: string,
  contributionId: string,
  instance?: string | number
): string {
  const base = `${PLUGIN_SURFACE_PREFIX}${pluginId}/${contributionId}`;
  return instance == null || instance === '' ? base : `${base}:${instance}`;
}

export function parsePluginSurfaceId(value: string): {
  pluginId: string;
  contributionId: string;
  instance?: string;
} | null {
  if (!value.startsWith(PLUGIN_SURFACE_PREFIX)) return null;
  const body = value.slice(PLUGIN_SURFACE_PREFIX.length);
  const separator = body.indexOf('/');
  if (separator <= 0 || separator === body.length - 1) return null;
  const pluginId = body.slice(0, separator);
  const rest = body.slice(separator + 1);
  const instanceSep = rest.lastIndexOf(':');
  if (instanceSep > 0 && /^\d+$/.test(rest.slice(instanceSep + 1))) {
    return {
      pluginId,
      contributionId: rest.slice(0, instanceSep),
      instance: rest.slice(instanceSep + 1),
    };
  }
  return {
    pluginId,
    contributionId: rest,
  };
}

export function isPluginSurfaceId(value: string): boolean {
  return parsePluginSurfaceId(value) !== null;
}

export const BUILTIN_WORKSPACE_TABS = ['workspace', 'kanban'] as const;
export type BuiltinWorkspaceTab = (typeof BUILTIN_WORKSPACE_TABS)[number];

export function isBuiltinWorkspaceTab(tab: string): tab is BuiltinWorkspaceTab {
  return tab === 'workspace' || tab === 'kanban';
}

export function fallbackWorkspaceTab(
  tab: string,
  availableTabs: readonly string[]
): string {
  if (availableTabs.includes(tab)) return tab;
  if (availableTabs.includes('workspace')) return 'workspace';
  return availableTabs[0] ?? 'workspace';
}

/** Open a contributed panel once per enable generation; do not reopen if the user closed it. */
export function shouldOpenContributedPanel(
  existing: boolean,
  offeredThisGeneration: boolean
): boolean {
  return !existing && !offeredThisGeneration;
}
