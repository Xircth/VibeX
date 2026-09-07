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
  unloadPluginRemote,
} from '@/lib/pluginFederation';
import type { PluginContributionCatalogItem } from '@/lib/api/plugins';
import { contributionMetadata } from '@/hooks/usePluginHostContributions';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  Component,
} from 'react';

const transport = createBackendAppSurfaceTransport(configuredBackendTransport);

function opaqueToken(): string {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    ''
  );
}

export function PluginRemoteView({
  item,
  slot,
  enabled = true,
  workspaceId = null,
  projectId = null,
}: {
  item: PluginContributionCatalogItem | null;
  slot: 'app.panel' | 'app.tab' | 'app.kanban.view' | 'app.settings.page';
  enabled?: boolean;
  workspaceId?: string | null;
  projectId?: string | null;
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
      <PluginRemoteViewBody
        key={`${item.pluginId}:${item.id}:${retry}`}
        item={item}
        slot={slot}
        workspaceId={workspaceId}
        projectId={projectId}
      />
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
  workspaceId,
  projectId,
}: {
  item: PluginContributionCatalogItem;
  slot: 'app.panel' | 'app.tab' | 'app.kanban.view' | 'app.settings.page';
  workspaceId: string | null;
  projectId: string | null;
}) {
  const metadata = contributionMetadata(item);
  const remote = useMemo(
    () => parseRemoteRef(metadata.remote),
    [metadata.remote]
  );
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [retry, setRetry] = useState(0);
  const [remoteState, setRemoteState] = useState<
    'idle' | 'loading' | 'ready' | 'failed'
  >(remote && isHttpRemoteEntry(remote.entry) ? 'loading' : 'idle');
  const surfaceId = item.id;

  useEffect(() => {
    if (!remote || !isHttpRemoteEntry(remote.entry)) return;
    const root = rootRef.current;
    if (!root) return;
    let disposed = false;
    let dispose: (() => void) | void;
    let revoke: (() => void) | undefined;
    setRemoteState('loading');
    const clientToken = opaqueToken();
    void loadPluginRemote(remote)
      .then(async (module) => {
        if (disposed) return;
        let sequence = 0;
        let sessionToken: string | null = null;
        try {
          const session = await transport.load({
            pluginId: item.pluginId,
            surfaceId,
            generation: item.generation,
            token: clientToken,
          });
          sessionToken = session.token;
          revoke = () => {
            void transport.revoke({
              pluginId: item.pluginId,
              surfaceId,
              generation: item.generation,
              token: session.token,
              reason: 'unmount',
            });
          };
        } catch {
          sessionToken = null;
        }
        if (disposed) return;
        dispose = mountRemoteModule(module, root, {
          pluginId: item.pluginId,
          surfaceId,
          slot,
          workspaceId,
          projectId,
          invoke: (handler, input) => {
            if (!sessionToken) {
              return Promise.reject(
                new Error('Plugin Worker is not available')
              );
            }
            sequence += 1;
            return transport.invoke({
              pluginId: item.pluginId,
              surfaceId,
              generation: item.generation,
              token: sessionToken,
              requestId: crypto.randomUUID(),
              sequence,
              method: handler,
              params: (input ?? {}) as never,
            });
          },
        });
        setRemoteState('ready');
      })
      .catch(() => {
        if (!disposed) setRemoteState('failed');
      });
    return () => {
      disposed = true;
      dispose?.();
      revoke?.();
      unloadPluginRemote(remote.name);
    };
  }, [
    item.generation,
    item.pluginId,
    projectId,
    remote,
    retry,
    slot,
    surfaceId,
    workspaceId,
  ]);

  const surface = useMemo(
    () => ({
      pluginId: item.pluginId,
      surfaceId,
      label: item.label,
      generation: item.generation,
      allowedMethods: Array.isArray(metadata.allowedMethods)
        ? metadata.allowedMethods.filter(
            (method): method is string => typeof method === 'string'
          )
        : [],
      slot,
    }),
    [item, metadata.allowedMethods, slot, surfaceId]
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
