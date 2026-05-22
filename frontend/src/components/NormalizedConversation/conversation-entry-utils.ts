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
import type {
  BaseDisplayEntry,
  DisplayEntry,
  PatchTypeWithKey,
} from '@/hooks/useConversationHistory/types';
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
  | 'command_run'
  | 'task_create';

export type FileEditAction = Extract<ActionType, { action: 'file_edit' }>;
export type BuildDisplayEntriesOptions = {
  aggregateThinking?: boolean;
  completedExecutionProcessIds?: ReadonlySet<string>;
  collapseAiMessagesByDefault?: boolean;
};

type AgentLaunch = {
  name: string | null;
  description: string;
};

type AssistantAgentLaunchExtraction = {
  launches: AgentLaunch[];
  remainingContent: string;
};

const SUBAGENT_STATUS_TOOL_NAMES = new Set([
  'wait',
  'waitagent',
  'sendinput',
  'resumeagent',
  'closeagent',
]);

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
  'task_create',
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
  task_create: {
    icon: createElement(Bot, { className: 'h-3 w-3' }),
    label: '正在生成智能体',
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

const ANSI_SEQUENCE_PATTERN = new RegExp(
  `${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]|\\[(?:[0-9]{1,2};?)*m`,
  'g'
);
const INTERNAL_TRACING_LOG_PATTERN =
  /^(?:\d{4}-\d{2}-\d{2}T[0-9:.]+Z\s+)?(?:TRACE|DEBUG|INFO|WARN|ERROR)\s+[a-zA-Z0-9_]+(?:::[a-zA-Z0-9_]+)+(?:\s*:|:|\s)/;
const TRANSPORT_FALLBACK_NOTICE_PREFIX_PATTERN =
  /^\s*(Falling back from WebSockets to HTTPS transport\.\s*timeout waiting for child process to exit\.?)([\s\S]*)$/i;
const IMPECCABLE_PREFLIGHT_NOTICE_PATTERN =
  /^\s*(IMPECCABLE_PREFLIGHT:[^\r\n]*)(?:\r?\n([\s\S]*))?$/i;
const CODEX_UNSTABLE_FEATURE_NOTICE_PATTERN =
  /^\s*(Under-development features enabled:[\s\S]*?\bsuppress_unstable_features_warning\b\s*=\s*true`?\s+in\s+[\s\S]*?config\.toml\.?)([\s\S]*)$/i;
const VERBOSE_ERROR_PATTERNS = [
  /\bWall time:\s*.+?\bOutput:/i,
  /\bCategoryInfo\s*:/i,
  /\bFullyQualifiedErrorId\s*:/i,
  /\bCommandNotFoundException\b/i,
  /\bSet-PSReadLineOption\b/i,
  /\bERR_PNPM_/i,
  /\bELIFECYCLE\b/i,
  /\bCannot find module\b/i,
  /\bfailed to load config\b/i,
];
const COMMAND_OUTPUT_MARKER_PATTERN = /\bCommand output\s*[:：]\s*/i;
const SHELL_OUTPUT_ENVELOPE_PATTERN =
  /^\s*(?:(?:Exit code|Wall time):[\s\S]*?)?\bOutput:\s*/i;
const AGENT_LAUNCH_SENTENCE_PATTERN =
  /(?:^|\n)\s*(?:[一二三四五六七八九十两\d]+\s*个)?(?:子代理|智能体|agent|Agent)\s*(?:已启动|启动|已创建|创建完成|created|started)\s*[：:]\s*([^\n。.!！？]+)[。.!！？]?/i;
const AGENT_LAUNCH_SPLIT_PATTERN = /[，,；;、]+/;
const AGENT_LAUNCH_NAME_PATTERN =
  /^\s*([A-Za-z][A-Za-z0-9_-]{1,40}|agent-[0-9a-f-]{6,})\s*(.*)$/i;

export function sanitizeConversationContent(content: string): string {
  return content.replace(ANSI_SEQUENCE_PATTERN, '').trim();
}

export function repairTokenizedStreamContent(content: string): string {
  const sanitized = sanitizeConversationContent(content);
  const lines = sanitized
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

  if (lines.length < 4) {
    return sanitized;
  }

  const shortLineCount = lines.filter(
    (line) => line.trim().length <= 12
  ).length;
  const averageLineLength =
    lines.reduce((total, line) => total + line.trim().length, 0) / lines.length;
  const looksTokenized =
    shortLineCount / lines.length >= 0.55 || averageLineLength <= 14;

  if (!looksTokenized) {
    return sanitized;
  }

  return lines.join('');
}

export function isInternalTracingLogContent(content: string): boolean {
  const normalized = sanitizeConversationContent(content);
  if (!normalized) {
    return false;
  }

  return (
    INTERNAL_TRACING_LOG_PATTERN.test(normalized) ||
    normalized.includes(' codex_acp::') ||
    normalized.includes(' codex_core::')
  );
}

function compactWhitespace(content: string): string {
  return content.replace(/\s+/g, ' ').trim();
}

function ellipsize(content: string, maxLength: number): string {
  if (content.length <= maxLength) {
    return content;
  }

  return `${content.slice(0, maxLength - 1).trimEnd()}\u2026`;
}

export function isNeutralTransportNotice(content: string): boolean {
  const match = sanitizeConversationContent(content).match(
    TRANSPORT_FALLBACK_NOTICE_PREFIX_PATTERN
  );

  return Boolean(match && !match[2]?.trim());
}

export function splitLeadingTransportNotice(
  content: string
): { notice: string; remainder: string } | null {
  const match = sanitizeConversationContent(content).match(
    TRANSPORT_FALLBACK_NOTICE_PREFIX_PATTERN
  );
  if (!match) {
    return null;
  }

  const notice = normalizeMetaNoticeText(match[1]?.trim() ?? '');
  const remainder = match[2]?.trimStart();
  if (!notice || !remainder) {
    return null;
  }

  return { notice, remainder };
}

export function splitLeadingImpeccablePreflightNotice(
  content: string
): { notice: string; remainder: string } | null {
  const match = sanitizeConversationContent(content).match(
    IMPECCABLE_PREFLIGHT_NOTICE_PATTERN
  );
  if (!match) {
    return null;
  }

  const notice = normalizeMetaNoticeText(match[1]?.trim() ?? '');
  const remainder = match[2]?.trimStart() ?? '';
  if (!notice) {
    return null;
  }

  return { notice, remainder };
}

export function splitLeadingCodexUnstableFeatureNotice(
  content: string
): { notice: string; remainder: string } | null {
  const match = sanitizeConversationContent(content).match(
    CODEX_UNSTABLE_FEATURE_NOTICE_PATTERN
  );
  if (!match) {
    return null;
  }

  const notice = normalizeMetaNoticeText(match[1]?.trim() ?? '');
  const remainder = match[2]?.trimStart() ?? '';
  if (!notice) {
    return null;
  }

  return { notice, remainder };
}

function stripPowerShellProfileNoise(content: string): string {
  if (!/Set-PSReadLineOption/i.test(content)) {
    return content;
  }

  return content
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      return (
        trimmed &&
        !/^Set-PSReadLineOption\b/i.test(trimmed) &&
        !/Microsoft\.PowerShell_profile\.ps1/i.test(trimmed) &&
        !/^\+ Set-PSReadLineOption\b/i.test(trimmed) &&
        !/^~{3,}/.test(trimmed) &&
        !/\[Set-PSReadLineOption\]/i.test(trimmed) &&
        !/Microsoft\.PowerShell\.SetPSReadLineOption/i.test(trimmed)
      );
    })
    .join('\n');
}

export function getCompactVerboseErrorText(content: string): string | null {
  const cleaned = sanitizeConversationContent(content);
  const normalized = compactWhitespace(cleaned);
  if (!normalized) {
    return null;
  }

  const lineCount = cleaned
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean).length;
  const isVerbose =
    lineCount >= 3 ||
    normalized.length > 360 ||
    VERBOSE_ERROR_PATTERNS.some((pattern) => pattern.test(normalized));

  if (!isVerbose) {
    return null;
  }

  const summarySource = stripPowerShellProfileNoise(cleaned);
  const summaryNormalized = compactWhitespace(summarySource);
  const normalizedForSummary = summaryNormalized || normalized;

  if (
    /\brg\b/i.test(normalizedForSummary) &&
    (/CommandNotFoundException/i.test(normalizedForSummary) ||
      /not recognized/i.test(normalizedForSummary) ||
      /无法将/i.test(normalized))
  ) {
    return 'Command failed: rg is not recognized';
  }

  if (!summaryNormalized && /Set-PSReadLineOption/i.test(normalized)) {
    return 'PowerShell profile warning: Set-PSReadLineOption failed';
  }

  const withoutShellEnvelope = normalizedForSummary.replace(
    /^(?:Exit code:\s*[^.]+\.?\s*)?(?:Wall time:\s*.+?\s*)?Output:\s*/i,
    ''
  );
  const firstMeaningfulLine =
    withoutShellEnvelope
      .split(
        /\s+(?=(?:[A-Za-z]:\\|[A-Za-z][\w.-]*\s*:|Error:|Cannot|failed|ERR_))/
      )
      .map((line) => line.trim())
      .find(
        (line) =>
          line &&
          !/^Set-PSReadLineOption\b/i.test(line) &&
          !/^CategoryInfo\b/i.test(line) &&
          !/^FullyQualifiedErrorId\b/i.test(line)
      ) ?? withoutShellEnvelope;

  return ellipsize(`Command output: ${firstMeaningfulLine}`, 180);
}

export interface AssistantCommandOutputSplit {
  prefix: string;
  output: string;
}

export interface AssistantCollapsedMessageSplit {
  prefix: string;
  output: string;
}

function stripCommandOutputPrefixNoise(content: string): string {
  const withoutProfileNoise = stripPowerShellProfileNoise(content);
  return (withoutProfileNoise.trim() || content.trim()).trim();
}

export function splitAssistantCommandOutput(
  content: string
): AssistantCommandOutputSplit | null {
  const cleaned = sanitizeConversationContent(content);
  if (!cleaned) {
    return null;
  }

  const markerMatch = cleaned.match(COMMAND_OUTPUT_MARKER_PATTERN);
  if (markerMatch?.index != null) {
    const markerEnd = markerMatch.index + markerMatch[0].length;
    const output = stripCommandOutputPrefixNoise(cleaned.slice(markerEnd));
    if (!output) {
      return null;
    }

    return {
      prefix: cleaned.slice(0, markerMatch.index).trim(),
      output,
    };
  }

  const shellEnvelopeMatch = cleaned.match(SHELL_OUTPUT_ENVELOPE_PATTERN);
  if (!shellEnvelopeMatch) {
    return null;
  }

  const output = stripCommandOutputPrefixNoise(
    cleaned.slice(shellEnvelopeMatch[0].length)
  );
  if (!output) {
    return null;
  }

  return {
    prefix: shellEnvelopeMatch[0].trim(),
    output,
  };
}

function splitContentBlocks(content: string): string[] {
  return content
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
}

export function splitAssistantFinalMessage(
  content: string
): AssistantCollapsedMessageSplit | null {
  const cleaned = sanitizeConversationContent(content);
  if (!cleaned) {
    return null;
  }

  const commandOutputSplit = splitAssistantCommandOutput(cleaned);
  if (commandOutputSplit) {
    return commandOutputSplit;
  }

  const blocks = splitContentBlocks(cleaned);
  if (blocks.length < 2) {
    return null;
  }

  const output = blocks[blocks.length - 1] ?? '';
  const prefix = blocks.slice(0, -1).join('\n\n').trim();

  if (!prefix || !output) {
    return null;
  }

  if (prefix.length < 24 || output.length < 8) {
    return null;
  }

  return { prefix, output };
}

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

const HIDDEN_INIT_NOTICE_KEYS = new Set([
  'agent',
  'approval',
  'approval policy',
  'executor',
  'mode',
  'model',
  'permission mode',
  'permissions',
  'profile',
  'reasoning',
  'reasoning effort',
  'sandbox',
]);

const COMPACT_NOTICE_PATTERNS = [
  /\bthis session was recorded with\b/i,
  /\bis resuming with\b/i,
  /\bconsider switching back\b/i,
  /\bresume(?:d|ing)?\b/i,
  /\bcontinu(?:e|ing) with\b/i,
  /\bmodel mismatch\b/i,
  /\breasoning effort\b/i,
  /\bunder-development features enabled\b/i,
  /\bsuppress_unstable_features_warning\b/i,
];

function getColonSeparatedNoticeLines(content: string) {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^([a-z][a-z0-9 _/-]*):\s+(.+)$/i);
      if (!match) {
        return null;
      }

      return {
        key: match[1].trim().toLowerCase(),
        value: match[2].trim(),
      };
    });
}

export function normalizeMetaNoticeText(content: string) {
  return content
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function shouldHideInitializationNotice(
  entryType: NormalizedEntryType,
  content: string
) {
  if (
    entryType.type === 'user_message' ||
    entryType.type === 'user_feedback' ||
    entryType.type === 'tool_use' ||
    entryType.type === 'thinking' ||
    entryType.type === 'loading' ||
    entryType.type === 'token_usage_info' ||
    entryType.type === 'next_action'
  ) {
    return false;
  }

  const parsedLines = getColonSeparatedNoticeLines(content);
  if (parsedLines.length === 0 || parsedLines.some((line) => !line)) {
    return false;
  }

  const lines = parsedLines.filter(
    (line): line is NonNullable<(typeof parsedLines)[number]> => Boolean(line)
  );

  return (
    lines.length <= 4 &&
    lines.every((line) => HIDDEN_INIT_NOTICE_KEYS.has(line.key)) &&
    lines.some((line) => line.key === 'model')
  );
}

export function getCompactMetaNoticeText(
  entryType: NormalizedEntryType,
  content: string
) {
  const normalized = normalizeMetaNoticeText(content);
  if (!normalized) {
    return null;
  }

  const lineCount = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean).length;
  const hasStructuredFormatting =
    /```/.test(content) ||
    /^\s*[-*#]/m.test(content) ||
    /^\s*\d+[.)]\s/m.test(content);

  if (hasStructuredFormatting) {
    return null;
  }

  const impeccablePreflight = splitLeadingImpeccablePreflightNotice(content);
  if (impeccablePreflight && !impeccablePreflight.remainder) {
    return normalizeMetaNoticeText(impeccablePreflight.notice);
  }

  const unstableFeatureNotice = splitLeadingCodexUnstableFeatureNotice(content);
  if (unstableFeatureNotice) {
    if (!unstableFeatureNotice.remainder) {
      return normalizeMetaNoticeText(unstableFeatureNotice.notice);
    }
    return null;
  }

  if (isNeutralTransportNotice(content)) {
    return normalized;
  }

  if (
    (entryType.type === 'system_message' ||
      entryType.type === 'error_message' ||
      entryType.type === 'assistant_message') &&
    COMPACT_NOTICE_PATTERNS.some((pattern) => pattern.test(normalized)) &&
    normalized.length <= 360
  ) {
    return normalized;
  }

  if (
    (entryType.type === 'system_message' ||
      entryType.type === 'error_message') &&
    lineCount <= 2 &&
    normalized.length <= 240
  ) {
    return normalized;
  }

  if (
    entryType.type === 'assistant_message' &&
    lineCount <= 3 &&
    normalized.length <= 280 &&
    COMPACT_NOTICE_PATTERNS.some((pattern) => pattern.test(normalized))
  ) {
    return normalized;
  }

  return null;
}

export const getContentClassName = (entryType: NormalizedEntryType) => {
  const base = ' whitespace-pre-wrap break-words';
  if (
    entryType.type === 'tool_use' &&
    entryType.action_type.action === 'command_run'
  )
    return `${base} font-mono`;

  if (entryType.type === 'error_message')
    return `${base} font-mono text-muted-foreground`;

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
        label: 'Subagent',
        detail:
          at.description.length > 60
            ? at.description.slice(0, 57) + '\u2026'
            : at.description,
      };
    case 'tool':
      if (
        SUBAGENT_STATUS_TOOL_NAMES.has(
          (at.tool_name || entryType.tool_name || '')
            .replace(/[\s_-]/g, '')
            .toLowerCase()
        )
      ) {
        const firstLine = content.trim().split(/\r?\n/)[0] ?? '';
        return {
          label: 'Subagent status',
          detail:
            firstLine.length > 80
              ? firstLine.slice(0, 77) + '\u2026'
              : firstLine,
        };
      }
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
      return { label: 'Plan', detail: '' };
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
  if (SCRIPT_TOOL_NAMES.includes(entry.entry_type.tool_name)) return null;
  if (isPendingApprovalStatus(entry.entry_type.status)) return null;
  const action = entry.entry_type.action_type.action;
  if (AGGREGATABLE_ACTIONS.has(action)) return action as AggregationType;
  return null;
}

