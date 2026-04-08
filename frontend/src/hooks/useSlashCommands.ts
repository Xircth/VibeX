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
 * dynamically discovers available slash commands from the Claude Code CLI
 * (or other configured agent). Returns both hardcoded built-in commands
 * and dynamically discovered custom commands / skills.
 */
export function useSlashCommands(
  executorProfile: ExecutorProfileId | null | undefined,
  opts?: { workspaceId?: string; repoId?: string }
) {
  const workspaceId = opts?.workspaceId;
  const repoId = opts?.repoId;
  const executor = executorProfile?.executor;
  const variant = executorProfile?.variant ?? null;

  const variantStr = variant ?? 'default';
  const wsStr = workspaceId ?? 'none';
  const repoStr = repoId ?? 'none';

  const eventChannel = executor
    ? `slash-commands-stream:${executor}:${variantStr}:${wsStr}:${repoStr}`
    : '';

  const subscribeArgs = useMemo(
    () =>
      executor
        ? {
            executorProfileId: { executor, variant },
            workspaceId: workspaceId ?? null,
            repoId: repoId ?? null,
          }
        : undefined,
    [executor, variant, workspaceId, repoId]
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

  useEffect(() => {
    if (error) {
      console.error('Failed to fetch slash commands', error);
    }
  }, [error]);

  return {
    commands: data?.commands ?? [],
    discovering: data?.discovering ?? false,
    error,
    isConnected,
    isInitialized,
  };
}
