import type {
  ActionType,
  FileChange,
  JsonValue,
  NormalizedEntry,
} from 'shared/types';
import type { ToolResultBlock, ToolUseBlock } from './messageTurnBlocks';
import i18n from '@/i18n';

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
function extractOutputParts(value: unknown, depth = 0): string[] {
  if (depth > 5 || value == null) return [];
  if (typeof value === 'string') return value.length > 0 ? [value] : [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => extractOutputParts(item, depth + 1));
  }
  if (typeof value !== 'object') return [];

  const record = value as Record<string, unknown>;
  const direct = ['stdout', 'stderr', 'output', 'text']
    .map((key) => record[key])
    .filter(
      (part): part is string => typeof part === 'string' && part.length > 0
    );
  if (direct.length > 0) return direct;
  return extractOutputParts(record.content, depth + 1);
}

function extractOutputText(preview: string | null): string | null {
  if (!preview) return preview;
  try {
    const parsed: unknown = JSON.parse(preview);
    if (typeof parsed === 'string') return parsed;
    const parts = extractOutputParts(parsed);
    if (parts.length > 0) return parts.join('\n');
  } catch {
    // Not JSON — already plain text.
  }
  return preview;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
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
    'line'
  );
  const explicitEnd = firstNonNegativeInteger(
    obj,
    'line_end',
    'end_line',
    'endLine'
  );
  const offset = firstNonNegativeInteger(obj, 'offset');
  const limit = firstNonNegativeInteger(
    obj,
    'limit',
    'line_count',
    'lineCount'
  );
  const lineStart = explicitStart ?? (offset != null ? offset + 1 : null);
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

/** Path from an apply_patch header: `*** Add|Update|Delete File: <path>`. */
function patchPath(patch: string): string | null {
  const match = patch.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/m);
  return match ? match[1].trim() : null;
}

/**
 * Turn whatever edit payload a tool carried into a unified-diff FileChange so
 * the rich inline-diff card renders. EditDiffRenderer tolerates a non-standard
 * diff (it falls back to a readable <pre>), so a synthesized hunk is safe.
 */