function getAggregationKey(data: PatchTypeWithKey): string | null {
  const aggregationType = getAggregatableAction(data);
  if (!aggregationType || data.type !== 'NORMALIZED_ENTRY') {
    return null;
  }

  const entry = data.content;
  if (entry.entry_type.type !== 'tool_use') {
    return null;
  }

  if (aggregationType === 'command_run') {
    return [data.executionProcessId, aggregationType].join(':');
  }

  if (aggregationType === 'task_create') {
    return [data.executionProcessId, aggregationType].join(':');
  }

  return [
    data.executionProcessId,
    aggregationType,
    entry.entry_type.tool_name.trim().toLowerCase(),
  ].join(':');
}

function shouldHideDisplayEntry(data: PatchTypeWithKey): boolean {
  if (data.type !== 'NORMALIZED_ENTRY') {
    return false;
  }

  const entryType = data.content.entry_type;
  if (
    entryType.type === 'tool_use' &&
    entryType.action_type.action === 'web_fetch'
  ) {
    return true;
  }

  return (
    (entryType.type === 'system_message' ||
      entryType.type === 'error_message' ||
      entryType.type === 'assistant_message') &&
    isInternalTracingLogContent(data.content.content)
  );
}

function isProcessChangeEntry(data: PatchTypeWithKey): boolean {
  if (data.type !== 'NORMALIZED_ENTRY') {
    return false;
  }

  const entryType = data.content.entry_type;
  return (
    entryType.type === 'tool_use' &&
    entryType.action_type.action === 'file_edit' &&
    !isPendingApprovalStatus(entryType.status)
  );
}

