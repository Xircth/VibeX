import {
  contributionMetadata,
  usePluginHostContributions,
} from '@/hooks/usePluginHostContributions';
import { useKanbanViews } from '@/hooks/useKanbanViews';
import { parsePluginSurfaceId } from '@/lib/hostSurfaceIds';
import { useKanbanSessionContext } from '@/contexts/KanbanSessionContext';

export function useActiveSurfaceHidesBottomDock(activeTab: string): boolean {
  const pluginTabs = usePluginHostContributions('app_tab');
  const kanbanViews = useKanbanViews();
  const { activeViewId } = useKanbanSessionContext();

  if (activeTab === 'workspace') return false;
  if (activeTab === 'kanban') {
    const view = kanbanViews.find((item) => item.id === activeViewId);
    return view?.hidesBottomDock !== false;
  }
  const parsed = parsePluginSurfaceId(activeTab);
  if (!parsed) return true;
  const tab = pluginTabs.find(
    (item) => item.pluginId === parsed.pluginId && item.id === parsed.contributionId
  );
  if (!tab) return true;
  return contributionMetadata(tab).hidesBottomDock !== false;
}