function editChanges(
  obj: Record<string, unknown>,
  parsed: unknown,
  raw: string | null
): { path: string; changes: FileChange[] } | null {
  // 1) apply_patch envelope (Codex) — keep the patch verbatim; path from header.
  const patch = patchPayload(parsed, raw);
  if (patch) {
    const path = patchPath(patch);
    if (path) {
      return {
        path,
        changes: [
          { action: 'edit', unified_diff: patch, has_line_numbers: false },
        ],
      };
    }
  }

  const path = firstString(
    obj,
    'file_path',
    'path',
    'filename',
    'file',
    'abs_path'
  );
  if (!path) return null;

  // 2) A ready-made unified diff/patch field — render it directly.
  const diff = firstString(obj, 'unified_diff', 'diff', 'patch');
  if (diff) {
    return {
      path,
      changes: [
        { action: 'edit', unified_diff: diff, has_line_numbers: false },
      ],
    };
  }

  // 3) old/new replacement — synthesize a hunk from the two sides.
  const oldStr = firstString(obj, 'old_string', 'old_str', 'oldText', 'old');
  const newStr = firstString(
    obj,
    'new_string',
    'new_str',
    'newText',
    'new',
    'replacement'
  );
  if (oldStr != null || newStr != null) {
    const removed = (oldStr ?? '').split('\n').map((line) => `-${line}`);
    const added = (newStr ?? '').split('\n').map((line) => `+${line}`);
    return {
      path,
      changes: [
        {
          action: 'edit',
          unified_diff: ['@@', ...removed, ...added].join('\n'),
          has_line_numbers: false,
        },
      ],
    };
  }

  // 4) Full-file write — present the new contents as added lines.
  const content = firstString(
    obj,
    'content',
    'contents',
    'new_content',
    'text'
  );
  if (content != null) {
    const added = content
      .split('\n')
      .map((line) => `+${line}`)
      .join('\n');
    return {
      path,
      changes: [
        {
          action: 'edit',
          unified_diff: `@@\n${added}`,
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
  return toolName.replace(/[\s._-]/g, '').toLowerCase();
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
  output: string | null
): CommandRunAction {
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
            exit_status: { type: 'success', success: status === 'success' },
            output,
          },
  };
}

function toolActionType(
  toolName: string,
  kind: string | null,
  parsed: unknown,
  output: string | null,
  status: 'created' | 'success' | 'failed',
  rawInput: string | null
): ActionType {
  // A bare-string input (not a JSON object) is, for exec-style tools, the
  // command itself — render it as a terminal card instead of a generic one.
  if (
    typeof parsed === 'string' &&
    parsed.trim().length > 0 &&
    !parsed.includes(PATCH_SENTINEL) &&
    (kind == null || kind === 'execute' || kind === 'other')
  ) {
    return { ...commandResult(status, output), command: parsed.trim() };
  }

  const obj = asRecord(parsed);
  const name = canonicalName(toolName);

  const command = firstCommand(obj);
  const path = firstString(
    obj,
    'file_path',
    'path',
    'filename',
    'file',
    'abs_path'
  );
  const query = firstString(obj, 'pattern', 'query', 'q', 'glob', 'regex');
  const url = firstString(obj, 'url', 'uri', 'href');

  // Command — by ACP kind first (agents' titles are free-form prose, so the
  // declared kind is the reliable signal), then by name, by a `command` field,
  // or by a command-shaped tool title.
  if (
    kind === 'execute' ||
    SHELL_NAMES.has(name) ||
    (command && !READ_NAMES.has(name) && !SEARCH_NAMES.has(name)) ||
    (!command && looksLikeShellCommand(toolName))
  ) {
    return {
      ...commandResult(status, output),
      command: command ?? toolName.trim(),
    };
  }

  // Search — by kind, by name, or a bare pattern with no file path.
  if (kind === 'search' || SEARCH_NAMES.has(name) || (query && !path)) {
    return {
      action: 'search',
      query: query ?? '',
      arguments: (parsed ?? null) as JsonValue,
      result:
        output != null
          ? { type: { type: 'markdown' }, value: output }
          : undefined,
    };
  }

  // Web fetch — by kind, by name, or a url with no command.
  if (kind === 'fetch' || WEB_NAMES.has(name) || (url && !command)) {
    return { action: 'web_fetch', url: url ?? '' };
  }

  // File edit / apply_patch — render an inline diff card (early style).
  if (
    kind === 'edit' ||
    EDIT_NAMES.has(name) ||
    looksLikeEdit(obj) ||
    patchPayload(parsed, rawInput)
  ) {
    const edit = editChanges(obj, parsed, rawInput);
    if (edit)
      return { action: 'file_edit', path: edit.path, changes: edit.changes };
  }

  // Plain file read — by kind, by name, or a lone path with no edit payload.
  if (
    (kind === 'read' || READ_NAMES.has(name) || path) &&
    !looksLikeEdit(obj) &&
    path
  ) {
    return {
      action: 'file_read',
      path,
      ...readRange(obj),
      ...(output != null ? { content: output } : {}),
    };
  }

  return {
    action: 'tool',
    tool_name: displayToolName(toolName, obj),
    arguments: (parsed ?? null) as JsonValue,
    result:
      output != null ? { type: { type: 'markdown' }, value: output } : null,
  };
}

/** A human label for the generic card: keep real names, recover opaque ids. */
function displayToolName(
  toolName: string,
  obj: Record<string, unknown>
): string {
  if (!OPAQUE_TOOL_ID.test(toolName.trim())) return toolName;
  if (looksLikeEdit(obj)) {
    const path = firstString(obj, 'file_path', 'path', 'filename');
    return path
      ? i18n.t('app:turnTool.editFile', { path })
      : i18n.t('app:turnTool.editFileGeneric');
  }
  return i18n.t('app:turnTool.toolCall');
}

export function toolBlockToNormalizedEntry(
  use: ToolUseBlock,
  result: ToolResultBlock | null,
  timestamp: string | null
): NormalizedEntry {
  const output = extractOutputText(result?.output_preview ?? null);
  const statusKind: 'created' | 'success' | 'failed' = result
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
  const actionType = toolActionType(
    use.tool_name,
    use.kind ?? null,
    parsed,
    output,
    statusKind,
    use.input_preview ?? null
  );

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
              ? actionType.tool_name
              : use.tool_name;

  return {
    timestamp,
    content,
    entry_type: {
      type: 'tool_use',
      tool_name: use.tool_name,
      action_type: actionType,
      status,
    },
  };
}