function isThinkingEntry(data: PatchTypeWithKey): boolean {
  return (
    data.type === 'NORMALIZED_ENTRY' &&
    data.content.entry_type.type === 'thinking'
  );
}

function parseAgentLaunchChunk(chunk: string): AgentLaunch | null {
  const trimmed = chunk.trim();
  if (!trimmed) {
    return null;
  }

  const match = trimmed.match(AGENT_LAUNCH_NAME_PATTERN);
  if (!match) {
    return {
      name: null,
      description: trimmed,
    };
  }

  const name = match[1] ?? null;
  const description = (match[2] ?? '').trim() || trimmed;
  return {
    name,
    description,
  };
}

function extractAssistantAgentLaunches(
  content: string
): AssistantAgentLaunchExtraction | null {
  const match = content.match(AGENT_LAUNCH_SENTENCE_PATTERN);
  if (!match || typeof match.index !== 'number') {
    return null;
  }

  const launchText = match[1] ?? '';
  const launches = launchText
    .split(AGENT_LAUNCH_SPLIT_PATTERN)
    .map(parseAgentLaunchChunk)
    .filter((launch): launch is AgentLaunch => Boolean(launch));

  if (launches.length === 0) {
    return null;
  }

  const before = content.slice(0, match.index).trimEnd();
  const after = content.slice(match.index + match[0].length).trimStart();
  const remainingContent = [before, after]
    .filter((part) => part.trim().length > 0)
    .join('\n\n');

  return {
    launches,
    remainingContent,
  };
}

