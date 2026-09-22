import type { IDockviewPanelProps } from 'dockview-react';
import { useParams } from 'react-router-dom';
import { PluginRemoteView } from '@/components/plugins/PluginRemoteView';
import { HostBrowserPanel } from '@/features/host-browser/HostBrowserPanel';
import {
  contributionMetadata,
  usePluginHostContributions,
} from '@/hooks/usePluginHostContributions';
import { parsePluginSurfaceId } from '@/lib/hostSurfaceIds';

export default function PluginDockviewPanel(props: IDockviewPanelProps) {
  const params = (props.params ?? {}) as {
    pluginId?: string;
    contributionId?: string;
    requestedUrl?: string | null;
  };
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const parsed = parsePluginSurfaceId(props.api.id);
  const pluginId = params.pluginId ?? parsed?.pluginId ?? '';
  const contributionId = params.contributionId ?? parsed?.contributionId ?? '';
  const panels = usePluginHostContributions('app_panel');
  const item =
    panels.find(
      (panel) => panel.pluginId === pluginId && panel.id === contributionId
    ) ?? null;
  const engine = item != null ? contributionMetadata(item).engine : null;

  if (engine === 'host-browser' && pluginId) {
    return (
      <HostBrowserPanel
        pluginId={pluginId}
        panelVisible={props.api.isVisible}
        requestedUrl={params.requestedUrl}
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
