import { useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { usePanelActionsContext } from '@/contexts/PanelActionsContext';
import { useProject } from '@/contexts/ProjectContext';
import { useWorktree } from '@/contexts/WorktreeContext';
import { useProjectWorktrees } from '@/hooks/useProjectWorktrees';
import { resolveSurfaceWorkspaceId } from '@/lib/surfaceWorkspace';
import { PANEL_IDS } from '@/stores/useLayoutStore';
import { CollaborationDragGhost } from './CollaborationSpacePage';
import { GroupListPanel } from './space/GroupListPanel';
import {
  CollaborationSpaceProvider,
  useCollaborationSpacePick,
  useHasCollaborationSpaceProvider,
} from './space/SpaceContext';
import './collaboration.css';

const BOTS_DOCK_PICK_KEYS = [
  'activeDirectThreadId',
  'hasThread',
  'selected',
  'selectedId',
  't',
] as const;

function BotsDockPanelInner() {
  const { openOrFocusPanel } = usePanelActionsContext();
  const { activeDirectThreadId, hasThread, selected, selectedId, t } =
    useCollaborationSpacePick(BOTS_DOCK_PICK_KEYS);
  const previousSelectionRef = useRef<string | null>(null);

  const selectionKey =
    activeDirectThreadId || selectedId || (hasThread ? 'thread' : null);

  useEffect(() => {
    if (!selectionKey) return;
    if (previousSelectionRef.current === null) {
      previousSelectionRef.current = selectionKey;
      return;
    }
    if (previousSelectionRef.current !== selectionKey) {
      previousSelectionRef.current = selectionKey;
      const title =
        selected?.name?.trim() || t('collaborationSpace.title', '协作空间');
      openOrFocusPanel(PANEL_IDS.COLLABORATION_SPACE, title);
    }
  }, [openOrFocusPanel, selected?.name, selectionKey, t]);

  return (
    <div
      className="collaboration-bots-dock flex h-full w-full flex-col overflow-hidden"
      data-testid="workspace-bots-dock-panel"
      onClick={(event) => {
        const target = event.target as HTMLElement | null;
        if (
          target?.closest(
            '[data-testid^="collaboration-space-item-"], [data-testid^="collaboration-direct-row-"], [data-testid="collaboration-supervisor-row"], [data-testid="collaboration-supervisor-button"]'
          )
        ) {
          const title =
            selected?.name?.trim() || t('collaborationSpace.title', '协作空间');
          openOrFocusPanel(PANEL_IDS.COLLABORATION_SPACE, title);
        }
      }}
    >
      <GroupListPanel />
      <CollaborationDragGhost />
    </div>
  );
}

function StandaloneBotsDockProvider() {
  const { workspaceId: routeWorkspaceId } = useParams<{
    workspaceId?: string;
  }>();
  const { projectId } = useProject();
  const { activeWorktreeId } = useWorktree();
  const { worktrees } = useProjectWorktrees(projectId);
  const surfaceWorkspaceId = resolveSurfaceWorkspaceId({
    routeWorkspaceId,
    activeWorkspaceId: activeWorktreeId,
    workspaces: worktrees.map((item) => item.workspace),
  });

  return (
    <CollaborationSpaceProvider workspaceId={surfaceWorkspaceId}>
      <BotsDockPanelInner />
    </CollaborationSpaceProvider>
  );
}

export default function WorkspaceBotsDockPanel() {
  const hasProvider = useHasCollaborationSpaceProvider();
  if (hasProvider) {
    return <BotsDockPanelInner />;
  }
  return <StandaloneBotsDockProvider />;
}
