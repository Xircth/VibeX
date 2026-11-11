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
  handler: string | null;
  timeoutSeconds: number;
  icon?: string;
  surfaces: AppSurfaceDescriptor[];
};

const DEFAULT_PROVISIONER_TIMEOUT_SECONDS = 120;

function provisionerMetadata(
  provisioner: PluginContributionCatalog['items'][number] | undefined
): Record<string, unknown> {
  return provisioner?.metadata &&
    typeof provisioner.metadata === 'object' &&
    !Array.isArray(provisioner.metadata)
    ? (provisioner.metadata as Record<string, unknown>)
    : {};
}

export function provisionerForKind(
  panels: LocalProvisionerSurface[],
  kind: string | null | undefined
): LocalProvisionerSurface | null {
  const value = kind?.trim() ?? '';
  if (!value || value === 'manual' || value === 'discovered') return null;
  return panels.find((panel) => panel.kind === value) ?? null;
}

export function provisionedHostPayload(profile: {
  id: string;
  origin: string;
  name: string;
  provision_kind?: string | null;
  provision?: Record<string, unknown> | null;
  has_credential: boolean;
}): Record<string, unknown> {
  return {
    id: profile.id,
    origin: profile.origin,
    name: profile.name,
    provisionKind: profile.provision_kind ?? undefined,
    provision: profile.provision ?? undefined,
    hasCredential: profile.has_credential,
  };
}

export function extractSshProvisionerSettings(profile: {
  name: string;
  provision?: Record<string, unknown> | null;
}): Record<string, unknown> | null {
  const provision = profile.provision;
  if (!provision || typeof provision !== 'object') return null;
  const host = typeof provision.host === 'string' ? provision.host.trim() : '';
  const user = typeof provision.user === 'string' ? provision.user.trim() : '';
  if (!host && !user) return null;
  const rawPort = Number(provision.port);
  const port =
    Number.isInteger(rawPort) && rawPort >= 1 && rawPort <= 65535
      ? rawPort
      : 22;
  const jump = typeof provision.jump === 'string' ? provision.jump.trim() : '';
  return {
    name: profile.name?.trim() || host,
    host,
    port,
    user,
    jump,
    dataDir: '',
  };
}

export async function prefillProvisionerSettings(
  api: {
    hostCall?: <T = unknown>(
      pluginId: string,
      capability: string,
      operation: string,
      input?: unknown
    ) => Promise<T>;
  },
  pluginId: string,
  profile: {
    name: string;
    provision?: Record<string, unknown> | null;
  }
): Promise<boolean> {
  if (typeof api.hostCall !== 'function') return false;
  const settings = extractSshProvisionerSettings(profile);
  if (!settings) return false;
  try {
    await api.hostCall(pluginId, 'storage', 'settings.put', settings);
    return true;
  } catch {
    return false;
  }
}

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
      const metadata = provisionerMetadata(provisioner);
      const timeout = Number(metadata.timeoutSeconds);
      return {
        plugin,
        label: provisioner?.label?.trim() || plugin.name,
        kind:
          typeof metadata.provisionKind === 'string'
            ? metadata.provisionKind
            : null,
        handler: typeof metadata.handler === 'string' ? metadata.handler : null,
        timeoutSeconds:
          Number.isInteger(timeout) && timeout >= 5 && timeout <= 600
            ? timeout
            : DEFAULT_PROVISIONER_TIMEOUT_SECONDS,
        icon: typeof metadata.icon === 'string' ? metadata.icon : undefined,
        surfaces: appSurfaceDescriptors(plugin, contributions.items),
      };
    })
    .filter((entry) => entry.surfaces.length > 0);
}
