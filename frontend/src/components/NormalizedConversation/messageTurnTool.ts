import type {
  ActionType,
  FileChange,
  JsonValue,
  NormalizedEntry,
  ToolResult,
} from 'shared/types';
import type { ToolResultBlock, ToolUseBlock } from './messageTurnBlocks';
import i18n from '@/i18n';
import {
  normalizeToolDiff,
  parseApplyPatch,
  replacementDiff,
} from './tools/toolEditDiff';
import type { FileEditPreview } from './tools/toolEditDiff';

export type ToolDisplayEntry = NormalizedEntry & {
  fileEdits?: FileEditPreview[];
  toolResult?: ToolResult | null;
  toolArguments?: JsonValue | null;
};

/**
 * Adapts a unified-timeline tool block (the normalized `ContentBlock`
 * tool_use + paired tool_result) into a `NormalizedEntry` adapter, so the
 * timeline can reuse VibeX's existing rich tool cards (file/search/command/
 * generic) via `DisplayConversationEntry`.
 *
 * The backend projects a tool call's `tool_name` as `title ?? kind ?? call_id`
 * (see `conversation_projection.rs`). Agents that don't carry a title/kind —
 * notably OpenAI/Codex function calls — therefore arrive with `tool_name` set
 * to an opaque `call_…` id. We recover the real action from the parsed tool
 * input (command / path / pattern / url) regardless of the name, so a shell
 * call renders as a "终端" card instead of a raw id. VibeX-authored.
 */

/** Opaque tool identifiers that carry no display meaning on their own. */
const OPAQUE_TOOL_ID =
  /^(call_[A-Za-z0-9]{6,}|fc_[A-Za-z0-9]{6,}|tool[-_][A-Za-z0-9]{6,}|toolu_[A-Za-z0-9]{6,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/**
 * Agents sometimes record the real tool only as `arguments.variant` and leave
 * the call title as a placeholder (`tool`, `use_tool`). Those names are not
 * labels; the variant is.
 */
const PLACEHOLDER_TOOL_NAMES = new Set(['tool', 'usetool', 'function', 'call']);

function parseInput(use: ToolUseBlock): unknown {
  if (!use.input_preview) return null;
  try {
    const parsed: unknown = JSON.parse(use.input_preview);
    // Events persisted before the bridge fix wrapped the real (already
    // JSON-serialized) input as `{ preview: "..." }` — unwrap so historical
    // conversations keep rendering their true arguments.
    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      Object.keys(parsed).length === 1 &&
      typeof (parsed as Record<string, unknown>).preview === 'string'
    ) {
      const inner = (parsed as Record<string, string>).preview;
      try {
        return JSON.parse(inner);
      } catch {
        return inner;
      }
    }
    return parsed;
  } catch {
    return use.input_preview;
  }
}

/**
 * Tool outputs arrive as the agent's rawOutput serialized to JSON — surface the
 * human-readable text (stdout/stderr/output) instead of an escaped JSON blob.
 */
const OUTPUT_TEXT_KEYS = [
  'stdout',
  'stderr',
  'output',
  'combinedOutput',
  'formatted_output',
  'text',
  'FileContent',
  'file_content',
  'fileContent',
  'content',
  'result',
  'value',
];

function extractOutputParts(value: unknown, depth = 0): string[] {
  if (depth > 5 || value == null) return [];
  if (typeof value === 'string') return value.length > 0 ? [value] : [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => extractOutputParts(item, depth + 1));
  }
  if (typeof value !== 'object') return [];

  const record = value as Record<string, unknown>;
  if ('stdout' in record || 'stderr' in record) {
    return ['stdout', 'stderr'].flatMap((key) =>
      extractOutputParts(record[key], depth + 1)
    );
  }
  for (const key of OUTPUT_TEXT_KEYS) {
    const parts = extractOutputParts(record[key], depth + 1);
    if (parts.length > 0) return parts;
  }
  return [];
}

