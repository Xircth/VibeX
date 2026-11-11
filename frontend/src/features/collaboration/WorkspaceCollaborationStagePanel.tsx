import { useMemo } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { useParams } from 'react-router-dom';
import { useProject } from '@/contexts/ProjectContext';
import { useWorktree } from '@/contexts/WorktreeContext';
import { useProjectWorktrees } from '@/hooks/useProjectWorktrees';
import { resolveSurfaceWorkspaceId } from '@/lib/surfaceWorkspace';
import { CollaborationSpaceLayout } from './CollaborationSpacePage';
import {
  CollaborationSpaceProvider,
  useHasCollaborationSpaceProvider,
} from './space/SpaceContext';
import type { SpaceInitialTarget } from './space/types';

export interface WorkspaceCollaborationStageParams {
  targetType?: 'direct' | 'group';
  spaceId?: string;
  spaceName?: string;
  threadId?: string;
  conversationId?: string;
  memberId?: string;
  memberNickname?: string;
  workspaceId?: string;
}

export default function WorkspaceCollaborationStagePanel(
  props?: Partial<IDockviewPanelProps<WorkspaceCollaborationStageParams>>
) {
  const params = props?.params;
  const hasProvider = useHasCollaborationSpaceProvider();
  const { workspaceId: routeWorkspaceId } = useParams<{
    workspaceId?: string;
  }>();
  const { projectId } = useProject();
  const { activeWorktreeId } = useWorktree();
  const { worktrees } = useProjectWorktrees(projectId);
  const surfaceWorkspaceId =
    (typeof params?.workspaceId === 'string' && params.workspaceId) ||
    resolveSurfaceWorkspaceId({
      routeWorkspaceId,
      activeWorkspaceId: activeWorktreeId,
      workspaces: worktrees.map((item) => item.workspace),
    });

  const scopedInitialTarget = useMemo<SpaceInitialTarget | null>(() => {
    if (params?.targetType !== 'direct' && params?.targetType !== 'group') {
      return null;
    }
    return {
      targetType: params.targetType,
      spaceId: typeof params.spaceId === 'string' ? params.spaceId : undefined,
      spaceName:
        typeof params.spaceName === 'string' ? params.spaceName : undefined,
      threadId:
        typeof params.threadId === 'string' ? params.threadId : undefined,
      conversationId:
        typeof params.conversationId === 'string'
          ? params.conversationId
          : undefined,
      memberId:
        typeof params.memberId === 'string' ? params.memberId : undefined,
      memberNickname:
        typeof params.memberNickname === 'string'
          ? params.memberNickname
          : undefined,
    };
  }, [
    params?.conversationId,
    params?.memberId,
    params?.memberNickname,
    params?.spaceId,
    params?.spaceName,
    params?.targetType,
    params?.threadId,
  ]);

  if (scopedInitialTarget) {
    return (
      <CollaborationSpaceProvider
        workspaceId={surfaceWorkspaceId}
        initialTarget={scopedInitialTarget}
      >
        <CollaborationSpaceLayout hideSpacesPane />
      </CollaborationSpaceProvider>
    );
  }

  if (hasProvider) {
    return <CollaborationSpaceLayout hideSpacesPane />;
  }

  return (
    <CollaborationSpaceProvider workspaceId={surfaceWorkspaceId}>
      <CollaborationSpaceLayout hideSpacesPane />
    </CollaborationSpaceProvider>
  );
}
