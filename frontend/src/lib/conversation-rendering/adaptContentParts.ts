import type {
  ActionType,
  JsonValue,
  NormalizedEntry,
  ToolResult,
  ToolStatus,
} from 'shared/types';
import type {
  AgentEventEnvelope,
  AgentPermissionOption,
  ImportedAgentMessage,
  ImportedAgentMessageRole,
} from '@/features/agents/types';

export type AdaptedContentSource =
  | 'normalized-entry'
  | 'imported-message'
  | 'agent-event';

export type AdaptedToolState =
  | 'created'
  | 'running'
  | 'success'
  | 'failed'
  | 'denied'
  | 'pending_approval'
  | 'timed_out';

type AdaptedContentPartBase = {
  key: string;
  source: AdaptedContentSource;
  timestamp: string | null;
};

export type AdaptedTextPart = AdaptedContentPartBase & {
  type: 'text';
  role: ImportedAgentMessageRole;
  text: string;
  softBreaks?: boolean;
  normalizedEntry?: NormalizedEntry;
};

export type AdaptedReasoningPart = AdaptedContentPartBase & {
  type: 'reasoning';
  content: string;
  isStreaming: boolean;
  elapsedMs?: number;
  normalizedEntry?: NormalizedEntry;
};

export type AdaptedToolCallPart = AdaptedContentPartBase & {
  type: 'tool-call';
  toolCallId?: string;
  toolName: string;
  input?: string;
  output?: string;
  errorText?: string;
  state: AdaptedToolState;
  meta?: unknown;
  normalizedEntry?: NormalizedEntry;
};

export type AdaptedPlanPart = AdaptedContentPartBase & {
  type: 'plan';
  entries: string[];
  isStreaming: boolean;
  normalizedEntry?: NormalizedEntry;
};

export type AdaptedTerminalPart = AdaptedContentPartBase & {
  type: 'terminal';
  terminalId: string;
  command?: string;
  output?: string;
  truncated?: boolean;
  exitStatus?: number | null;
  state: AdaptedToolState;
};

export type AdaptedPermissionPart = AdaptedContentPartBase & {
  type: 'permission';
  permissionId: string;
  title: string;
  options: AgentPermissionOption[];
  state: 'requested' | 'responded';
  details?: unknown;
};

export type AdaptedUsagePart = AdaptedContentPartBase & {
  type: 'usage';
  used: number;
  limit?: number | null;
};

export type AdaptedStatusPart = AdaptedContentPartBase & {
  type: 'status';
  label: string;
  state: string;
  message?: string;
};

export type AdaptedErrorPart = AdaptedContentPartBase & {
  type: 'error';
  message: string;
  raw?: unknown;
};

export type AdaptedContentPart =
  | AdaptedTextPart
  | AdaptedReasoningPart
  | AdaptedToolCallPart
  | AdaptedPlanPart
  | AdaptedTerminalPart
  | AdaptedPermissionPart
  | AdaptedUsagePart
  | AdaptedStatusPart
  | AdaptedErrorPart;

export type ContentPartInput =
  | NormalizedEntry
  | ImportedAgentMessage
  | AgentEventEnvelope;

function basePart(
  source: AdaptedContentSource,
  key: string,
  timestamp: string | null
): AdaptedContentPartBase {
  return { key, source, timestamp };
}

