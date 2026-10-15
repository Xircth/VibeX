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
  retainPluginRemote,
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

async function remoteEntryAvailable(entry: string): Promise<boolean> {
  try {
    const response = await fetch(entry, {
      method: 'GET',
      signal: AbortSignal.timeout(1500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

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
  slot:
    | 'app.panel'
    | 'app.tab'
    | 'app.kanban.view'
    | 'app.settings.page'
    | 'status.after-mcp';
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
  slot:
    | 'app.panel'
    | 'app.tab'
    | 'app.kanban.view'
    | 'app.settings.page'
    | 'status.after-mcp';
  workspaceId: string | null;
  projectId: string | null;
}) {
  const metadata = contributionMetadata(item);
  const remote = useMemo(() => {
    const parsed = parseRemoteRef(metadata.remote);
    if (!parsed || !isHttpRemoteEntry(parsed.entry)) return parsed;
    const separator = parsed.entry.includes('?') ? '&' : '?';
    return {
      ...parsed,
      entry: `${parsed.entry}${separator}g=${item.generation}`,
    };
  }, [item.generation, metadata.remote]);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [remoteState, setRemoteState] = useState<
    'idle' | 'loading' | 'ready' | 'failed'
  >(remote && isHttpRemoteEntry(remote.entry) ? 'loading' : 'idle');
  const surfaceId = item.id;

  useEffect(() => {
    if (!remote || !isHttpRemoteEntry(remote.entry)) return;
    const root = rootRef.current;
    if (!root) return;
    retainPluginRemote(remote.name);
    let disposed = false;
    let dispose: (() => void) | void;
    let revoke: (() => void) | undefined;
    setRemoteState('loading');
    const clientToken = opaqueToken();
    void remoteEntryAvailable(remote.entry)
      .then((available) => {
        if (!available) throw new Error('plugin_remote_unavailable');
        return loadPluginRemote(remote);
      })
      .then(async (module) => {
        if (disposed) return;
        let sequence = 0;
        let invokeQueue: Promise<unknown> = Promise.resolve();
        let sessionToken: string | null = null;
        const openSession = async (): Promise<string | null> => {
          try {
            const session = await transport.load({
              pluginId: item.pluginId,
              surfaceId,
              generation: item.generation,
              token: clientToken,
            });
            sequence = 0;
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
            return session.token;
          } catch {
            sessionToken = null;
            return null;
          }
        };
        await openSession();
        if (disposed) return;
        const toError = (err: unknown): Error => {
          if (err instanceof Error) return err;
          if (err && typeof err === 'object') {
            const rec = err as Record<string, unknown>;
            if (typeof rec.message === 'string' && rec.message.trim()) {
              return new Error(rec.message);
            }
          }
          return new Error(typeof err === 'string' ? err : 'Plugin invoke failed');
        };
        dispose = mountRemoteModule(module, root, {
          pluginId: item.pluginId,
          surfaceId,
          slot,
          workspaceId,
          projectId,
          invoke: (handler, input) => {
            const run = async () => {
              let activeToken = sessionToken ?? (await openSession());
              if (!activeToken) {
                throw new Error('Plugin Worker is not available');
              }
              sequence += 1;
              try {
                return await transport.invoke({
                  pluginId: item.pluginId,
                  surfaceId,
                  generation: item.generation,
                  token: activeToken,
                  requestId: crypto.randomUUID(),
                  sequence,
                  method: handler,
                  params: (input ?? {}) as never,
                });
              } catch (err) {
                const msg = toError(err).message.toLowerCase();
                if (
                  msg.includes('expired') ||
                  msg.includes('revoked') ||
                  msg.includes('sequence is invalid')
                ) {
                  activeToken = await openSession();
                  if (activeToken) {
                    sequence += 1;
                    try {
                      return await transport.invoke({
                        pluginId: item.pluginId,
                        surfaceId,
                        generation: item.generation,
                        token: activeToken,
                        requestId: crypto.randomUUID(),
                        sequence,
                        method: handler,
                        params: (input ?? {}) as never,
                      });
                    } catch (retryErr) {
                      throw toError(retryErr);
                    }
                  }
                }
                throw toError(err);
              }
            };
            const next = invokeQueue.then(run, run);
            invokeQueue = next.catch(() => undefined);
            return next;
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

  const surfaceVariant =
    slot === 'app.tab' ||
    slot === 'app.kanban.view' ||
    slot === 'app.settings.page'
      ? 'editor'
      : 'panel';

  if (remote && isHttpRemoteEntry(remote.entry)) {
    if (remoteState === 'failed') {
      return (
        <AppSurfaceHost
          descriptor={surface}
          enabled
          transport={transport}
          variant={surfaceVariant}
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
      variant={surfaceVariant}
    />
  );
}