function hasRealAgentCreateEntry(entries: PatchTypeWithKey[]): boolean {
  return entries.some(
    (entry) =>
      entry.type === 'NORMALIZED_ENTRY' &&
      entry.content.entry_type.type === 'tool_use' &&
      entry.content.entry_type.action_type.action === 'task_create'
  );
}

function expandAssistantAgentLaunchEntries(
  entries: PatchTypeWithKey[]
): PatchTypeWithKey[] {
  if (hasRealAgentCreateEntry(entries)) {
    return entries;
  }

  const expanded: PatchTypeWithKey[] = [];

  for (const entry of entries) {
    if (
      entry.type !== 'NORMALIZED_ENTRY' ||
      entry.content.entry_type.type !== 'assistant_message'
    ) {
      expanded.push(entry);
      continue;
    }

    const extraction = extractAssistantAgentLaunches(entry.content.content);
    if (!extraction) {
      expanded.push(entry);
      continue;
    }

    extraction.launches.forEach((launch, index) => {
      expanded.push({
        ...entry,
        patchKey: `${entry.patchKey}:agent-launch:${index}`,
        content: {
          ...entry.content,
          entry_type: {
            type: 'tool_use',
            tool_name: 'subagent_launch',
            action_type: {
              action: 'task_create',
              description: launch.description,
              subagent_type: launch.name,
              result: null,
            },
            status: { status: 'created' },
          },
          content: launch.description,
        },
      });
    });

    if (extraction.remainingContent.trim()) {
      expanded.push({
        ...entry,
        patchKey: `${entry.patchKey}:assistant-remaining`,
        content: {
          ...entry.content,
          content: extraction.remainingContent,
        },
      });
    }
  }

  return expanded;
}