function extractOutputText(
  preview: string | null,
  result: ToolResult | null
): string | null {
  if (!preview) return preview;
  if (typeof result?.value === 'string') return result.value;
  const parts = extractOutputParts(result?.value);
  if (parts.length > 0) return parts.join('\n');
  return preview;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const FILE_PATH_KEYS = [
  'file_path',
  'target_file',
  'targetFile',
  'path',
  'filename',
  'file',
  'abs_path',
  'filepath',
  'filePath',
  'absolute_path',
  'absolutePath',
  'AbsolutePath',
  'TargetFile',
];

const LINE_NUMBER_PREFIX = /^(?: {0,3}(\d+)(?:→|[|:]\s?|\t))/;

function firstPath(obj: Record<string, unknown>): string | null {
  const path = firstString(obj, ...FILE_PATH_KEYS);
  if (path) return path;
  const uri = firstString(obj, 'uri');
  if (uri?.startsWith('file://')) {
    return decodeURIComponent(uri.slice('file://'.length));
  }
  return null;
}

function firstUrl(obj: Record<string, unknown>): string | null {
  const url = firstString(obj, 'url', 'href');
  if (url) return url;
  const uri = firstString(obj, 'uri');
  return uri && /^https?:\/\//i.test(uri) ? uri : null;
}

function nestedRecord(
  obj: Record<string, unknown>,
  key: string
): Record<string, unknown> {
  return asRecord(obj[key]);
}

function firstStringDeep(
  obj: Record<string, unknown>,
  ...keys: string[]
): string | null {
  return (
    firstString(obj, ...keys) ??
    firstString(nestedRecord(obj, 'action'), ...keys) ??
    firstString(nestedRecord(obj, 'input'), ...keys)
  );
}

/** Turn `12→code` / `12: code` dumps into the raw snippet plus its first file line. */
export function stripNumberedFileLines(content: string): {
  content: string;
  startLine?: number;
} {
  const lines = content.split(/\r?\n/);
  if (lines.length === 0) return { content };

  const parsed = lines.map((line) => {
    const match = line.match(LINE_NUMBER_PREFIX);
    return match
      ? { line: Number(match[1]), text: line.slice(match[0].length) }
      : null;
  });
  const numbered = parsed.filter(
    (item): item is { line: number; text: string } => item != null
  );
  if (numbered.length === 0 || numbered.length < lines.length * 0.7) {
    return { content };
  }

  return {
    content: parsed
      .map((item, index) => (item ? item.text : lines[index]))
      .join('\n'),
    startLine: numbered[0].line,
  };
}

function firstString(
  obj: Record<string, unknown>,
  ...keys: string[]
): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return null;
}

function firstNonNegativeInteger(
  obj: Record<string, unknown>,
  ...keys: string[]
): number | null {
  for (const key of keys) {
    const value = obj[key];
    const numberValue =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim() !== ''
          ? Number(value)
          : Number.NaN;
    if (Number.isInteger(numberValue) && numberValue >= 0) return numberValue;
  }
  return null;
}

function readRange(obj: Record<string, unknown>): {
  line_start?: number;
  line_end?: number;
} {
  const explicitStart = firstNonNegativeInteger(
    obj,
    'line_start',
    'start_line',
    'startLine',
    'StartLine',
    'line'
  );
  const explicitEnd = firstNonNegativeInteger(
    obj,
    'line_end',
    'end_line',
    'endLine',
    'EndLine'
  );
  const offset = firstNonNegativeInteger(obj, 'offset');
  const limit = firstNonNegativeInteger(
    obj,
    'limit',
    'line_count',
    'lineCount'
  );
  // Agent Read tools treat offset as the first file line (1-based). A 0
  // offset still means the start of the file.
  const lineStart =
    explicitStart ?? (offset != null ? Math.max(offset, 1) : null);
  const lineEnd =
    explicitEnd ??
    (lineStart != null && limit != null && limit > 0
      ? lineStart + limit - 1
      : null);

  return {
    ...(lineStart != null ? { line_start: lineStart } : {}),
    ...(lineEnd != null ? { line_end: lineEnd } : {}),
  };
}

/** Shell input arrives as a string or an argv array (OpenAI/Codex shell calls). */
function firstCommand(obj: Record<string, unknown>): string | null {
  for (const key of [
    'command',
    'cmd',
    'script',
    'shell_command',
    'commandLine',
    'command_line',
    'CommandLine',
  ]) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
    if (Array.isArray(value) && value.length > 0) {
      const parts = value.filter(
        (part): part is string => typeof part === 'string'
      );
      if (parts.length > 0) return parts.join(' ');
    }
  }
  return null;
}

/** An edit/write carries the new contents; a plain read never does. */
function looksLikeEdit(obj: Record<string, unknown>): boolean {
  return [
    'old_string',
    'new_string',
    'old_str',
    'new_str',
    'content',
    'contents',
    'patch',
    'diff',
    'edits',
    'replacement',
  ].some((key) => key in obj);
}

