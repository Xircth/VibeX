import type { ContentBlock, MessageTurn } from 'shared/types';

const LONG_RUNNING_COMMAND =
  /\b(?:pnpm|npm|yarn|bun)(?:\s+run)?\s+(?:dev|start|serve)\b|\b(?:next|vite|nuxt|astro)\s+dev\b|\bcargo\s+(?:run|watch)\b|\b(?:nodemon|watchexec)\b|\bpython(?:\d+)?\s+-m\s+(?:http\.server|uvicorn|flask)\b|--watch\b/i;

const SHELL_TOOL_NAMES = new Set([
  'bash',
  'shell',
  'sh',
  'zsh',
  'exec',
  'execute',
  'command',
  'run',
  'terminal',
  'localshell',
]);

export function isLongRunningAgentCommand(command: string): boolean {
  return LONG_RUNNING_COMMAND.test(command.trim());
}

export type AgentCommandCapture = {
  toolUseId: string;
  command: string;
  output: string;
  running: boolean;
};

function commandFromToolUse(
  block: Extract<ContentBlock, { type: 'tool_use' }>
): string | null {
  const kind = block.kind?.toLowerCase() ?? '';
  const name = block.tool_name.trim().toLowerCase();
  const isShell =
    kind === 'execute' || SHELL_TOOL_NAMES.has(name.replace(/[_\s-]/g, ''));
  if (!isShell) {
    return null;
  }

  const preview = block.input_preview?.trim() ?? '';
  if (!preview) {
    return block.tool_name.trim() || null;
  }
  try {
    const parsed = JSON.parse(preview) as unknown;
    if (typeof parsed === 'string' && parsed.trim()) {
      return parsed.trim();
    }
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      for (const key of ['command', 'cmd', 'script']) {
        const value = record[key];
        if (typeof value === 'string' && value.trim()) {
          return value.trim();
        }
      }
    }
  } catch {
    return preview;
  }
  return preview;
}

export function agentCommandCapturesFromTurn(
  turn: MessageTurn
): AgentCommandCapture[] {
  const results = new Map<
    string,
    Extract<ContentBlock, { type: 'tool_result' }>
  >();
  for (const block of turn.blocks) {
    if (block.type === 'tool_result' && block.tool_use_id) {
      results.set(block.tool_use_id, block);
    }
  }

  const captures: AgentCommandCapture[] = [];
  for (const block of turn.blocks) {
    if (block.type !== 'tool_use') {
      continue;
    }
    const command = commandFromToolUse(block);
    if (!command || !isLongRunningAgentCommand(command)) {
      continue;
    }
    const toolUseId = block.tool_use_id ?? `${turn.id}:${command}`;
    const result = results.get(toolUseId);
    captures.push({
      toolUseId,
      command,
      output: result?.output_preview ?? '',
      running: !result,
    });
  }
  return captures;
}