function isAssistantMessageDisplayEntry(
  entry: BaseDisplayEntry
): entry is PatchTypeWithKey & { type: 'NORMALIZED_ENTRY' } {
  return (
    entry.type === 'NORMALIZED_ENTRY' &&
    entry.content.entry_type.type === 'assistant_message'
  );
}

function shouldCollapseAssistantPreludeEntry(entry: BaseDisplayEntry): boolean {
  if (entry.type !== 'NORMALIZED_ENTRY') {
    return true;
  }

  const entryType = entry.content.entry_type.type;
  return entryType !== 'user_message' && entryType !== 'user_feedback';
}

function collapseAssistantPreludeEntries(
  displayEntries: BaseDisplayEntry[]
): DisplayEntry[] {
  const lastAssistantIndexByProcess = new Map<string, number>();

  for (let index = 0; index < displayEntries.length; index += 1) {
    const entry = displayEntries[index]!;
    if (isAssistantMessageDisplayEntry(entry)) {
      lastAssistantIndexByProcess.set(entry.executionProcessId, index);
    }
  }

  const hiddenIndexes = new Set<number>();
  const collapsedGroupByAssistantIndex = new Map<
    number,
    Extract<DisplayEntry, { type: 'COLLAPSED_ASSISTANT_MESSAGES' }>
  >();

  for (const [
    executionProcessId,
    assistantIndex,
  ] of lastAssistantIndexByProcess) {
    const hiddenEntries: BaseDisplayEntry[] = [];

    for (let index = 0; index < assistantIndex; index += 1) {
      const entry = displayEntries[index]!;
      if (
        entry.executionProcessId === executionProcessId &&
        shouldCollapseAssistantPreludeEntry(entry)
      ) {
        hiddenEntries.push(entry);
        hiddenIndexes.add(index);
      }
    }

    if (hiddenEntries.length === 0) {
      continue;
    }

    const firstHiddenEntry = hiddenEntries[0]!;
    const lastHiddenEntry = hiddenEntries[hiddenEntries.length - 1]!;
    collapsedGroupByAssistantIndex.set(assistantIndex, {
      type: 'COLLAPSED_ASSISTANT_MESSAGES',
      entries: hiddenEntries,
      hiddenCount: hiddenEntries.length,
      patchKey: `collapsed-assistant:${executionProcessId}:${firstHiddenEntry.patchKey}:${lastHiddenEntry.patchKey}`,
      executionProcessId,
    });
  }

  const collapsedEntries: DisplayEntry[] = [];

  for (let index = 0; index < displayEntries.length; index += 1) {
    if (hiddenIndexes.has(index)) {
      continue;
    }

    const collapsedGroup = collapsedGroupByAssistantIndex.get(index);
    if (collapsedGroup) {
      collapsedEntries.push(collapsedGroup);
    }

    collapsedEntries.push(displayEntries[index]!);
  }

  return collapsedEntries;
}

