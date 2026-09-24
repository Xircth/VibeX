import { useEffect, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { useParams } from 'react-router-dom';
import { PluginRemoteView } from '@/components/plugins/PluginRemoteView';
import { HostBrowserPanel } from '@/features/host-browser/HostBrowserPanel';
import { isHostBrowserEngine } from '@/features/host-browser/hostBrowserEngine';
import {
  contributionMetadata,
  usePluginHostContributions,
} from '@/hooks/usePluginHostContributions';
import { parsePluginSurfaceId } from '@/lib/hostSurfaceIds';
import { isWorkspaceSurfaceActive } from '@/lib/workspaceSurface';
import { useLayoutStore } from '@/stores/useLayoutStore';

export default function PluginDockviewPanel(props: IDockviewPanelProps) {
  const params = (props.params ?? {}) as {
    pluginId?: string;
    contributionId?: string;
    requestedUrl?: string | null;
    nativeTabId?: string | null;
  };
  const { workspaceId, sessionId } = useParams<{
    workspaceId?: string;
    sessionId?: string;
  }>();
  const activeTab = useLayoutStore((state) => state.activeTab);
  const [dockVisible, setDockVisible] = useState(props.api.isVisible);
  useEffect(() => {
    setDockVisible(props.api.isVisible);
    const disposable = props.api.onDidVisibilityChange?.((event) => {
      setDockVisible(event.isVisible);
    });
    return () => disposable?.dispose();
  }, [props.api]);
  const parsed = parsePluginSurfaceId(props.api.id);
  const pluginId = params.pluginId ?? parsed?.pluginId ?? '';
  const contributionId = params.contributionId ?? parsed?.contributionId ?? '';
  const panels = usePluginHostContributions('app_panel');
  const item =
    panels.find(
      (panel) => panel.pluginId === pluginId && panel.id === contributionId
    ) ?? null;
  const panelVisible =
    dockVisible &&
    isWorkspaceSurfaceActive(workspaceId, sessionId, activeTab);

  if (
    pluginId &&
    isHostBrowserEngine(pluginId, item ? contributionMetadata(item) : null)
  ) {
    return (
      <HostBrowserPanel
        pluginId={pluginId}
        panelVisible={panelVisible}
        requestedUrl={params.requestedUrl}
        nativeTabId={
          typeof params.nativeTabId === 'string' ? params.nativeTabId : null
        }
        panelApi={props.api}
      />
    );
  }

  return (
    <PluginRemoteView
      item={item}
      slot="app.panel"
      enabled
      workspaceId={workspaceId ?? null}
    />
  );
}