const SHELL_NAMES = new Set([
  'bash',
  'shell',
  'sh',
  'zsh',
  'fish',
  'pwsh',
  'powershell',
  'cmd',
  'exec',
  'execcommand',
  'executecommand',
  'execute',
  'command',
  'commandrun',
  'runcommand',
  'run',
  'terminal',
  'localshell',
  'shellcommand',
  'containerexec',
]);

const READ_NAMES = new Set([
  'read',
  'readfile',
  'readtextfile',
  'viewfile',
  'view',
  'cat',
  'open',
  'openfile',
]);

const SEARCH_NAMES = new Set([
  'grep',
  'glob',
  'search',
  'find',
  'ripgrep',
  'rg',
  'filesearch',
  'codesearch',
  'websearch',
]);

const LIST_DIR_NAMES = new Set([
  'listdir',
  'listdirectory',
  'listfolder',
  'readdir',
  'lsdir',
]);

const WEB_NAMES = new Set([
  'webfetch',
  'websearch',
  'webfetchtool',
  'fetch',
  'httpfetch',
  'browse',
  'openurl',
  'urlfetch',
]);

const EDIT_NAMES = new Set([
  'edit',
  'editfile',
  'multiedit',
  'write',
  'writefile',
  'createfile',
  'applypatch',
  'strreplace',
  'strreplaceeditor',
  'update',
  'notebookedit',
]);

const PATCH_SENTINEL = '*** Begin Patch';

/** Codex/OpenAI apply_patch payload — a bare string or nested under any field. */
function patchPayload(parsed: unknown, raw: string | null): string | null {
  // Prefer the parsed (unescaped) form so the header lines keep real newlines.
  if (typeof parsed === 'string' && parsed.includes(PATCH_SENTINEL)) {
    return parsed;
  }
  for (const value of Object.values(asRecord(parsed))) {
    if (typeof value === 'string' && value.includes(PATCH_SENTINEL)) {
      return value;
    }
  }
  // Last resort: a bare patch string that failed to JSON-parse arrives as raw.
  if (raw && raw.includes(PATCH_SENTINEL) && !raw.trimStart().startsWith('{')) {
    return raw;
  }
  return null;
}

/**
 * Turn whatever edit payload a tool carried into a unified-diff FileChange so
 * the rich inline-diff card renders. Fragment line numbers are not file positions.
 */
function editChanges(
  obj: Record<string, unknown>
): { path: string; changes: FileChange[] } | null {
  const path = firstPath(obj);
  if (!path) return null;

  const diff = firstString(obj, 'unified_diff', 'diff', 'patch');
  if (diff) {
    return {
      path,
      changes: [
        {
          action: 'edit',
          unified_diff: normalizeToolDiff(path, diff),
          has_line_numbers: false,
        },
      ],
    };
  }

  const oldStr = firstText(
    obj,
    'old_string',
    'old_str',
    'oldText',
    'old_text',
    'old'
  );
  const newStr = firstText(
    obj,
    'new_string',
    'new_str',
    'newText',
    'new_text',
    'new',
    'replacement'
  );
  if (oldStr != null || newStr != null) {
    return {
      path,
      changes: [
        {
          action: 'edit',
          unified_diff: replacementDiff(path, oldStr ?? '', newStr ?? ''),
          has_line_numbers: false,
        },
      ],
    };
  }

  const content = firstText(obj, 'content', 'contents', 'new_content', 'text');
  if (content != null) {
    return {
      path,
      changes: [
        {
          action: 'edit',
          unified_diff: replacementDiff(path, '', content),
          has_line_numbers: false,
        },
      ],
    };
  }

  // ACP edit calls may advertise only the target location while the actual
  // patch is applied out-of-band. Preserve edit semantics so the UI can still
  // name and open the affected file instead of misclassifying it as a read.
  return {
    path,
    changes: [{ action: 'edit', unified_diff: '', has_line_numbers: false }],
  };
}

/** Normalize a tool/kind name for set membership (drops spaces, _, -, dots). */
function canonicalName(toolName: string): string {
  return toolName
    .replace(/^Running\s+/i, '')
    .replace(/[\s._-]/g, '')
    .toLowerCase();
}