export function buildDisplayEntries(
  entries: PatchTypeWithKey[],
  options: BuildDisplayEntriesOptions = {}
): DisplayEntry[] {
  if (entries.length === 0) {
    return [];
  }

  const { aggregateThinking = false, collapseAiMessagesByDefault = false } =
    options;
  const sourceEntries = expandAssistantAgentLaunchEntries(entries);
  const completedExecutionProcessIds = options.completedExecutionProcessIds;
  const displayEntries: BaseDisplayEntry[] = [];
  let currentGroup: PatchTypeWithKey[] = [];
  let currentAggregationType: AggregationType | null = null;
  let currentAggregationKey: string | null = null;
  let currentThinkingGroup: PatchTypeWithKey[] = [];
  let currentThinkingProcessId: string | null = null;
  let currentProcessId: string | null = null;
  const processFileEdits = new Map<string, PatchTypeWithKey[]>();
  const emittedFileEditGroups = new Set<string>();

  for (const entry of sourceEntries) {
    if (shouldHideDisplayEntry(entry)) {
      continue;
    }

    if (!isProcessChangeEntry(entry)) {
      continue;
    }

    const processId = entry.executionProcessId;
    const existing = processFileEdits.get(processId) ?? [];
    existing.push(entry);
    processFileEdits.set(processId, existing);
  }

  const flushCurrentGroup = () => {
    if (currentGroup.length === 0 || !currentAggregationType) {
      currentGroup = [];
      currentAggregationType = null;
      currentAggregationKey = null;
      return;
    }

    if (currentGroup.length === 1) {
      displayEntries.push(currentGroup[0]!);
    } else {
      const firstEntry = currentGroup[0]!;
      const lastEntry = currentGroup[currentGroup.length - 1]!;
      displayEntries.push({
        type: 'AGGREGATED_GROUP',
        aggregationType: currentAggregationType,
        entries: [...currentGroup],
        patchKey: `aggregated:${currentAggregationType}:${firstEntry.patchKey}:${lastEntry.patchKey}`,
        executionProcessId: firstEntry.executionProcessId,
      });
    }

    currentGroup = [];
    currentAggregationType = null;
    currentAggregationKey = null;
  };

  const flushCurrentThinkingGroup = () => {
    if (currentThinkingGroup.length === 0) {
      currentThinkingProcessId = null;
      return;
    }

    if (currentThinkingGroup.length === 1) {
      displayEntries.push(currentThinkingGroup[0]!);
    } else {
      const firstEntry = currentThinkingGroup[0]!;
      const lastEntry = currentThinkingGroup[currentThinkingGroup.length - 1]!;
      displayEntries.push({
        type: 'AGGREGATED_THINKING_GROUP',
        entries: [...currentThinkingGroup],
        patchKey: `aggregated-thinking:${firstEntry.executionProcessId}:${firstEntry.patchKey}:${lastEntry.patchKey}`,
        executionProcessId: firstEntry.executionProcessId,
      });
    }

    currentThinkingGroup = [];
    currentThinkingProcessId = null;
  };

  const flushProcessChangeSummary = (processId: string | null) => {
    if (!processId || !completedExecutionProcessIds?.has(processId)) {
      return;
    }

    const entriesForProcess = processFileEdits.get(processId);
    if (!entriesForProcess || entriesForProcess.length === 0) {
      return;
    }

    const firstEntry = entriesForProcess[0]!;
    const lastEntry = entriesForProcess[entriesForProcess.length - 1]!;
    displayEntries.push({
      type: 'PROCESS_CHANGE_SUMMARY',
      entries: [...entriesForProcess],
      patchKey: `process-change-summary:${processId}:${firstEntry.patchKey}:${lastEntry.patchKey}`,
      executionProcessId: processId,
    });
  };

  const flushProcessScopedGroups = () => {
    flushCurrentGroup();
    flushCurrentThinkingGroup();
  };

  for (const entry of sourceEntries) {
    if (shouldHideDisplayEntry(entry)) {
      continue;
    }

    if (isThinkingEntry(entry)) {
      continue;
    }

    if (currentProcessId && currentProcessId !== entry.executionProcessId) {
      flushProcessScopedGroups();
      flushProcessChangeSummary(currentProcessId);
    }
    currentProcessId = entry.executionProcessId;

    if (isProcessChangeEntry(entry)) {
      flushCurrentGroup();
      flushCurrentThinkingGroup();

      const entriesForProcess =
        processFileEdits.get(entry.executionProcessId) ?? [];
      if (entriesForProcess.length <= 1) {
        displayEntries.push(entry);
        continue;
      }

      if (!emittedFileEditGroups.has(entry.executionProcessId)) {
        const firstEntry = entriesForProcess[0]!;
        const lastEntry = entriesForProcess[entriesForProcess.length - 1]!;
        displayEntries.push({
          type: 'AGGREGATED_FILE_EDIT_GROUP',
          entries: [...entriesForProcess],
          patchKey: `aggregated-file-edit:${entry.executionProcessId}:${firstEntry.patchKey}:${lastEntry.patchKey}`,
          executionProcessId: entry.executionProcessId,
        });
        emittedFileEditGroups.add(entry.executionProcessId);
      }
      continue;
    }

    if (aggregateThinking && isThinkingEntry(entry)) {
      flushCurrentGroup();

      if (
        currentThinkingGroup.length > 0 &&
        currentThinkingProcessId === entry.executionProcessId
      ) {
        currentThinkingGroup.push(entry);
        continue;
      }

      flushCurrentThinkingGroup();
      currentThinkingGroup = [entry];
      currentThinkingProcessId = entry.executionProcessId;
      continue;
    }

    flushCurrentThinkingGroup();

    const aggregationType = getAggregatableAction(entry);
    const aggregationKey = getAggregationKey(entry);

    if (!aggregationType || !aggregationKey) {
      flushCurrentGroup();
      displayEntries.push(entry);
      continue;
    }

    if (
      currentGroup.length > 0 &&
      aggregationKey === currentAggregationKey &&
      aggregationType === currentAggregationType
    ) {
      currentGroup.push(entry);
      continue;
    }

    flushCurrentGroup();
    currentGroup = [entry];
    currentAggregationType = aggregationType;
    currentAggregationKey = aggregationKey;
  }

  flushProcessScopedGroups();
  flushProcessChangeSummary(currentProcessId);

  return collapseAiMessagesByDefault
    ? collapseAssistantPreludeEntries(displayEntries)
    : displayEntries;
}

export function getAggregatedEntryDetail(data: PatchTypeWithKey): string {
  if (data.type !== 'NORMALIZED_ENTRY') return '';
  const entry = data.content;
  if (entry.entry_type.type !== 'tool_use') return '';
  const at = entry.entry_type.action_type;
  if (at.action === 'file_read') return at.path;
  if (at.action === 'search') return at.query;
  if (at.action === 'web_fetch') return at.url;
  if (at.action === 'command_run') {
    const firstLine = at.command.split(/\r?\n/)[0]?.trim() ?? '';
    return firstLine;
  }
  if (at.action === 'task_create') return at.description;
  return '';
}
