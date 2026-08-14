import type {
  AppSurfaceDescriptor,
  AppSurfaceHostTransport,
  JsonValue,
} from '@/components/plugins/AppSurfaceHost';
import type { BackendTransport } from '@/lib/backendTransport';
import type {
  PluginContributionCatalogItem,
  PluginControlItem,
} from './plugins';

const MAX_SURFACE_DOCUMENT_BYTES = 2_000_000;

function missingCommand(cause: unknown, command: string) {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new RegExp(`command\\s+${command}\\s+not found`, 'iu').test(message);
}

/**
 * Backend-neutral adapter. Desktop and remote transports use the same command
 * contract; until the broker commands ship, capability calls fail closed.
 */
export function createBackendAppSurfaceTransport(
  backend: BackendTransport
): AppSurfaceHostTransport {
  return {
    async load(request) {
      const response = await backend.call('plugin_surface_open', {
        pluginId: request.pluginId,
        surfaceId: request.surfaceId,
        generation: request.generation,
        token: request.token,
        ...(request.artifactPath ? { artifactPath: request.artifactPath } : {}),
      });
      const html =
        response && typeof response === 'object' && 'html' in response
          ? (response as { html: unknown }).html
          : null;
      const token =
        response && typeof response === 'object' && 'token' in response
          ? (response as { token: unknown }).token
          : null;
      const context =
        response &&
        typeof response === 'object' &&
        'context' in response &&
        response.context &&
        typeof response.context === 'object' &&
        !Array.isArray(response.context)
          ? (response.context as Record<string, JsonValue>)
          : undefined;
      if (
        typeof html !== 'string' ||
        typeof token !== 'string' ||
        !/^[a-f\d]{32,128}$/iu.test(token)
      ) {
        throw new Error('Plugin surface broker returned an invalid document');
      }
      if (
        new TextEncoder().encode(html).byteLength > MAX_SURFACE_DOCUMENT_BYTES
      ) {
        throw new Error('Plugin surface document exceeds the size limit');
      }
      return { html, token, context };
    },
    invoke: (request) =>
      backend.call('plugin_surface_invoke', {
        pluginId: request.pluginId,
        surfaceId: request.surfaceId,
        generation: request.generation,
        token: request.token,
        requestId: request.requestId,
        sequence: request.sequence,
        method: request.method,
        params: request.params,
      }) as Promise<JsonValue>,
    async revoke(request) {
      try {
        await backend.call('plugin_surface_revoke', {
          pluginId: request.pluginId,
          surfaceId: request.surfaceId,
          generation: request.generation,
          token: request.token,
          reason: request.reason,
        });
      } catch (cause) {
        // No backend grant exists on pre-broker builds; the local port and
        // iframe have still been synchronously destroyed by the host.
        if (!missingCommand(cause, 'plugin_surface_revoke')) throw cause;
      }
    },
  };
}

function metadataRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function appSurfaceDescriptors(
  plugin: PluginControlItem,
  items: PluginContributionCatalogItem[]
): AppSurfaceDescriptor[] {
  return items.flatMap((item) => {
    if (item.pluginId !== plugin.id || item.kind !== 'app_surface') return [];
    const metadata = metadataRecord(item.metadata);
    if (
      metadata?.slot !== 'plugin.detail.panel' ||
      metadata.handler !== 'surface.createSession'
    ) {
      return [];
    }
    if (typeof metadata.appEntrypoint !== 'string' || !metadata.appEntrypoint) {
      return [];
    }
    const allowedMethods = Array.isArray(metadata?.allowedMethods)
      ? metadata.allowedMethods.filter(
          (method): method is string => typeof method === 'string'
        )
      : [];
    const requestedHeight = metadata?.minHeight;
    const minHeight =
      typeof requestedHeight === 'number' && Number.isFinite(requestedHeight)
        ? Math.min(900, Math.max(240, Math.round(requestedHeight)))
        : undefined;
    return [
      {
        pluginId: plugin.id,
        surfaceId: item.id,
        label: item.label,
        generation: item.generation,
        allowedMethods: [...new Set(allowedMethods)].sort(),
        minHeight,
        initialRoute:
          typeof metadata.route === 'string' ? metadata.route : undefined,
      },
    ];
  });
}
