import { AppSurfaceHost } from '@/components/plugins/AppSurfaceHost';
import {
  contributionMetadata,
  usePluginHostContributions,
} from '@/hooks/usePluginHostContributions';
import { createBackendAppSurfaceTransport } from '@/lib/api/appSurfaceTransport';
import { configuredBackendTransport } from '@/lib/backendTransport';

const transport = createBackendAppSurfaceTransport(configuredBackendTransport);

export function PluginSettingsSections() {
  const sections = usePluginHostContributions('settings_section');
  if (sections.length === 0) return null;

  return (
    <>
      {sections.map((section) => {
        const metadata = contributionMetadata(section);
        const surfaceId = String(metadata.surfaceId ?? section.id);
        return (
          <section
            key={`${section.pluginId}:${section.id}`}
            className="settings-section space-y-3"
          >
            <h2 className="text-sm font-medium text-foreground">
              {section.label}
            </h2>
            <AppSurfaceHost
              descriptor={{
                pluginId: section.pluginId,
                surfaceId,
                label: section.label,
                generation: section.generation,
                allowedMethods: [],
                slot: 'plugin.detail.panel',
              }}
              enabled
              transport={transport}
              variant="panel"
            />
          </section>
        );
      })}
    </>
  );
}
