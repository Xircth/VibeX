import { useCallback, useEffect, useMemo } from 'react';
import {
  BaseCodingAgent,
  type ExecutorProfileId,
  type SlashCommandDescription,
} from 'shared/types';
import { useTauriPatchStream } from '@/hooks/useTauriPatchStream';
import {
  isCoreSlashCommand,
  isSlashCommandSkill,
} from '@/lib/slashCommandPresentation';

type SlashCommandsStreamState = {
  commands: SlashCommandDescription[];
  discovering: boolean;
  error: string | null;
};

const BUILTIN_SLASH_COMMANDS: Partial<
  Record<BaseCodingAgent, SlashCommandDescription[]>
> = {
  [BaseCodingAgent.CLAUDE_CODE]: [
    ['compact', 'Compact conversation with an optional focus'],
    ['init', 'Initialize a CLAUDE.md file'],
    ['mcp', 'Manage MCP server connections'],
    ['review', 'Review a pull request'],
  ].map(([name, description]) => ({
    name,
    description,
    kind: 'COMMAND' as const,
  })),
  [BaseCodingAgent.CODEX]: [
    ['compact', 'Compact conversation with an optional focus'],
    ['goal', 'Set, inspect, pause, resume, or clear a long-running goal'],
    ['review', 'Review code with optional instructions'],
    ['init', 'Create an AGENTS.md file with repository instructions'],
    ['mcp', 'List configured MCP servers and tools'],
  ].map(([name, description]) => ({
    name,
    description,
    kind: 'COMMAND' as const,
  })),
  [BaseCodingAgent.OPENCODE]: [
    ['init', 'Create or update AGENTS.md'],
    ['compact', 'Compact the current session'],
    ['mcp', 'Show MCP server status'],
  ].map(([name, description]) => ({
    name,
    description,
    kind: 'COMMAND' as const,
  })),
};

function mergeSlashCommands(
  executor: BaseCodingAgent | null | undefined,
  fallbackCommands: SlashCommandDescription[],
  streamedCommands: SlashCommandDescription[]
): SlashCommandDescription[] {
  const isVisible = (command: SlashCommandDescription) =>
    isSlashCommandSkill(command) || isCoreSlashCommand(command, executor);

  if (fallbackCommands.length === 0) return streamedCommands.filter(isVisible);
  if (streamedCommands.length === 0) return fallbackCommands.filter(isVisible);

  const byName = new Map<string, SlashCommandDescription>();
  for (const command of fallbackCommands) {
    byName.set(command.name, command);
  }
  for (const command of streamedCommands) {
    byName.set(command.name, command);
  }

  const orderedNames = [
    ...fallbackCommands.map((command) => command.name),
    ...streamedCommands.map((command) => command.name),
  ];
  const seen = new Set<string>();
  return orderedNames.flatMap((name) => {
    if (seen.has(name)) return [];
    seen.add(name);
    const command = byName.get(name);
    return command && isVisible(command) ? [command] : [];
  });
}

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
  const streamedCommands = data?.commands ?? [];
  const fallbackCommands = executor
    ? (BUILTIN_SLASH_COMMANDS[executor] ?? [])
    : [];
  const commands = mergeSlashCommands(
    executor ?? null,
    fallbackCommands,
    streamedCommands
  );
  const hasFallbackCommands = fallbackCommands.length > 0;

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
    isInitialized: isInitialized || hasFallbackCommands,
  };
}
