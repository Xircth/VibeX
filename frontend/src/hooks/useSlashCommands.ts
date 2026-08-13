import { useCallback, useEffect, useMemo } from 'react';
import type { ExecutorProfileId, SlashCommandDescription } from 'shared/types';
import { useTauriPatchStream } from '@/hooks/useTauriPatchStream';

type SlashCommandsStreamState = {
  commands: SlashCommandDescription[];
  discovering: boolean;
  error: string | null;
};

/**
 * Slash commands streaming via Tauri backend.
 *
 * Subscribes to the `subscribe_slash_commands_stream` Tauri command which
 * dynamically discovers available slash commands from the configured Agent.
 * The Agent runtime is the sole authority for which commands are available.
 */
export function useSlashCommands(
  executorProfile: ExecutorProfileId | null | undefined,
  opts?: { workspaceId?: string; repoId?: string }
) {
  const workspaceId = opts?.workspaceId;
  const repoId = opts?.repoId;
  const executor = executorProfile?.executor;
  const variant = executorProfile?.variant ?? null;

  const profileStr = [
    executor ?? 'none',
    variant ?? 'default',
    executorProfile?.model ?? 'default-model',
    executorProfile?.fast_mode == null
      ? 'default-fast'
      : String(executorProfile.fast_mode),
    executorProfile?.reasoning_effort ?? 'default-reasoning',
  ]
    .join(':')
    .replace(/[^a-zA-Z0-9_.:-]/g, '_');
  const wsStr = workspaceId ?? 'none';
  const repoStr = repoId ?? 'none';

  const eventChannel = executor
    ? `slash-commands-stream:${profileStr}:${wsStr}:${repoStr}`
    : '';

  const subscribeArgs = useMemo(
    () =>
      executorProfile
        ? {
            executorProfileId: executorProfile,
            workspaceId: workspaceId ?? null,
            repoId: repoId ?? null,
          }
        : undefined,
    [executorProfile, workspaceId, repoId]
  );

  const initialData = useCallback(
    (): SlashCommandsStreamState => ({
      commands: [],
      discovering: false,
      error: null,
    }),
    []
  );

  const {
    data,
    isConnected,
    isInitialized,
    error: streamError,
  } = useTauriPatchStream<SlashCommandsStreamState>({
    subscribeCommand: 'subscribe_slash_commands_stream',
    subscribeArgs,
    eventChannel,
    initialData,
    enabled: !!executor,
  });

  const error = data?.error ?? streamError;
  const commands = data?.commands ?? [];

  useEffect(() => {
    if (error) {
      console.error('Failed to fetch slash commands', error);
    }
  }, [error]);

  return {
    commands,
    discovering: data?.discovering ?? false,
    error,
    isConnected,
    isInitialized,
  };
}
