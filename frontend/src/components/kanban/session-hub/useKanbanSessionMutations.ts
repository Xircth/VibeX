import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ScratchType,
  type ExecutorProfileId,
  type Session,
} from 'shared/types';
import { scratchApi, sessionsApi } from '@/lib/api';
import type { WorkspaceBranchOption } from '@/lib/workspaceBranchOptions';
import type { SessionControlsPreset } from '@/components/sessions/SessionCreationForm';
import {
  getCreateProjectSessionRequest,
  type KanbanSessionCreationMode,
} from './utils';

export interface CreateKanbanSessionMutationInput {
  workspaceValue: string;
  sessionName: string;
  executorProfile: ExecutorProfileId | null;
  mode: KanbanSessionCreationMode;
  /** ACP control picks made in the create form, applied on the first turn. */
  sessionControls?: SessionControlsPreset | null;
}

export interface RenameKanbanSessionMutationInput {
  sessionId: string;
  name: string | null;
  workspaceId: string;
}

export function useKanbanSessionMutations({
  projectId,
  primaryRepoId,
  workspaceBranchOptions,
  getWorkspaceRepoInputs,
  placeCreatedSession,
  addPendingCreatedSession,
  clearCreateSessionName,
  closeCreatePopover,
}: {
  projectId: string | null | undefined;
  primaryRepoId: string | null | undefined;
  workspaceBranchOptions: WorkspaceBranchOption[];
  getWorkspaceRepoInputs: () => Array<{
    repo_id: string;
    target_branch: string;
  }>;
  placeCreatedSession: (placement: {
    sessionId: string;
    workspaceId: string;
  }) => void;
  addPendingCreatedSession: (sessionId: string) => void;
  clearCreateSessionName: () => void;
  closeCreatePopover: () => void;
}) {
  const queryClient = useQueryClient();

  const createSessionMutation = useMutation({
    mutationFn: async ({
      workspaceValue,
      sessionName,
      executorProfile,
      mode,
      sessionControls,
    }: CreateKanbanSessionMutationInput): Promise<Session> => {
      const session = await sessionsApi.createProject({
        ...getCreateProjectSessionRequest({
          projectId,
          workspaceValue,
          sessionName,
          executorProfile,
          mode,
          workspaceBranchOptions,
          repoInputs:
            mode === 'new_workspace' ? getWorkspaceRepoInputs() : undefined,
        }),
      });

      if (executorProfile?.executor) {
        await scratchApi.update(ScratchType.DRAFT_FOLLOW_UP, session.id, {
          payload: {
            type: 'DRAFT_FOLLOW_UP',
            data: {
              message: '',
              images: [],
              executor_config: executorProfile,
              queued: false,
              mode_override: sessionControls?.modeOverride ?? undefined,
              config_overrides: sessionControls?.configOverrides ?? {},
            },
          },
        });
      }

      return session;
    },
    onSuccess: (session) => {
      queryClient.invalidateQueries({
        queryKey: ['kanbanProjectWorkspaces', projectId],
      });
      queryClient.invalidateQueries({
        queryKey: ['projectWorktrees', projectId],
      });
      if (primaryRepoId) {
        queryClient.invalidateQueries({
          queryKey: ['repoBranches', primaryRepoId],
        });
      }
      queryClient.invalidateQueries({
        queryKey: ['workspaceSessions', session.workspace_id],
      });
      placeCreatedSession({
        sessionId: session.id,
        workspaceId: session.workspace_id,
      });
      addPendingCreatedSession(session.id);
      clearCreateSessionName();
      closeCreatePopover();
    },
  });

  const renameSessionMutation = useMutation({
    mutationFn: async ({
      sessionId,
      name,
      workspaceId,
    }: RenameKanbanSessionMutationInput) => {
      await sessionsApi.rename(sessionId, name);
      return { sessionId, workspaceId };
    },
    onSuccess: ({ sessionId, workspaceId }) => {
      queryClient.invalidateQueries({
        queryKey: ['workspaceSessions', workspaceId],
      });
      queryClient.invalidateQueries({
        queryKey: ['session', sessionId],
      });
    },
  });

  return { createSessionMutation, renameSessionMutation };
}
