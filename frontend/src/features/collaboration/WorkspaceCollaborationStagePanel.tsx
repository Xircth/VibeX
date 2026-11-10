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

export default function WorkspaceCollaborationStagePanel() {
  const hasProvider = useHasCollaborationSpaceProvider();
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

  if (hasProvider) {
    return <CollaborationSpaceLayout hideSpacesPane />;
  }

  return (
    <CollaborationSpaceProvider workspaceId={surfaceWorkspaceId}>
      <CollaborationSpaceLayout hideSpacesPane />
    </CollaborationSpaceProvider>
  );
}
