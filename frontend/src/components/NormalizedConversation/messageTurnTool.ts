import type { ActionType, JsonValue, NormalizedEntry } from 'shared/types';
import type { ToolResultBlock, ToolUseBlock } from './messageTurnBlocks';

/**
 * Adapts a unified-timeline tool block (the codeg-aligned `ContentBlock`
 * tool_use + paired tool_result) into a legacy `NormalizedEntry`, so the new
 * timeline can reuse VibeX's existing rich tool cards (file/search/command/
 * generic) via `DisplayConversationEntry`. Mirrors codeg's route-A approach of
 * parsing the full tool input at render time. VibeX-authored.
 *
 * Single-field tools (read/search/web/bash) map to their dedicated action; every
 * other tool maps to the generic `tool` action (structured arg + output viewer).
 */

function parseInput(use: ToolUseBlock): unknown {
  if (!use.input_preview) return null;
  try {
    return JSON.parse(use.input_preview);
  } catch {
    return use.input_preview;
  }
}

function firstString(
  obj: Record<string, unknown>,
  ...keys: string[]
): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function toolActionType(
  toolName: string,
  parsed: unknown,
  output: string | null
): ActionType {
  const name = toolName.toLowerCase();
  const obj =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};

  if (name === 'read' || name === 'read_file' || name === 'readfile') {
    const path = firstString(obj, 'file_path', 'path', 'filename');
    if (path) return { action: 'file_read', path };
  }
  if (name === 'grep' || name === 'glob' || name === 'search') {
    return { action: 'search', query: firstString(obj, 'pattern', 'query', 'q') ?? '' };
  }
  if (
    name === 'webfetch' ||
    name === 'websearch' ||
    name === 'web_fetch' ||
    name === 'fetch'
  ) {
    return { action: 'web_fetch', url: firstString(obj, 'url', 'query') ?? '' };
  }
  if (
    name === 'bash' ||
    name === 'shell' ||
    name === 'exec_command' ||
    name === 'command'
  ) {
    return {
      action: 'command_run',
      command: firstString(obj, 'command', 'cmd', 'script') ?? '',
      // Exit status isn't carried in the parsed transcript; show output only.
      result: output != null ? { exit_status: null, output } : null,
    };
  }

  return {
    action: 'tool',
    tool_name: toolName,
    arguments: (parsed ?? null) as JsonValue,
    result: output != null ? { type: { type: 'markdown' }, value: output } : null,
  };
}

export function toolBlockToNormalizedEntry(
  use: ToolUseBlock,
  result: ToolResultBlock | null,
  timestamp: string | null
): NormalizedEntry {
  const output = result?.output_preview ?? null;
  const status = result
    ? result.is_error
      ? ({ status: 'failed' } as const)
      : ({ status: 'success' } as const)
    : ({ status: 'created' } as const);

  return {
    timestamp,
    content: use.tool_name,
    entry_type: {
      type: 'tool_use',
      tool_name: use.tool_name,
      action_type: toolActionType(use.tool_name, parseInput(use), output),
      status,
    },
  };
}
