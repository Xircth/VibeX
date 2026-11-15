import { AppSurfaceHost } from '@/components/plugins/AppSurfaceHost';
import { configuredBackendTransport } from '@/lib/backendTransport';
import { createBackendAppSurfaceTransport } from '@/lib/api/appSurfaceTransport';
import type { ResolvedPluginFileOpener } from '@/lib/api/plugins';
import { WorkflowArtifactStudio } from '@/features/workflow/WorkflowArtifactStudio';

const appSurfaceTransport = createBackendAppSurfaceTransport(
  configuredBackendTransport
);

export function PluginArtifactEditor({
  opener,
  filePath,
  onDirtyChange,
}: {
  opener: ResolvedPluginFileOpener;
  filePath: string;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  if (
    opener.nativeRenderer === 'workflow.studio' ||
    opener.nativeRenderer === 'host.renderer.workflow.studio'
  ) {
    return (
      <WorkflowArtifactStudio
        filePath={filePath}
        onDirtyChange={onDirtyChange}
      />
    );
  }
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