/**
 * The backend frequently sets tool_name to the raw shell command (its ACP
 * title), e.g. "Get-ChildItem -Recurse" or "git status --short". Treat a
 * command-shaped title as a terminal so it renders as a 终端 card and aggregates
 * with other commands rather than the generic 工具调用 bucket.
 */
function looksLikeShellCommand(toolName: string): boolean {
  const value = toolName.trim();
  if (!value || OPAQUE_TOOL_ID.test(value)) return false;
  // PowerShell verb-noun cmdlet (Get-ChildItem, Where-Object, Set-Location…).
  if (/^[A-Z][a-z]+-[A-Z][A-Za-z]/.test(value)) return true;
  // A CLI flag, pipe, redirect, or command chain.
  return /\s--?[A-Za-z]|[|]|&&|>>?/.test(value);
}

type CommandRunAction = Extract<ActionType, { action: 'command_run' }>;

function commandResult(
  status: 'created' | 'success' | 'failed',
  output: string | null,
  toolResult: ToolResult | null
): CommandRunAction {
  const record = asRecord(toolResult?.value);
  const reportedCode = record.exit_code ?? record.exitCode;
  const exitCode =
    typeof reportedCode === 'number' && Number.isInteger(reportedCode)
      ? reportedCode
      : null;
  return {
    action: 'command_run',
    category: 'other',
    command: '',
    result:
      status === 'created'
        ? output != null
          ? { exit_status: null, output }
          : null
        : {
            exit_status:
              exitCode != null
                ? { type: 'exit_code', code: exitCode }
                : { type: 'success', success: status === 'success' },
            output,
          },
  };
}

function firstText(
  obj: Record<string, unknown>,
  ...keys: string[]
): string | null {
  for (const key of keys) {
    if (typeof obj[key] === 'string') return obj[key];
  }
  return null;
}

function fileEditPreviews(
  parsed: unknown,
  raw: string | null
): FileEditPreview[] {
  const patch = patchPayload(parsed, raw);
  if (patch) return parseApplyPatch(patch);
  const obj = asRecord(parsed);
  const members = obj.edits ?? obj.changes;
  if (Array.isArray(members)) {
    return members.flatMap((member) => {
      const record = asRecord(member);
      const edit = editChanges({ file_path: firstPath(obj), ...record });
      return edit ? [edit] : [];
    });
  }
  const edit = editChanges(obj);
  return edit ? [edit] : [];
}

export function toolResultFromPreview(
  preview: string | null
): ToolResult | null {
  if (preview == null) return null;
  try {
    const value: JsonValue = JSON.parse(preview);
    return typeof value === 'string'
      ? { type: { type: 'markdown' }, value }
      : { type: { type: 'json' }, value };
  } catch {
    return { type: { type: 'markdown' }, value: preview };
  }
}

