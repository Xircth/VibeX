import { pluginSurfaceId } from '@/lib/hostSurfaceIds';

export interface ToolbarPluginTabSource {
  pluginId: string;
  id: string;
  label: string;
  icon?: unknown;
}

export interface ToolbarSdkViewSource {
  id: string;
  pluginId?: string;
  kind?: string;
  title: string;
  icon?: unknown;
}

export interface ToolbarPluginTabItem {
  key: string;
  label: string;
  icon?: unknown;
}

function stripPluginPrefix(id: string, pluginId: string): string {
  if (id.startsWith(`${pluginId}:`)) return id.slice(pluginId.length + 1);
  const surfacePrefix = `plugin:${pluginId}/`;
  if (id.startsWith(surfacePrefix)) return id.slice(surfacePrefix.length);
  return id;
}

/**
 * Collect plugin-contributed toolbar tabs. A plugin tab whose id matches a
 * built-in tab key is the plugin-side implementation of that built-in surface
 * (IDELayout renders it through the SDK view), so it never gets its own
 * toolbar entry. Generic: no plugin ids are special-cased.
 */
export function collectPluginToolbarTabs(
  builtinKeys: readonly string[],
  pluginTabs: readonly ToolbarPluginTabSource[],
  sdkViews: readonly ToolbarSdkViewSource[]
): ToolbarPluginTabItem[] {
  const builtin = new Set(builtinKeys);
  const seen = new Set<string>();
  const items: ToolbarPluginTabItem[] = [];
  const push = (
    pluginId: string,
    rawId: string,
    label: string,
    icon: unknown
  ) => {
    if (builtin.has(rawId)) return;
    const key = pluginSurfaceId(pluginId, rawId);
    if (builtin.has(key) || seen.has(key)) return;
    seen.add(key);
    items.push({ key, label, icon });
  };
  for (const item of pluginTabs) {
    push(
      item.pluginId,
      stripPluginPrefix(item.id, item.pluginId),
      item.label,
      item.icon
    );
  }
  for (const view of sdkViews) {
    if (view.kind !== 'tab') continue;
    const pluginId = view.pluginId ?? 'plugin';
    push(pluginId, stripPluginPrefix(view.id, pluginId), view.title, view.icon);
  }
  return items;
}
