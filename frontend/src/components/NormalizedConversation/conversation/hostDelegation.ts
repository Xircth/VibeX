import type {
  ConversationDelegationResult,
  ConversationDelegationView,
  MessageTurn,
} from 'shared/types';
import type { ToolResultBlock, ToolUseBlock } from '../messageTurnBlocks';
import {
  isHostDelegationTool,
  isHostDelegationLifecycleTool,
  hostDelegationLifecycleKind,
  peelHostDelegationCall,
} from '../tools/subagentCardModel';

export {
  isHostDelegationTool,
  isHostDelegationLifecycleTool,
  hostDelegationLifecycleKind,
};

export function shouldInlineDelegationSideRow(
  _parentToolCallId: string | null | undefined,
  _occupiedToolUseIds: Set<string>
): boolean {
  return false;
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
  if (use.tool_use_id) {
    const exact = views.find(
      (view) => view.parent_tool_call_id === use.tool_use_id
    );
    if (exact) return exact;
  }
  const input = peelHostDelegationCall(use).input;
  const agentId = readString(input, ['agent_id', 'agent_type']);
  const task = readString(input, ['task', 'prompt']);
  const byFacts = views.find((view) => {
    const agentOk = !agentId || !view.agent_id || view.agent_id === agentId;
    const taskOk = taskPreviewMatches(view.task_preview, task);
    return agentOk && taskOk && Boolean(agentId || task);
  });
  if (byFacts) return byFacts;
  const unmatched = views.filter(
    (view) =>
      !view.parent_tool_call_id ||
      view.parent_tool_call_id.startsWith('delegation-')
  );
  if (unmatched.length === 1 && (agentId || task)) {
    return unmatched[0];
  }
  return null;
}

export function collectHostDelegationPollResults(
  calls: Array<{ use?: ToolUseBlock | null; result?: ToolResultBlock | null }>
): ToolResultBlock[] {
  return calls.flatMap(({ use, result }) => {
    if (!use || !result) return [];
    if (hostDelegationLifecycleKind(use) !== 'status') return [];
    return [result];
  });
}

export function mergeHostDelegationView(
  use: ToolUseBlock,
  result: ToolResultBlock | null,
  event: ConversationDelegationView | null,
  pollResults: readonly ToolResultBlock[] = []
): ConversationDelegationView {
  const input = peelHostDelegationCall(use).input;
  const output = parseRecord(result?.output_preview);
  const agentId =
    event?.agent_id ??
    readString(input, ['agent_id', 'agent_type']) ??
    readString(output, ['agent_id', 'agent_type']);
  const inferred = inferResult(result, output);
  const childConversationId =
    event?.child_conversation_id ??
    readString(output, ['child_session_id', 'child_conversation_id']);
  const pollTask = matchPollTask(pollResults, {
    childId: childConversationId,
    taskId: readString(output, ['task_id']),
    agentId,
  });
  const pollInferred = inferResult(null, pollTask);
  const taskPreview = fullerText(
    readString(input, ['task', 'prompt']) ??
      readString(output, ['task', 'prompt']),
    event?.task_preview ?? null
  );
  const mergedResult = mergeResultText(
    mergeResultText(event?.result ?? null, pollInferred.result),
    inferred.result
  );

  return {
    delegation_id: event?.delegation_id ?? use.tool_use_id ?? 'host-delegation',
    parent_tool_call_id: event?.parent_tool_call_id ?? use.tool_use_id ?? null,
    child_conversation_id:
      childConversationId ??
      readString(pollTask, ['child_session_id', 'child_conversation_id']),
    agent_id: agentId as ConversationDelegationView['agent_id'],
    task_preview: taskPreview,
    status:
      terminalStatus(event?.status) ??
      terminalStatus(pollInferred.status) ??
      event?.status ??
      inferred.status,
    result: mergedResult,
  };
}

function matchPollTask(
  pollResults: readonly ToolResultBlock[],
  keys: {
    childId: string | null;
    taskId: string | null;
    agentId: string | null;
  }
): Record<string, unknown> | null {
  const tasks = pollResults.flatMap(pollTasks);
  if (tasks.length === 0) return null;
  if (keys.childId) {
    const byChild = tasks.find(
      (task) =>
        readString(task, ['child_session_id', 'child_conversation_id']) ===
        keys.childId
    );
    if (byChild) return byChild;
  }
  if (keys.taskId) {
    const byTask = tasks.find(
      (task) => readString(task, ['task_id']) === keys.taskId
    );
    if (byTask) return byTask;
  }
  if (keys.agentId) {
    const byAgent = tasks.filter(
      (task) => readString(task, ['agent_id', 'agent_type']) === keys.agentId
    );
    if (byAgent.length === 1) return byAgent[0];
  }
  return tasks.length === 1 ? tasks[0] : null;
}

