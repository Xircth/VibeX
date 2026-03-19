import type { ReactNode } from 'react';
import {
  ActionType,
  ToolStatus,
  type NormalizedEntryType,
  type JsonValue,
} from 'shared/types.ts';
import {
  AlertCircle,
  Bot,
  Brain,
  CheckSquare,
  Edit,
  Eye,
  Globe,
  Hammer,
  Plus,
  Search,
  Settings,
  Terminal,
  TerminalSquare,
  User,
} from 'lucide-react';
import { createElement } from 'react';
import type { PatchTypeWithKey } from '@/hooks/useConversationHistory/types';
import type { ScriptType } from '@/components/dialogs/scripts/ScriptFixerDialog';

/***********************
 * Type definitions     *
 ***********************/

export type ExitStatusVisualisation = 'success' | 'error' | 'pending';

export type CardVariant = 'system' | 'error';

export type CollapsibleVariant = 'system' | 'error';

export type ToolStatusAppearance = 'default' | 'denied' | 'timed_out';

export type AggregationType =
  | 'file_read'
  | 'search'
  | 'web_fetch'
  | 'command_run';

export type FileEditAction = Extract<ActionType, { action: 'file_edit' }>;

/***********************
 * Constants            *
 ***********************/

export const SCRIPT_TOOL_NAMES = [
  'Setup Script',
  'Cleanup Script',
  'Archive Script',
  'Tool Install Script',
];

export const AGGREGATABLE_ACTIONS = new Set([
  'file_read',
  'search',
  'web_fetch',
  'command_run',
]);

export const AGGREGATION_LABELS: Record<
  AggregationType,
  { icon: ReactNode; label: string }
> = {
  file_read: {
    icon: createElement(Eye, { className: 'h-3 w-3' }),
    label: '查看文件',
  },
  search: {
    icon: createElement(Search, { className: 'h-3 w-3' }),
    label: '搜索',
  },
  web_fetch: {
    icon: createElement(Globe, { className: 'h-3 w-3' }),
    label: '网页抓取',
  },
  command_run: {
    icon: createElement(TerminalSquare, { className: 'h-3 w-3' }),
    label: '终端',
  },
};

export const PLAN_APPEARANCE: Record<
  ToolStatusAppearance,
  {
    border: string;
    headerBg: string;
    headerText: string;
    contentBg: string;
    contentText: string;
  }
> = {
  default: {
    border: 'border-blue-400/40',
    headerBg: 'bg-blue-50 dark:bg-blue-950/20',
    headerText: 'text-blue-700 dark:text-blue-300',
    contentBg: 'bg-blue-50 dark:bg-blue-950/20',
    contentText: 'text-blue-700 dark:text-blue-300',
  },
  denied: {
    border: 'border-red-400/40',
    headerBg: 'bg-red-50 dark:bg-red-950/20',
    headerText: 'text-red-700 dark:text-red-300',
    contentBg: 'bg-red-50 dark:bg-red-950/10',
    contentText: 'text-red-700 dark:text-red-300',
  },
  timed_out: {
    border: 'border-amber-400/40',
    headerBg: 'bg-amber-50 dark:bg-amber-950/20',
    headerText: 'text-amber-700 dark:text-amber-200',
    contentBg: 'bg-amber-50 dark:bg-amber-950/10',
    contentText: 'text-amber-700 dark:text-amber-200',
  },
};

/***********************
 * Helper functions     *
 ***********************/

export const renderJson = (v: JsonValue) =>
  createElement(
    'pre',
    { className: 'whitespace-pre-wrap' },
    JSON.stringify(v, null, 2)
  );

export const getEntryIcon = (entryType: NormalizedEntryType) => {
  const iconSize = 'h-3 w-3';
  if (entryType.type === 'user_message' || entryType.type === 'user_feedback') {
    return createElement(User, { className: iconSize });
  }
  if (entryType.type === 'assistant_message') {
    return createElement(Bot, { className: iconSize });
  }
  if (entryType.type === 'system_message') {
    return createElement(Settings, { className: iconSize });
  }
  if (entryType.type === 'thinking') {
    return createElement(Brain, { className: iconSize });
  }
  if (entryType.type === 'error_message') {
    return createElement(AlertCircle, { className: iconSize });
  }
  if (entryType.type === 'tool_use') {
    const { action_type, tool_name } = entryType;

    if (
      action_type.action === 'todo_management' ||
      (tool_name &&
        (tool_name.toLowerCase() === 'todowrite' ||
          tool_name.toLowerCase() === 'todoread' ||
          tool_name.toLowerCase() === 'todo_write' ||
          tool_name.toLowerCase() === 'todo_read' ||
          tool_name.toLowerCase() === 'todo'))
    ) {
      return createElement(CheckSquare, { className: iconSize });
    }

    if (action_type.action === 'file_read') {
      return createElement(Eye, { className: iconSize });
    } else if (action_type.action === 'file_edit') {
      return createElement(Edit, { className: iconSize });
    } else if (action_type.action === 'command_run') {
      return createElement(Terminal, { className: iconSize });
    } else if (action_type.action === 'search') {
      return createElement(Search, { className: iconSize });
    } else if (action_type.action === 'web_fetch') {
      return createElement(Globe, { className: iconSize });
    } else if (action_type.action === 'task_create') {
      return createElement(Plus, { className: iconSize });
    } else if (action_type.action === 'plan_presentation') {
      return createElement(CheckSquare, { className: iconSize });
    } else if (action_type.action === 'tool') {
      return createElement(Hammer, { className: iconSize });
    }
    return createElement(Settings, { className: iconSize });
  }
  return createElement(Settings, { className: iconSize });
};

