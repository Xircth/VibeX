import { Loader } from '@/components/ui/loader';
import { AppSurfaceHost } from '@/components/plugins/AppSurfaceHost';
import { PluginSurfacePlaceholder } from '@/components/plugins/PluginSurfacePlaceholder';
import { createBackendAppSurfaceTransport } from '@/lib/api/appSurfaceTransport';
import { configuredBackendTransport } from '@/lib/backendTransport';
import {
  isHttpRemoteEntry,
  loadPluginRemote,
  mountRemoteModule,
  parseRemoteRef,
} from '@/lib/pluginFederation';
import type { PluginContributionCatalogItem } from '@/lib/api/plugins';
import { contributionMetadata } from '@/hooks/usePluginHostContributions';
import { useEffect, useMemo, useRef, useState, type ReactNode, Component } from 'react';

const transport = createBackendAppSurfaceTransport(configuredBackendTransport);

export function PluginRemoteView({
  item,
  slot,
  enabled = true,
}: {
  item: PluginContributionCatalogItem | null;
  slot: 'app.panel' | 'app.tab' | 'app.kanban.view' | 'app.settings.page';
  enabled?: boolean;
}) {
  const [retry, setRetry] = useState(0);
  if (!enabled) {
    return <PluginSurfacePlaceholder reason="disabled" />;
  }
  if (!item) {
    return <PluginSurfacePlaceholder reason="missing" />;
  }
  return (
    <RemoteViewErrorBoundary onRetry={() => setRetry((current) => current + 1)}>
      <PluginRemoteViewBody key={`${item.pluginId}:${item.id}:${retry}`} item={item} slot={slot} />
    </RemoteViewErrorBoundary>
  );
}

class RemoteViewErrorBoundary extends Component<
  { children: ReactNode; onRetry: () => void },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <PluginSurfacePlaceholder
          reason="failed"
          onRecover={() => {
            this.setState({ failed: false });
            this.props.onRetry();
          }}
        />
      );
    }
    return this.props.children;
  }
}

function PluginRemoteViewBody({
  item,
  slot,
}: {
  item: PluginContributionCatalogItem;
  slot: 'app.panel' | 'app.tab' | 'app.kanban.view' | 'app.settings.page';
}) {
  const metadata = contributionMetadata(item);
  const remote = useMemo(
    () => parseRemoteRef(metadata.remote),
    [metadata.remote]
  );
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [retry, setRetry] = useState(0);
  const [remoteState, setRemoteState] = useState<'idle' | 'loading' | 'ready' | 'failed'>(
    remote && isHttpRemoteEntry(remote.entry) ? 'loading' : 'idle'
  );

  useEffect(() => {
    if (!remote || !isHttpRemoteEntry(remote.entry)) return;
    const root = rootRef.current;
    if (!root) return;
    let disposed = false;
    let dispose: (() => void) | void;
    setRemoteState('loading');
    void loadPluginRemote(remote)
      .then((module) => {
        if (disposed) return;
        dispose = mountRemoteModule(module, root);
        setRemoteState('ready');
      })
      .catch(() => {
        if (!disposed) setRemoteState('failed');
      });
    return () => {
      disposed = true;
      dispose?.();
    };
  }, [remote, retry]);

  const surface = useMemo(
    () => ({
      pluginId: item.pluginId,
      surfaceId: String(metadata.surfaceId ?? item.id),
      label: item.label,
      generation: item.generation,
      allowedMethods: Array.isArray(metadata.allowedMethods)
        ? metadata.allowedMethods.filter((method): method is string => typeof method === 'string')
        : [],
      slot,
    }),
    [item, metadata.allowedMethods, metadata.surfaceId, slot]
  );

  if (remote && isHttpRemoteEntry(remote.entry)) {
    if (remoteState === 'failed') {
      return (
        <PluginSurfacePlaceholder
          reason="failed"
          onRecover={() => setRetry((current) => current + 1)}
        />
      );
    }
    return (
      <div className="relative h-full w-full" data-testid="plugin-remote-view">
        {remoteState !== 'ready' ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <Loader size={24} />
          </div>
        ) : null}
        <div ref={rootRef} className="h-full w-full" />
      </div>
    );
  }

  return (
    <AppSurfaceHost
      descriptor={surface}
      enabled
      transport={transport}
      variant="panel"
    />
  );
}