function pollTasks(result: ToolResultBlock): Record<string, unknown>[] {
  const output = parseRecord(result.output_preview);
  if (!output) return [];
  const list = Array.isArray(output.tasks) ? output.tasks : [output];
  return list.flatMap((task) => {
    if (!task || typeof task !== 'object' || Array.isArray(task)) return [];
    return [task as Record<string, unknown>];
  });
}

function fullerText(
  left: string | null | undefined,
  right: string | null | undefined
): string | null {
  if (!left) return right ?? null;
  if (!right) return left;
  const leftCore = stripTrailingEllipsis(left);
  const rightCore = stripTrailingEllipsis(right);
  if (right.startsWith(leftCore) && right.length >= left.length) return right;
  if (left.startsWith(rightCore) && left.length >= right.length) return left;
  return left.length >= right.length ? left : right;
}

function stripTrailingEllipsis(text: string): string {
  return text.replace(/(?:\u2026|\.{3}|…)$/u, '');
}

function mergeResultText(
  primary: ConversationDelegationResult | null,
  fallback: ConversationDelegationResult | null
): ConversationDelegationResult | null {
  if (primary?.kind === 'err') return primary;
  if (primary?.kind !== 'ok') return fallback ?? primary;
  if (fallback?.kind !== 'ok') return primary;
  return {
    kind: 'ok',
    text_preview: fullerText(primary.text_preview, fallback.text_preview),
    duration_ms: mergeDuration(primary.duration_ms, fallback.duration_ms),
  };
}

function mergeDuration(
  left: bigint | number | null | undefined,
  right: bigint | number | null | undefined
): bigint | null {
  const a = positiveDuration(left);
  const b = positiveDuration(right);
  if (a != null && b != null) return a >= b ? a : b;
  return a ?? b;
}

function positiveDuration(
  value: bigint | number | null | undefined
): bigint | null {
  if (value == null) return null;
  if (typeof value === 'bigint') return value > 0n ? value : null;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return BigInt(Math.round(value));
  }
  return null;
}

function terminalStatus(status: string | null | undefined): string | null {
  if (
    status === 'completed' ||
    status === 'failed' ||
    status === 'canceled' ||
    status === 'cancelled'
  ) {
    return status === 'cancelled' ? 'canceled' : status;
  }
  return null;
}

function taskPreviewMatches(
  preview: string | null | undefined,
  task: string | null
): boolean {
  if (!preview || !task) return false;
  if (preview === task) return true;
  const stripped = stripTrailingEllipsis(preview);
  return Boolean(stripped) && task.startsWith(stripped);
}

function inferResult(
  result: ToolResultBlock | null,
  output: Record<string, unknown> | null
): {
  status: string;
  result: ConversationDelegationResult | null;
} {
  if (result == null && output == null) {
    return { status: 'running', result: null };
  }
  const outputStatus = readString(output, ['status']);
  if (outputStatus === 'running') {
    return { status: 'running', result: null };
  }
  if (result?.is_error || outputStatus === 'failed') {
    return {
      status: 'failed',
      result: {
        kind: 'err',
        error: {
          message:
            readString(output, ['message', 'error']) ??
            result?.output_preview ??
            'delegation failed',
          kind: 'unknown',
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
          kind: 'cancelled',
        },
      },
    };
  }
  if (
    outputStatus === 'completed' ||
    outputStatus === 'success' ||
    outputStatus === 'ok'
  ) {
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

export type HostDelegationLifecycleStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'canceled';

export function hostDelegationLifecycleStatus(
  result: ToolResultBlock | null
): HostDelegationLifecycleStatus {
  if (!result) return 'running';
  const output = parseRecord(result.output_preview);
  const tasks = Array.isArray(output?.tasks) ? output.tasks : [];
  const statuses = tasks.flatMap((task) => {
    if (!task || typeof task !== 'object' || Array.isArray(task)) return [];
    const status = (task as Record<string, unknown>).status;
    return typeof status === 'string' ? [status.toLowerCase()] : [];
  });
  const direct = readString(output, ['status'])?.toLowerCase();
  if (direct) statuses.unshift(direct);
  if (
    statuses.some(
      (status) =>
        status === 'running' ||
        status === 'inprogress' ||
        status === 'in_progress'
    )
  ) {
    return 'running';
  }
  if (statuses.some((status) => status === 'failed' || status === 'error')) {
    return 'failed';
  }
  if (
    statuses.some((status) => status === 'canceled' || status === 'cancelled')
  ) {
    return 'canceled';
  }
  if (result.is_error) return 'failed';
  if (
    statuses.some(
      (status) =>
        status === 'completed' || status === 'success' || status === 'ok'
    )
  ) {
    return 'completed';
  }
  return 'completed';
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