export const getToolExitStatus = (
  entryType: NormalizedEntryType
): ExitStatusVisualisation | null => {
  if (
    entryType.type === 'tool_use' &&
    entryType.action_type.action === 'command_run'
  ) {
    let status: ExitStatusVisualisation = 'pending';
    if (entryType.action_type.result?.exit_status?.type === 'success') {
      status = entryType.action_type.result.exit_status.success
        ? 'success'
        : 'error';
    } else if (
      entryType.action_type.result?.exit_status?.type === 'exit_code'
    ) {
      status =
        entryType.action_type.result.exit_status.code === 0
          ? 'success'
          : 'error';
    }
    return status;
  }
  return null;
};

export const shouldRenderMarkdown = (entryType: NormalizedEntryType) =>
  entryType.type === 'assistant_message' ||
  entryType.type === 'system_message' ||
  entryType.type === 'thinking' ||
  entryType.type === 'tool_use';

export const getContentClassName = (entryType: NormalizedEntryType) => {
  const base = ' whitespace-pre-wrap break-words';
  if (
    entryType.type === 'tool_use' &&
    entryType.action_type.action === 'command_run'
  )
    return `${base} font-mono`;

  if (entryType.type === 'error_message')
    return `${base} font-mono text-destructive`;

  if (entryType.type === 'thinking') return `${base} opacity-60`;

  if (
    entryType.type === 'tool_use' &&
    (entryType.action_type.action === 'todo_management' ||
      (entryType.tool_name &&
        ['todowrite', 'todoread', 'todo_write', 'todo_read', 'todo'].includes(
          entryType.tool_name.toLowerCase()
        )))
  )
    return `${base} font-mono text-zinc-800 dark:text-zinc-200`;

  if (
    entryType.type === 'tool_use' &&
    entryType.action_type.action === 'plan_presentation'
  )
    return `${base} text-blue-700 dark:text-blue-300 bg-blue-50 dark:bg-blue-950/20 px-3 py-2 border-l-4 border-blue-400`;

  return base;
};

export function extractThinkingTitle(content: string): string | null {
  const firstNonEmptyLine = content
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (!firstNonEmptyLine) return null;

  let title = firstNonEmptyLine
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .trim();

  const boldMatch = title.match(/^\*\*(.+?)\*\*$/);
  if (boldMatch?.[1]) {
    title = boldMatch[1].trim();
  }

  return title || null;
}

/** Produce a human-readable one-line summary for a tool call */
export const getToolSummary = (
  entryType: Extract<NormalizedEntryType, { type: 'tool_use' }> | undefined,
  content: string
): { label: string; detail: string } => {
  if (!entryType) return { label: 'Tool', detail: content.trim() };
  const at = entryType.action_type;
  switch (at.action) {
    case 'command_run': {
      const cmd =
        typeof at.command === 'string' ? at.command.trim() : content.trim();
      const firstLine = cmd.split(/\r?\n/)[0];
      return {
        label: '终端',
        detail:
          firstLine.length > 80 ? firstLine.slice(0, 77) + '\u2026' : firstLine,
      };
    }
    case 'file_read':
      return { label: '查看文件', detail: at.path };
    case 'search':
      return { label: '搜索', detail: at.query };
    case 'web_fetch':
      return { label: '网页抓取', detail: at.url };
    case 'task_create':
      return {
        label: '创建子任务',
        detail:
          at.description.length > 60
            ? at.description.slice(0, 57) + '\u2026'
            : at.description,
      };
    case 'tool':
      return {
        label: at.tool_name || entryType.tool_name || 'Tool',
        detail: '',
      };
    case 'todo_management':
      return {
        label: 'Todo',
        detail: `${at.operation}${at.todos.length > 0 ? ` (${at.todos.length})` : ''}`,
      };
    case 'plan_presentation':
      return { label: '计划', detail: '' };
    default:
      return { label: entryType.tool_name || 'Tool', detail: content.trim() };
  }
};
export const isPendingApprovalStatus = (
  status: ToolStatus
): status is Extract<ToolStatus, { status: 'pending_approval' }> =>
  status.status === 'pending_approval';

export const getToolStatusAppearance = (
  status: ToolStatus
): ToolStatusAppearance => {
  if (status.status === 'denied') return 'denied';
  if (status.status === 'timed_out') return 'timed_out';
  return 'default';
};

export const getScriptType = (toolName: string): ScriptType => {
  if (toolName === 'Setup Script') return 'setup';
  if (toolName === 'Cleanup Script') return 'cleanup';
  if (toolName === 'Archive Script') return 'archive';
  return 'dev_server';
};

/***************************
 * Aggregation helpers     *
 ***************************/

export function getAggregatableAction(
  data: PatchTypeWithKey
): AggregationType | null {
  if (data.type !== 'NORMALIZED_ENTRY') return null;
  const entry = data.content;
  if (entry.entry_type.type !== 'tool_use') return null;
  const action = entry.entry_type.action_type.action;
  if (AGGREGATABLE_ACTIONS.has(action)) return action as AggregationType;
  return null;
}

export function getAggregatedEntryDetail(data: PatchTypeWithKey): string {
  if (data.type !== 'NORMALIZED_ENTRY') return '';
  const entry = data.content;
  if (entry.entry_type.type !== 'tool_use') return '';
  const at = entry.entry_type.action_type;
  if (at.action === 'file_read') return at.path;
  if (at.action === 'search') return at.query;
  if (at.action === 'web_fetch') return at.url;
  return '';
}
