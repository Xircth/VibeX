import { AppSurfaceHost } from '@/components/plugins/AppSurfaceHost';
import {
  contributionMetadata,
  usePluginHostContributions,
} from '@/hooks/usePluginHostContributions';
import { createBackendAppSurfaceTransport } from '@/lib/api/appSurfaceTransport';
import { configuredBackendTransport } from '@/lib/backendTransport';

const transport = createBackendAppSurfaceTransport(configuredBackendTransport);

export function PluginTimelineCards() {
  const cards = usePluginHostContributions('timeline_card');
  if (cards.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 px-3 pb-2">
      {cards.map((card) => {
        const metadata = contributionMetadata(card);
        const surfaceId = String(metadata.surfaceId ?? card.id);
        const height = Number(metadata.minHeight ?? 240);
        return (
          <div
            key={`${card.pluginId}:${card.id}`}
            className="overflow-hidden rounded-lg border border-border/60 bg-card"
            style={{ maxHeight: 360 }}
          >
            <AppSurfaceHost
              descriptor={{
                pluginId: card.pluginId,
                surfaceId,
                label: card.label,
                generation: card.generation,
                allowedMethods: Array.isArray(metadata.allowedMethods)
                  ? metadata.allowedMethods.filter(
                      (method): method is string => typeof method === 'string'
                    )
                  : [],
                minHeight: Number.isFinite(height) ? height : 240,
                slot: 'conversation.timeline.card',
              }}
              enabled
              transport={transport}
              variant="panel"
            />
          </div>
        );
      })}
    </div>
  );
}
