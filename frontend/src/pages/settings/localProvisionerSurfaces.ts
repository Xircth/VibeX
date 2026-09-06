import { appSurfaceDescriptors } from '@/lib/api/appSurfaceTransport';
import type {
  PluginContributionCatalog,
  PluginControlCatalog,
  PluginControlItem,
} from '@/lib/api/plugins';
import type { AppSurfaceDescriptor } from '@/components/plugins/AppSurfaceHost';

export type LocalProvisionerSurface = {
  plugin: PluginControlItem;
  label: string;
  kind: string | null;
  icon?: string;
  surfaces: AppSurfaceDescriptor[];
};

export function localProvisionerSurfaces(
  catalog: PluginControlCatalog,
  contributions: PluginContributionCatalog
): LocalProvisionerSurface[] {
  const provisioners = contributions.items.filter(
    (item) => item.kind === 'remote_provisioner'
  );
  const provisionerIds = new Set(provisioners.map((item) => item.pluginId));
  return catalog.plugins
    .filter((plugin) => provisionerIds.has(plugin.id))
    .map((plugin) => {
      const provisioner = provisioners.find(
        (item) => item.pluginId === plugin.id
      );
      const metadata =
        provisioner?.metadata &&
        typeof provisioner.metadata === 'object' &&
        !Array.isArray(provisioner.metadata)
          ? (provisioner.metadata as Record<string, unknown>)
          : {};
      return {
        plugin,
        label: provisioner?.label?.trim() || plugin.name,
        kind:
          typeof metadata.provisionKind === 'string'
            ? metadata.provisionKind
            : null,
        icon: typeof metadata.icon === 'string' ? metadata.icon : undefined,
        surfaces: appSurfaceDescriptors(plugin, contributions.items),
      };
    })
    .filter((entry) => entry.surfaces.length > 0);
}
