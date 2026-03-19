import { useCallback, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ExecutorProfileId, PatchType } from 'shared/types';
import { useUserSystem } from '@/components/ConfigProvider';
import { usePanelActionsContext } from '@/contexts/PanelActionsContext';
import { detectDevserverUrl } from '@/hooks/useDevserverUrl';
import { usePreviewSettings } from '@/hooks/usePreviewSettings';
import { sessionsApi } from '@/lib/api';
import { PANEL_IDS } from '@/stores/useLayoutStore';
import {
  useAiDevServerStartStore,
  type AiDevServerStartState,
} from '@/stores/useAiDevServerStartStore';
import { streamJsonPatchEntries } from '@/utils/streamJsonPatchEntries';
import { getFirstAvailableProfile } from '@/utils/executor';

const AI_HOSTED_DEV_SERVER_PROMPT =
  'Analyze the current project, identify the dev-server startup configuration, safely verify or install dependencies and environment settings, then start the dev server. After health checks pass, send me the web URL or the build artifact absolute path directly in one message (without MCP/Tool notifications).';

const WINDOWS_ABSOLUTE_PATH_REGEX = /[A-Za-z]:\\[^\r\n]+/;
const POSIX_ABSOLUTE_PATH_REGEX = /\/[A-Za-z0-9._/-]+/;

function selectAssistantText(entries: PatchType[]): string[] {
  return entries
    .filter(
      (entry): entry is Extract<PatchType, { type: 'NORMALIZED_ENTRY' }> =>
        entry.type === 'NORMALIZED_ENTRY'
    )
    .filter((entry) => entry.content.entry_type.type === 'assistant_message')
    .map((entry) => entry.content.content)
    .filter((content) => content.trim().length > 0);
}

function detectAbsolutePath(text: string): string | null {
  const windowsPath = text.match(WINDOWS_ABSOLUTE_PATH_REGEX)?.[0];
  if (windowsPath) {
    return windowsPath;
  }

  const posixPath = text.match(POSIX_ABSOLUTE_PATH_REGEX)?.[0];
  return posixPath ?? null;
}

function nextCompletedState(
  previous: AiDevServerStartState | undefined,
  assistantTexts: string[]
): AiDevServerStartState {
  for (let index = assistantTexts.length - 1; index >= 0; index -= 1) {
    const text = assistantTexts[index]!;
    const detectedUrl = detectDevserverUrl(text)?.url;
    if (detectedUrl) {
      return {
        ...(previous ?? { status: 'idle' }),
        status: 'completed',
        detectedUrl,
        error: undefined,
      };
    }

    const detectedPath = detectAbsolutePath(text);
    if (detectedPath) {
      return {
        ...(previous ?? { status: 'idle' }),
        status: 'completed',
        resultPath: detectedPath,
        error: undefined,
      };
    }
  }

  return {
    ...(previous ?? { status: 'idle' }),
    status: 'completed',
    error: undefined,
  };
}