function toolActionType(
  toolName: string,
  kind: string | null,
  parsed: unknown,
  output: string | null,
  status: 'created' | 'success' | 'failed',
  rawInput: string | null,
  structuredResult: ToolResult | null,
  getFileEdits: () => FileEditPreview[]
): ActionType {
  // A bare-string input (not a JSON object) is, for exec-style tools, the
  // command itself — render it as a terminal card instead of a generic one.
  if (
    typeof parsed === 'string' &&
    parsed.trim().length > 0 &&
    !parsed.includes(PATCH_SENTINEL) &&
    (kind == null || kind === 'execute' || kind === 'other')
  ) {
    return {
      ...commandResult(status, output, structuredResult),
      command: parsed.trim(),
    };
  }

  const obj = asRecord(parsed);
  const reportedName = toolName.trim();
  const reportedCanonical = canonicalName(reportedName);
  const variant =
    reportedCanonical.length === 0 ||
    PLACEHOLDER_TOOL_NAMES.has(reportedCanonical)
      ? firstString(obj, 'variant')
      : null;
  const name = canonicalName(variant ?? reportedName);
  const labelName = (variant ?? reportedName).trim();

  const command = firstCommand(obj);
  const path = firstPath(obj);
  const dirPath =
    firstStringDeep(obj, 'target_directory', 'directory', 'dir') ??
    (LIST_DIR_NAMES.has(name) ? path : null);
  const parsedOutput = structuredResult?.value;
  const outputRecord = asRecord(parsedOutput);
  const query =
    firstStringDeep(obj, 'pattern', 'query', 'q', 'glob', 'regex') ??
    (outputRecord
      ? firstStringDeep(outputRecord, 'pattern', 'query', 'q')
      : null);
  const url = firstUrl(obj);

  if (/(^|__)browser_/.test(toolName)) {
    return {
      action: 'tool',
      tool_name: toolName,
      arguments: (parsed ?? null) as JsonValue,
      result: structuredResult,
    };
  }

  // Command — by ACP kind first (agents' titles are free-form prose, so the
  // declared kind is the reliable signal), then by name, by a `command` field,
  // or by a command-shaped tool title.
  if (
    kind === 'execute' ||
    SHELL_NAMES.has(name) ||
    (command && !READ_NAMES.has(name) && !SEARCH_NAMES.has(name)) ||
    (!command && looksLikeShellCommand(labelName))
  ) {
    return {
      ...commandResult(status, output, structuredResult),
      command: command ?? labelName,
    };
  }

  if (LIST_DIR_NAMES.has(name)) {
    return {
      action: 'tool',
      tool_name: 'list_dir',
      arguments: {
        path: dirPath ?? path ?? '',
        ...(asRecord(parsed) ?? {}),
      } as JsonValue,
      result:
        output != null
          ? {
              type: { type: 'json' },
              value: (parsedOutput ?? output) as JsonValue,
            }
          : null,
    };
  }

  // Search — by kind, by name, or a bare pattern with no file path.
  if (kind === 'search' || SEARCH_NAMES.has(name) || (query && !path)) {
    return {
      action: 'search',
      query: query ?? '',
      arguments: (parsed ?? null) as JsonValue,
      result: structuredResult ?? undefined,
    };
  }

  // Web fetch — by kind, by name, or a url with no command.
  if (kind === 'fetch' || WEB_NAMES.has(name) || (url && !command)) {
    return { action: 'web_fetch', url: url ?? '' };
  }

  const isReadTool = kind === 'read' || READ_NAMES.has(name);

  // File edit / apply_patch — render an inline diff card (early style).
  if (
    !isReadTool &&
    (kind === 'edit' ||
      EDIT_NAMES.has(name) ||
      looksLikeEdit(obj) ||
      patchPayload(parsed, rawInput))
  ) {
    const edit = getFileEdits()[0];
    if (edit)
      return { action: 'file_edit', path: edit.path, changes: edit.changes };
  }

  // Plain file read — by kind, by name, or a lone path with no edit payload.
  if ((isReadTool || path) && !looksLikeEdit(obj) && path) {
    const stripped = output != null ? stripNumberedFileLines(output) : null;
    const range = readRange(obj);
    const outputRange = readRange(asRecord(structuredResult?.value));
    const lineStart =
      stripped?.startLine ?? outputRange.line_start ?? range.line_start;
    const snippetLines = stripped?.content
      ? stripped.content.split(/\r?\n/).length
      : 0;
    const lineEnd =
      stripped?.startLine != null && snippetLines > 0
        ? stripped.startLine + snippetLines - 1
        : (outputRange.line_end ?? range.line_end);

    return {
      action: 'file_read',
      path,
      ...(lineStart != null ? { line_start: lineStart } : {}),
      ...(lineEnd != null ? { line_end: lineEnd } : {}),
      ...(stripped?.content != null ? { content: stripped.content } : {}),
    };
  }

  const subagentType = firstString(
    obj,
    'subagent_type',
    'agent_type',
    'subagentType'
  );
  if (
    subagentType ||
    name === 'spawnsubagent' ||
    name === 'spawnagent' ||
    name === 'subagentlaunch'
  ) {
    return {
      action: 'task_create',
      description:
        firstString(obj, 'description', 'title', 'name') ?? labelName,
      subagent_type: subagentType,
      result: structuredResult,
    };
  }

  return {
    action: 'tool',
    tool_name: displayToolName(labelName, obj),
    arguments: (parsed ?? null) as JsonValue,
    result: structuredResult,
  };
}

/** A human label for the generic card: keep real names, recover opaque ids. */
function displayToolName(
  toolName: string,
  obj: Record<string, unknown>
): string {
  if (!OPAQUE_TOOL_ID.test(toolName.trim())) return toolName;
  if (looksLikeEdit(obj)) {
    const path = firstPath(obj);
    return path
      ? i18n.t('app:turnTool.editFile', { path })
      : i18n.t('app:turnTool.editFileGeneric');
  }
  return i18n.t('app:turnTool.toolCall');
}

