import type {
  ConversationDelegationResult,
  ConversationDelegationView,
  MessageTurn,
} from 'shared/types';
import type { ToolResultBlock, ToolUseBlock } from '../messageTurnBlocks';
import {
  isHostDelegationTool,
  isHostDelegationLifecycleTool,
} from '../tools/subagentCardModel';

export { isHostDelegationTool, isHostDelegationLifecycleTool };

export function shouldInlineDelegationSideRow(
  parentToolCallId: string | null | undefined,
  occupiedToolUseIds: Set<string>
): boolean {
  if (parentToolCallId && occupiedToolUseIds.has(parentToolCallId)) {
    return false;
  }
  if (!parentToolCallId && occupiedToolUseIds.size > 0) {
    return false;
  }
  return true;
}

export function hostDelegationToolUseIds(turns: MessageTurn[]): Set<string> {
  const ids = new Set<string>();
  for (const turn of turns) {
    for (const block of turn.blocks) {
      if (
        block.type === 'tool_use' &&
        isHostDelegationTool(block) &&
        block.tool_use_id
      ) {
        ids.add(block.tool_use_id);
      }
    }
  }
  return ids;
}

export function matchHostDelegationView(
  use: ToolUseBlock,
  views: ConversationDelegationView[]
): ConversationDelegationView | null {
  if (!use.tool_use_id) return null;
  return (
    views.find((view) => view.parent_tool_call_id === use.tool_use_id) ?? null
  );
}

export function mergeHostDelegationView(
  use: ToolUseBlock,
  result: ToolResultBlock | null,
  event: ConversationDelegationView | null
): ConversationDelegationView {
  const input = parseRecord(use.input_preview);
  const output = parseRecord(result?.output_preview);
  const agentId =
    event?.agent_id ??
    readString(input, ['agent_id', 'agent_type']) ??
    readString(output, ['agent_id', 'agent_type']);
  const taskPreview =
    event?.task_preview ??
    readString(input, ['task', 'prompt']) ??
    readString(output, ['task', 'prompt']);
  const inferred = inferResult(result, output);

  return {
    delegation_id: event?.delegation_id ?? use.tool_use_id ?? 'host-delegation',
    parent_tool_call_id: event?.parent_tool_call_id ?? use.tool_use_id ?? null,
    child_conversation_id: event?.child_conversation_id ?? null,
    agent_id: agentId as ConversationDelegationView['agent_id'],
    task_preview: taskPreview,
    status: event?.status ?? inferred.status,
    result: event?.result ?? inferred.result,
  };
}

function inferResult(
  result: ToolResultBlock | null,
  output: Record<string, unknown> | null
): {
  status: string;
  result: ConversationDelegationResult | null;
} {
  if (result == null) {
    return { status: 'running', result: null };
  }
  const outputStatus = readString(output, ['status']);
  if (outputStatus === 'running') {
    return { status: 'running', result: null };
  }
  if (result.is_error || outputStatus === 'failed') {
    return {
      status: 'failed',
      result: {
        kind: 'err',
        error: {
          message:
            readString(output, ['message', 'error']) ??
            result.output_preview ??
            'delegation failed',
        },
      },
    };
  }
  if (
    outputStatus === 'canceled' ||
    outputStatus === 'cancelled' ||
    outputStatus === 'request_cancelled'
  ) {
    return {
      status: 'canceled',
      result: {
        kind: 'err',
        error: {
          message: readString(output, ['message', 'error']) ?? 'canceled',
          code: outputStatus,
        },
      },
    };
  }
  if (outputStatus === 'completed') {
    return {
      status: 'completed',
      result: {
        kind: 'ok',
        text_preview: readString(output, ['text', 'text_preview']),
        duration_ms: readDuration(output),
      },
    };
  }
  return { status: 'running', result: null };
}

function parseRecord(
  value: string | null | undefined
): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readString(
  record: Record<string, unknown> | null,
  keys: string[]
): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

function readDuration(record: Record<string, unknown> | null): bigint | null {
  if (!record) return null;
  const value = record.duration_ms ?? record.durationMs;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return BigInt(Math.round(value));
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return BigInt(Math.round(parsed));
  }
  return null;
}
