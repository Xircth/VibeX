import { useOverlays } from '@vibex/plugin-sdk';
import type { ReactNode } from 'react';

import { PluginBoundary } from '@/components/plugins/PluginBoundary';

export function PluginOverlays({
  context = {},
}: {
  readonly context?: Record<string, unknown>;
}) {
  const overlays = useOverlays();
  if (overlays.length === 0) {
    return null;
  }

  return (
    <>
      {overlays.map((overlay) => {
        if (overlay.when) {
          try {
            if (!overlay.when(context)) {
              return null;
            }
          } catch {
            return null;
          }
        }
        const pluginId = overlay.pluginId ?? 'unknown-plugin';
        const Component = overlay.component;
        return (
          <PluginBoundary
            key={`${pluginId}:${overlay.id}`}
            pluginId={pluginId}
            slot="global.overlay"
          >
            <div
              data-testid={`plugin-overlay-${pluginId}-${overlay.id}`}
              style={
                overlay.zIndex !== undefined
                  ? { zIndex: overlay.zIndex }
                  : undefined
              }
            >
              {Component ? (
                <Component {...context} />
              ) : overlay.render ? (
                (overlay.render(context) as ReactNode)
              ) : null}
            </div>
          </PluginBoundary>
        );
      })}
    </>
  );
}