type CachedToolEntry = {
  status: string | null | undefined;
  toolName: string;
  inputPreview: string | null | undefined;
  resultRef: ToolResultBlock | null;
  outputPreview: string | null | undefined;
  isError: boolean | undefined;
  timestamp: string | null;
  language: string;
  entry: ToolDisplayEntry;
};

const toolEntryByUseRef = new WeakMap<ToolUseBlock, CachedToolEntry>();
const toolEntryByKey = new Map<string, CachedToolEntry>();
const MAX_TOOL_ENTRY_CACHE_SIZE = 512;

export function toolBlockToNormalizedEntry(
  use: ToolUseBlock,
  result: ToolResultBlock | null,
  timestamp: string | null
): ToolDisplayEntry {
  const language = i18n.language ?? '';
  const outputPreview = result?.output_preview ?? null;
  const isError = result?.is_error;

  const refHit = toolEntryByUseRef.get(use);
  if (
    refHit &&
    refHit.status === use.status &&
    refHit.toolName === use.tool_name &&
    refHit.inputPreview === use.input_preview &&
    (refHit.resultRef === result ||
      (refHit.outputPreview === outputPreview && refHit.isError === isError)) &&
    refHit.timestamp === timestamp &&
    refHit.language === language
  ) {
    return refHit.entry;
  }

  const cacheKey = use.tool_use_id
    ? `${use.tool_use_id}:${use.status ?? ''}:${timestamp ?? ''}:${language}`
    : null;
  if (cacheKey) {
    const keyHit = toolEntryByKey.get(cacheKey);
    if (
      keyHit &&
      keyHit.toolName === use.tool_name &&
      keyHit.inputPreview === use.input_preview &&
      keyHit.outputPreview === outputPreview &&
      keyHit.isError === isError
    ) {
      toolEntryByUseRef.set(use, keyHit);
      return keyHit.entry;
    }
  }

  const toolResult = toolResultFromPreview(outputPreview);
  const output = extractOutputText(outputPreview, toolResult);
  const statusKind: 'created' | 'success' | 'failed' =
    use.status != null
      ? use.status === 'completed'
        ? 'success'
        : use.status === 'failed'
          ? 'failed'
          : 'created'
      : result
        ? result.is_error
          ? 'failed'
          : 'success'
        : 'created';
  const status =
    statusKind === 'created'
      ? ({ status: 'created' } as const)
      : statusKind === 'failed'
        ? ({ status: 'failed' } as const)
        : ({ status: 'success' } as const);

  const parsed = parseInput(use);
  let editPreviews: FileEditPreview[] | null = null;
  const getFileEdits = () =>
    (editPreviews ??= fileEditPreviews(parsed, use.input_preview ?? null));
  const actionType = toolActionType(
    use.tool_name,
    use.kind ?? null,
    parsed,
    output,
    statusKind,
    use.input_preview ?? null,
    toolResult,
    getFileEdits
  );
  const fileEdits = actionType.action === 'file_edit' ? getFileEdits() : [];

  // Inline content used as a fallback label/detail by the rich cards.
  const content =
    actionType.action === 'command_run'
      ? actionType.command
      : actionType.action === 'file_read' || actionType.action === 'file_edit'
        ? actionType.path
        : actionType.action === 'search'
          ? actionType.query
          : actionType.action === 'web_fetch'
            ? actionType.url
            : actionType.action === 'tool'
              ? ''
              : use.tool_name;

  const entry: ToolDisplayEntry = {
    timestamp,
    content,
    ...(fileEdits.length > 0 ? { fileEdits } : {}),
    toolResult,
    toolArguments: (parsed ?? null) as JsonValue,
    entry_type: {
      type: 'tool_use',
      tool_name: use.tool_name,
      action_type: actionType,
      status,
    },
  };

  const cachedRecord: CachedToolEntry = {
    status: use.status,
    toolName: use.tool_name,
    inputPreview: use.input_preview,
    resultRef: result,
    outputPreview,
    isError,
    timestamp,
    language,
    entry,
  };
  toolEntryByUseRef.set(use, cachedRecord);
  if (cacheKey) {
    if (
      toolEntryByKey.size >= MAX_TOOL_ENTRY_CACHE_SIZE &&
      !toolEntryByKey.has(cacheKey)
    ) {
      const oldestKey = toolEntryByKey.keys().next().value;
      if (oldestKey !== undefined) {
        toolEntryByKey.delete(oldestKey);
      }
    }
    toolEntryByKey.set(cacheKey, cachedRecord);
  }

  return entry;
}