export function useAiHostedDevServerStart(workspaceId: string | undefined) {
  const queryClient = useQueryClient();
  const { profiles, config } = useUserSystem();
  const { openOrFocusPanel } = usePanelActionsContext();
  const { setOverrideUrl } = usePreviewSettings(workspaceId);
  const workspaceState = useAiDevServerStartStore(
    (state) => (workspaceId ? state.byWorkspace[workspaceId] : undefined)
  );
  const setStateForWorkspace = useAiDevServerStartStore(
    (state) => state.setStateForWorkspace
  );
  const patchStateForWorkspace = useAiDevServerStartStore(
    (state) => state.patchStateForWorkspace
  );
  const clearWorkspaceState = useAiDevServerStartStore(
    (state) => state.clearWorkspaceState
  );
  const streamControllerRef = useRef<ReturnType<
    typeof streamJsonPatchEntries<PatchType>
  > | null>(null);

  useEffect(() => {
    return () => {
      streamControllerRef.current?.close();
      streamControllerRef.current = null;
    };
  }, []);

  const start = useCallback(async () => {
    if (!workspaceId) return;
    if (
      workspaceState?.status === 'starting' ||
      workspaceState?.status === 'waiting_for_reply'
    ) {
      return;
    }

    const executorProfile: ExecutorProfileId | null =
      config?.executor_profile ?? getFirstAvailableProfile(profiles);

    if (!executorProfile) {
      setStateForWorkspace(workspaceId, {
        status: 'error',
        error: 'No available executor profile is configured.',
      });
      return;
    }

    setStateForWorkspace(workspaceId, {
      status: 'starting',
    });

    streamControllerRef.current?.close();
    streamControllerRef.current = null;

    try {
      const sessionSummaries =
        await sessionsApi.getSummariesByWorkspace(workspaceId);
      const reusableSession = sessionSummaries.find(
        (session) =>
          !session.is_running &&
          (!session.executor || session.executor === executorProfile.executor)
      );

      const targetSession = reusableSession
        ? { id: reusableSession.id }
        : await sessionsApi.create({
            workspace_id: workspaceId,
            executor: executorProfile.executor,
          });

      const executionProcess = await sessionsApi.followUp(targetSession.id, {
        prompt: AI_HOSTED_DEV_SERVER_PROMPT,
        executor_profile_id: executorProfile,
        retry_process_id: null,
        force_when_dirty: null,
        perform_git_reset: null,
      });

      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ['workspaceSessions', workspaceId],
        }),
        queryClient.invalidateQueries({
          queryKey: ['taskAttemptWithSession', workspaceId],
        }),
      ]);

      setStateForWorkspace(workspaceId, {
        status: 'waiting_for_reply',
        sessionId: targetSession.id,
        processId: executionProcess.id,
      });

      streamControllerRef.current = streamJsonPatchEntries<PatchType>(
        {
          executionProcessId: executionProcess.id,
          normalized: true,
        },
        {
          onEntries: (entries) => {
            const assistantTexts = selectAssistantText(entries);
            const nextState = nextCompletedState(
              useAiDevServerStartStore.getState().byWorkspace[workspaceId],
              assistantTexts
            );

            if (nextState.detectedUrl) {
              setOverrideUrl(nextState.detectedUrl);
              openOrFocusPanel(PANEL_IDS.DEV_PREVIEW, 'Dev Preview');
              setStateForWorkspace(workspaceId, nextState);
              streamControllerRef.current?.close();
              streamControllerRef.current = null;
            }
          },
          onFinished: (entries) => {
            const assistantTexts = selectAssistantText(entries);
            const nextState = nextCompletedState(
              useAiDevServerStartStore.getState().byWorkspace[workspaceId],
              assistantTexts
            );

            if (nextState.detectedUrl) {
              setOverrideUrl(nextState.detectedUrl);
              openOrFocusPanel(PANEL_IDS.DEV_PREVIEW, 'Dev Preview');
            }

            setStateForWorkspace(workspaceId, nextState);
            streamControllerRef.current?.close();
            streamControllerRef.current = null;
          },
          onError: (error) => {
            setStateForWorkspace(workspaceId, {
              status: 'error',
              sessionId: targetSession.id,
              processId: executionProcess.id,
              error:
                error instanceof Error
                  ? error.message
                  : 'Failed to monitor AI-hosted dev server startup.',
            });
            streamControllerRef.current?.close();
            streamControllerRef.current = null;
          },
        }
      );
    } catch (error) {
      setStateForWorkspace(workspaceId, {
        status: 'error',
        error:
          error instanceof Error
            ? error.message
            : 'Failed to start AI-hosted dev server flow.',
      });
    }
  }, [
    workspaceId,
    workspaceState?.status,
    config?.executor_profile,
    profiles,
    queryClient,
    setStateForWorkspace,
    setOverrideUrl,
    openOrFocusPanel,
  ]);

  const reset = useCallback(() => {
    if (!workspaceId) return;
    streamControllerRef.current?.close();
    streamControllerRef.current = null;
    clearWorkspaceState(workspaceId);
  }, [workspaceId, clearWorkspaceState]);

  const clearError = useCallback(() => {
    if (!workspaceId) return;
    patchStateForWorkspace(workspaceId, {
      status: 'idle',
      error: undefined,
    });
  }, [workspaceId, patchStateForWorkspace]);

  return {
    state: workspaceState,
    start,
    reset,
    clearError,
    isBusy:
      workspaceState?.status === 'starting' ||
      workspaceState?.status === 'waiting_for_reply',
  };
}