function stringifyJson(value: JsonValue | unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function toolResultToText(
  result: ToolResult | null | undefined
): string | undefined {
  if (!result) return undefined;
  return stringifyJson(result.value);
}

function commandStateFromResult(
  actionType: Extract<ActionType, { action: 'command_run' }>,
  fallback: AdaptedToolState
): AdaptedToolState {
  const exitStatus = actionType.result?.exit_status;
  if (!exitStatus) return fallback;
  if (exitStatus.type === 'exit_code') {
    return exitStatus.code === 0 ? 'success' : 'failed';
  }
  return exitStatus.success ? 'success' : 'failed';
}

export function toolStateFromStatus(status: ToolStatus): AdaptedToolState {
  switch (status.status) {
    case 'created':
      return 'created';
    case 'success':
      return 'success';
    case 'failed':
      return 'failed';
    case 'denied':
      return 'denied';
    case 'pending_approval':
      return 'pending_approval';
    case 'timed_out':
      return 'timed_out';
  }
}

function planEntriesFromText(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function adaptToolAction(
  entry: NormalizedEntry,
  key: string,
  state: AdaptedToolState
): AdaptedContentPart {
  const entryType = entry.entry_type;
  if (entryType.type !== 'tool_use') {
    throw new Error('Expected a tool_use entry');
  }

  const actionType = entryType.action_type;
  const base = basePart('normalized-entry', key, entry.timestamp);

  switch (actionType.action) {
    case 'plan_presentation':
      return {
        ...base,
        type: 'plan',
        entries: planEntriesFromText(actionType.plan),
        isStreaming: state === 'created' || state === 'pending_approval',
        normalizedEntry: entry,
      };
    case 'todo_management':
      return {
        ...base,
        type: 'plan',
        entries: actionType.todos.map((todo) =>
          [todo.status, todo.content].filter(Boolean).join(': ')
        ),
        isStreaming: state === 'created' || state === 'pending_approval',
        normalizedEntry: entry,
      };
    case 'command_run':
      return {
        ...base,
        type: 'tool-call',
        toolName: entryType.tool_name,
        input: actionType.command,
        output: actionType.result?.output ?? undefined,
        state: commandStateFromResult(actionType, state),
        meta: actionType.result,
        normalizedEntry: entry,
      };
    case 'file_read':
      return {
        ...base,
        type: 'tool-call',
        toolName: entryType.tool_name,
        input: actionType.path,
        state,
        normalizedEntry: entry,
      };
    case 'file_edit':
      return {
        ...base,
        type: 'tool-call',
        toolName: entryType.tool_name,
        input: actionType.path,
        state,
        meta: actionType.changes,
        normalizedEntry: entry,
      };
    case 'search':
      return {
        ...base,
        type: 'tool-call',
        toolName: entryType.tool_name,
        input: actionType.query,
        state,
        normalizedEntry: entry,
      };
    case 'web_fetch':
      return {
        ...base,
        type: 'tool-call',
        toolName: entryType.tool_name,
        input: actionType.url,
        state,
        normalizedEntry: entry,
      };
    case 'tool':
      return {
        ...base,
        type: 'tool-call',
        toolName: actionType.tool_name || entryType.tool_name,
        input:
          actionType.arguments === null
            ? undefined
            : stringifyJson(actionType.arguments),
        output: toolResultToText(actionType.result),
        state,
        normalizedEntry: entry,
      };
    case 'task_create':
      return {
        ...base,
        type: 'tool-call',
        toolName: entryType.tool_name,
        input: actionType.description,
        output: toolResultToText(actionType.result),
        state,
        meta: { subagentType: actionType.subagent_type },
        normalizedEntry: entry,
      };
    case 'other':
      return {
        ...base,
        type: 'tool-call',
        toolName: entryType.tool_name,
        input: actionType.description,
        state,
        normalizedEntry: entry,
      };
  }
}

export function adaptNormalizedEntry(
  entry: NormalizedEntry,
  key = `normalized:${entry.timestamp ?? 'unknown'}`
): AdaptedContentPart | null {
  const base = basePart('normalized-entry', key, entry.timestamp);
  const entryType = entry.entry_type;

  switch (entryType.type) {
    case 'user_message':
      return {
        ...base,
        type: 'text',
        role: 'user',
        text: entry.content,
        softBreaks: true,
        normalizedEntry: entry,
      };
    case 'user_feedback':
      return {
        ...base,
        type: 'text',
        role: 'user',
        text: entry.content,
        normalizedEntry: entry,
      };
    case 'assistant_message':
      return {
        ...base,
        type: 'text',
        role: 'assistant',
        text: entry.content,
        normalizedEntry: entry,
      };
    case 'system_message':
      return {
        ...base,
        type: 'text',
        role: 'system',
        text: entry.content,
        normalizedEntry: entry,
      };
    case 'error_message':
      return {
        ...base,
        type: 'error',
        message: entry.content,
        raw: entryType.error_type,
      };
    case 'thinking':
      return {
        ...base,
        type: 'reasoning',
        content: entry.content,
        isStreaming: false,
        normalizedEntry: entry,
      };
    case 'tool_use':
      return adaptToolAction(entry, key, toolStateFromStatus(entryType.status));
    case 'loading':
      return {
        ...base,
        type: 'status',
        label: 'loading',
        state: 'running',
      };
    case 'next_action':
      return {
        ...base,
        type: 'status',
        label: 'next_action',
        state: entryType.failed ? 'failed' : 'ready',
        message: entry.content,
      };
    case 'token_usage_info':
      return {
        ...base,
        type: 'usage',
        used: entryType.total_tokens,
        limit: entryType.model_context_window,
      };
  }
}

export function adaptImportedAgentMessage(
  message: ImportedAgentMessage,
  key = `imported:${message.created_at ?? 'unknown'}`
): AdaptedContentPart {
  return {
    ...basePart('imported-message', key, message.created_at ?? null),
    type: 'text',
    role: message.role,
    text: message.content,
    softBreaks: message.role === 'user',
  };
}

function textFromAgentContentBlock(
  content: Extract<
    AgentEventEnvelope['event'],
    { kind: 'message_chunk' } | { kind: 'thought_chunk' }
  >['content']
): string {
  switch (content.kind) {
    case 'text':
      return content.text;
    case 'image':
      return content.uri ? `[image] ${content.uri}` : '[image]';
    case 'resource':
      return content.title
        ? `[resource] ${content.title}: ${content.uri}`
        : `[resource] ${content.uri}`;
  }
}

export function adaptAgentEventEnvelope(
  envelope: AgentEventEnvelope,
  key = `agent:${envelope.sequence}`
): AdaptedContentPart | null {
  const base = basePart('agent-event', key, envelope.created_at);

  switch (envelope.event.kind) {
    case 'connection_status_changed':
      return {
        ...base,
        type: 'status',
        label: 'connection',
        state: envelope.event.snapshot.status,
        message: envelope.event.snapshot.status_message ?? undefined,
      };
    case 'session_created':
      return {
        ...base,
        type: 'status',
        label: 'session',
        state: envelope.event.snapshot.status,
      };
    case 'prompt_started':
      return {
        ...base,
        type: 'text',
        role: 'user',
        text: envelope.event.snapshot.text_preview,
        softBreaks: true,
      };
    case 'message_chunk':
      return {
        ...base,
        type: 'text',
        role: 'assistant',
        text: textFromAgentContentBlock(envelope.event.content),
      };
    case 'thought_chunk':
      return {
        ...base,
        type: 'reasoning',
        content: textFromAgentContentBlock(envelope.event.content),
        isStreaming: true,
      };
    case 'tool_call':
      return {
        ...base,
        type: 'tool-call',
        toolCallId: envelope.event.tool_call.id,
        toolName: envelope.event.tool_call.title,
        input: envelope.event.tool_call.kind ?? undefined,
        state: 'created',
      };
    case 'tool_call_update':
      return {
        ...base,
        type: 'tool-call',
        toolCallId: envelope.event.update.id,
        toolName: envelope.event.update.id,
        output: envelope.event.update.content ?? undefined,
        state: envelope.event.update.status === 'failed' ? 'failed' : 'success',
      };
    case 'plan':
      return {
        ...base,
        type: 'plan',
        entries: envelope.event.plan.entries,
        isStreaming: false,
      };
    case 'usage':
      return {
        ...base,
        type: 'usage',
        used: envelope.event.usage.used,
        limit: envelope.event.usage.limit,
      };
    case 'permission_requested':
      return {
        ...base,
        type: 'permission',
        permissionId: envelope.event.request.id,
        title: envelope.event.request.title,
        options: envelope.event.request.options,
        details: envelope.event.request.details,
        state: 'requested',
      };
    case 'permission_responded':
      return {
        ...base,
        type: 'permission',
        permissionId: envelope.event.permission_id,
        title: envelope.event.permission_id,
        options: [],
        state: 'responded',
        details: envelope.event.response,
      };
    case 'terminal_created':
      return {
        ...base,
        type: 'terminal',
        terminalId: envelope.event.terminal.id,
        command: [
          envelope.event.terminal.command,
          ...envelope.event.terminal.args,
        ].join(' '),
        state: 'created',
      };
    case 'terminal_output':
      return {
        ...base,
        type: 'terminal',
        terminalId: envelope.event.output.terminal_id,
        output: envelope.event.output.output,
        truncated: envelope.event.output.truncated,
        exitStatus: envelope.event.output.exit_status,
        state:
          envelope.event.output.exit_status == null ||
          envelope.event.output.exit_status === 0
            ? 'success'
            : 'failed',
      };
    case 'prompt_finished':
      return {
        ...base,
        type: 'status',
        label: 'prompt',
        state: envelope.event.finished.stop_reason ?? 'finished',
        message: envelope.event.finished.prompt_id,
      };
    case 'error':
      return {
        ...base,
        type: 'error',
        message: envelope.event.error.message,
        raw: envelope.event.error.raw,
      };
    case 'raw_acp_diagnostic':
      return {
        ...base,
        type: 'text',
        role: 'system',
        text: stringifyJson(envelope.event.raw),
      };
  }
}

function isNormalizedEntry(input: ContentPartInput): input is NormalizedEntry {
  return 'entry_type' in input;
}

function isImportedAgentMessage(
  input: ContentPartInput
): input is ImportedAgentMessage {
  return 'role' in input && 'content' in input;
}

export function adaptContentParts(
  inputs: readonly ContentPartInput[]
): AdaptedContentPart[] {
  return inputs.flatMap((input, index) => {
    const key = `part:${index}`;
    if (isNormalizedEntry(input)) {
      const part = adaptNormalizedEntry(input, key);
      return part ? [part] : [];
    }
    if (isImportedAgentMessage(input)) {
      return [adaptImportedAgentMessage(input, key)];
    }
    const part = adaptAgentEventEnvelope(input, key);
    return part ? [part] : [];
  });
}
