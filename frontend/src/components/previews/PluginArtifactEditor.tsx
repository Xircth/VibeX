import { AppSurfaceHost } from '@/components/plugins/AppSurfaceHost';
import { configuredBackendTransport } from '@/lib/backendTransport';
import { createBackendAppSurfaceTransport } from '@/lib/api/appSurfaceTransport';
import type { ResolvedPluginFileOpener } from '@/lib/api/plugins';

const appSurfaceTransport = createBackendAppSurfaceTransport(
  configuredBackendTransport
);

export function PluginArtifactEditor({
  opener,
  filePath,
}: {
  opener: ResolvedPluginFileOpener;
  filePath: string;
}) {
  return (
    <AppSurfaceHost
      descriptor={{
        pluginId: opener.pluginId,
        surfaceId: opener.handler,
        label: opener.label,
        generation: opener.generation,
        allowedMethods: [],
        slot: 'artifact.editor',
        artifactPath: filePath,
      }}
      enabled
      transport={appSurfaceTransport}
      variant="editor"
    />
  );
}
