import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronRight,
  ChevronDown,
  FileText,
  Globe2,
  SquareTerminal,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type {
  AgentPermissionOption,
  AgentPermissionResponse,
  ConversationPermissionView,
} from 'shared/types';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import {
  resolvePermissionAllowOption,
  type PermissionAllowScope,
} from './permissionRequestPresentation';

/**
 * Inline, answerable permission request (VibeX style — docked at the bottom of
 * the message stream, not a blocking modal). Renders the *real* ACP tool-call
 * detail behind the request (file-edit before/after, command, file locations)
 * so the user can review exactly what the agent will do before allowing it,
 * then answer with the agent's own permission options. All data comes from the
 * live/persisted `permission_requested` event — nothing is synthesized.
 *
 * Visual: an opaque Tahoe content surface with a quiet hairline. Permission
 * scope is progressive: the safest one-shot approval stays primary while
 * broader agent-provided scopes live in the adjacent menu.
 */
export function PermissionRequestCard({
  request,
  onRespond,
  responding = false,
}: {
  request: ConversationPermissionView;
  onRespond: (permissionId: string, response: AgentPermissionResponse) => void;
  responding?: boolean;
}) {
  const { t } = useTranslation(['conversation', 'common']);
  const pending = request.status === 'pending';
  const options = request.options ?? [];
  const detail = useMemo(
    () => parseToolDetail(request.details, request.title),
    [request.details, request.title]
  );
  const permissionType = permissionTypeFor(detail.kind);
  const PermissionTypeIcon = permissionType.icon;
  const primaryAllow = resolvePermissionAllowOption(options, 'once');
  const rejectOption =
    options.find((option) => option.kind === 'reject_once') ??
    options.find((option) => option.kind === 'reject_always');
  const allowScopes: Array<{
    scope: PermissionAllowScope;
    label: string;
  }> = [
    { scope: 'once', label: t('permissionRequestCard.allowOnce') },
    { scope: 'session', label: t('permissionRequestCard.allowSession') },
    { scope: 'always', label: t('permissionRequestCard.allowAlways') },
  ];
  const respondWithOption = (option: AgentPermissionOption, persist = false) =>
    onRespond(request.permission_id, {
      kind: 'selected',
      option_id: option.id,
      ...(persist ? { persist: true } : {}),
    });
  const respondWithScope = (scope: PermissionAllowScope) => {
    const option = resolvePermissionAllowOption(options, scope);
    if (option) respondWithOption(option, scope !== 'once');
  };

  return (
    <section className="permission-request-card conv-entry-item w-full rounded-lg border border-border bg-[var(--conv-surface-card)] px-4 py-3.5 text-sm">
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <PermissionTypeIcon className="h-4 w-4" aria-hidden="true" />
          <span>{t(`permissionRequestCard.types.${permissionType.key}`)}</span>
        </div>
        <h3 className="mt-3 text-sm font-semibold text-foreground">
          {detail.heading ?? t('permissionRequestCard.title')}
        </h3>
        {detail.subtitle || detail.body ? (
          <div className="permission-request-preview-wrap mt-1" tabIndex={0}>
            <div className="permission-request-preview">
              {detail.subtitle ? (
                <p className="text-sm leading-5 text-foreground">
                  {detail.subtitle}
                </p>
              ) : null}
              {detail.body ? <div className="mt-1">{detail.body}</div> : null}
            </div>
          </div>
        ) : null}

        {pending ? (
          <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={responding}
              onClick={() =>
                rejectOption
                  ? respondWithOption(rejectOption)
                  : onRespond(request.permission_id, { kind: 'cancelled' })
              }
            >
              {t('permissionRequestCard.reject')}
            </Button>
            {primaryAllow ? (
              <div
                className="permission-request-allow-group inline-flex items-stretch"
                role="group"
                aria-label={t('permissionRequestCard.allowActions')}
              >
                <Button
                  type="button"
                  size="sm"
                  disabled={responding}
                  className="rounded-r-none"
                  onClick={() => respondWithScope('once')}
                >
                  {t('permissionRequestCard.allow')}
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      size="sm"
                      disabled={responding}
                      className="w-8 rounded-l-none border-l border-l-primary-foreground/20 px-0"
                      aria-label={t('permissionRequestCard.expandAllow')}
                    >
                      <ChevronDown className="h-3.5 w-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="end"
                    side="top"
                    className="w-[min(280px,calc(100vw-24px))] p-1.5"
                  >
                    {allowScopes.map(({ scope, label }) => {
                      const option = resolvePermissionAllowOption(
                        options,
                        scope
                      );
                      return (
                        <DropdownMenuItem
                          key={scope}
                          disabled={responding || !option}
                          className="px-2.5 py-2"
                          onSelect={() => respondWithScope(scope)}
                        >
                          {label}
                        </DropdownMenuItem>
                      );
                    })}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="mt-2 text-xs text-muted-foreground">
            {t('permissionRequestCard.responded')}
          </div>
        )}
      </div>
    </section>
  );
}

type PermissionType = {
  key: 'file' | 'terminal' | 'web' | 'tool';
  icon: LucideIcon;
};

function permissionTypeFor(kind: string | null): PermissionType {
  const normalized = kind?.trim().toLowerCase() ?? '';
  if (
    ['execute', 'command', 'terminal', 'shell', 'bash'].some((value) =>
      normalized.includes(value)
    )
  ) {
    return { key: 'terminal', icon: SquareTerminal };
  }
  if (
    ['file', 'read', 'write', 'edit', 'delete', 'move', 'copy', 'patch'].some(
      (value) => normalized.includes(value)
    )
  ) {
    return { key: 'file', icon: FileText };
  }
  if (
    ['web', 'browser', 'fetch', 'http', 'url'].some((value) =>
      normalized.includes(value)
    )
  ) {
    return { key: 'web', icon: Globe2 };
  }
  return { key: 'tool', icon: Wrench };
}

type ParsedDetail = {
  kind: string | null;
  heading: string | null;
  subtitle: string | null;
  body: React.ReactNode | null;
};

/** ACP tool-call shape behind a permission request (camelCase from ACP serde). */
type ToolDetail = {
  kind?: string | null;
  title?: string | null;
  content?: unknown[] | null;
  locations?: { path?: string }[] | null;
  rawInput?: unknown;
  _meta?: Record<string, unknown> | null;
  fields?: {
    kind?: string | null;
    title?: string | null;
    content?: unknown[] | null;
    locations?: { path?: string }[] | null;
    rawInput?: unknown;
    _meta?: Record<string, unknown> | null;
  } | null;
};

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pickNonEmptyString(
  obj: Record<string, unknown> | null | undefined,
  key: string
): string | null {
  const value = obj?.[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function extractShellCommandLabel(
  rawInput: unknown,
  command: string | null
): string | null {
  const obj = asObject(rawInput);
  if (!obj) return null;
  for (const key of ['description', 'title', 'summary']) {
    const label = pickNonEmptyString(obj, key);
    if (label && label !== command) {
      return label;
    }
  }
  return null;
}

/**
 * Resolve permission heading & subtitle following Codeg `permission-request.ts`:
 * 1. `_meta.claudeCode.title` (or `_meta.jetbrains.air.commandTitle`)
 * 2. `_meta.permission.title` (or `_meta.jetbrains.air.permission.title`)
 * 3. `toolCall.title` / `request.title`
 *
 * When a candidate is byte-equal to the shell command already rendered in the
 * command block, suppress it as a heading so the command is never printed twice.
 */
function resolvePermissionHeadings(
  record: ToolDetail | null,
  fields: NonNullable<ToolDetail['fields']> | null,
  requestTitle: string | null | undefined,
  command: string | null
): { heading: string | null; subtitle: string | null } {
  const meta = asObject(record?._meta) ?? asObject(fields?._meta) ?? null;
  const claudeCode = asObject(meta?.claudeCode);
  const air = asObject(asObject(meta?.jetbrains)?.air);
  const permission = asObject(meta?.permission) ?? asObject(air?.permission);

  const claudeTitle =
    pickNonEmptyString(claudeCode, 'title') ??
    pickNonEmptyString(air, 'commandTitle');
  const permissionTitle = pickNonEmptyString(permission, 'title');
  const metaHeadingRaw = claudeTitle ?? permissionTitle ?? null;

  const metaHeading =
    metaHeadingRaw !== null && command !== null && metaHeadingRaw === command
      ? extractShellCommandLabel(fields?.rawInput, command)
      : metaHeadingRaw;

  const toolCallTitle =
    pickNonEmptyString(fields as Record<string, unknown> | null, 'title') ??
    pickNonEmptyString(record as Record<string, unknown> | null, 'title');
  const trimmedRequestTitle =
    typeof requestTitle === 'string' && requestTitle.trim().length > 0
      ? requestTitle.trim()
      : null;

  if (metaHeading) {
    return {
      heading: metaHeading,
      subtitle: null,
    };
  }

  const fallbackCandidate = trimmedRequestTitle ?? toolCallTitle;
  const subtitle =
    fallbackCandidate !== null &&
    command !== null &&
    fallbackCandidate === command
      ? extractShellCommandLabel(fields?.rawInput, command)
      : fallbackCandidate;

  return {
    heading: null,
    subtitle,
  };
}

/** Faithfully render whatever the agent actually sent — never fabricate. */
function parseToolDetail(
  details: unknown,
  requestTitle?: string | null
): ParsedDetail {
  if (!details || typeof details !== 'object') {
    const trimmed =
      typeof requestTitle === 'string' && requestTitle.trim().length > 0
        ? requestTitle.trim()
        : null;
    return { kind: null, heading: null, subtitle: trimmed, body: null };
  }
  const record = details as ToolDetail;
  const fields =
    record.fields && typeof record.fields === 'object' ? record.fields : record;
  const kind = typeof fields?.kind === 'string' ? fields.kind : null;
  const command = extractCommand(fields?.rawInput);
  const { heading, subtitle } = resolvePermissionHeadings(
    record,
    fields,
    requestTitle,
    command
  );
  const blocks: React.ReactNode[] = [];

  // 1) Content blocks (diffs, text, terminal output) carry the richest preview.
  const content = Array.isArray(fields?.content) ? fields!.content! : [];
  content.forEach((raw, index) => {
    const block = raw as Record<string, unknown>;
    if (block?.type === 'diff') {
      blocks.push(
        <DiffPreview
          key={`diff-${index}`}
          path={typeof block.path === 'string' ? block.path : '(file)'}
          oldText={typeof block.oldText === 'string' ? block.oldText : ''}
          newText={typeof block.newText === 'string' ? block.newText : ''}
        />
      );
      return;
    }
    const text = extractText(block);
    if (text) {
      blocks.push(
        <pre
          key={`text-${index}`}
          className="overflow-x-auto whitespace-pre-wrap rounded-md bg-muted/40 px-2.5 py-1.5 font-mono text-xs text-foreground"
        >
          {text}
        </pre>
      );
    }
  });

  // 2) Command preview from rawInput when no content block surfaced one.
  if (blocks.length === 0 && command) {
    blocks.push(
      <div key="command" className="rounded-md bg-muted/40 px-2.5 py-1.5">
        <code className="block max-w-full overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs text-foreground">
          {command}
        </code>
      </div>
    );
  }

  // 3) File locations.
  const locations = Array.isArray(fields?.locations) ? fields!.locations! : [];
  const paths = locations
    .map((loc) => loc?.path)
    .filter((p): p is string => typeof p === 'string' && p.length > 0);
  if (paths.length > 0) {
    blocks.push(
      <ul
        key="locations"
        className="mt-1 space-y-0.5 text-xs text-muted-foreground"
      >
        {paths.map((p) => (
          <li key={p} className="truncate font-mono">
            {p}
          </li>
        ))}
      </ul>
    );
  }

  // Raw JSON dumps are developer-facing noise — when nothing structured is
  // recognized the title alone describes the request.
  return {
    kind,
    heading,
    subtitle,
    body:
      blocks.length > 0 ? <div className="space-y-1.5">{blocks}</div> : null,
  };
}

function extractText(block: Record<string, unknown>): string | null {
  if (typeof block?.text === 'string') return block.text;
  const inner = block?.content as Record<string, unknown> | undefined;
  if (inner && typeof inner.text === 'string') return inner.text;
  return null;
}

function extractCommand(rawInput: unknown): string | null {
  if (!rawInput || typeof rawInput !== 'object') return null;
  const input = rawInput as Record<string, unknown>;
  for (const key of ['command', 'cmd', 'script']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value;
    if (Array.isArray(value)) return value.join(' ');
  }
  return null;
}

function DiffPreview({
  path,
  oldText,
  newText,
}: {
  path: string;
  oldText: string;
  newText: string;
}) {
  const { t } = useTranslation(['conversation', 'common']);
  const [open, setOpen] = useState(false);
  const isNew = !oldText;
  return (
    <div className="rounded-md bg-muted/30">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-xs"
        aria-expanded={open}
      >
        <ChevronRight
          className={cn(
            'h-3 w-3 shrink-0 transition-transform',
            open && 'rotate-90'
          )}
        />
        <span className="truncate font-mono text-foreground">{path}</span>
        <span className="ml-auto shrink-0 text-muted-foreground">
          {isNew
            ? t('permissionRequestCard.newFile')
            : t('permissionRequestCard.modified')}
        </span>
      </button>
      {open ? (
        <div className="space-y-1 px-2.5 pb-2">
          {!isNew ? (
            <DiffPane
              label={t('permissionRequestCard.before')}
              text={oldText}
              tone="del"
            />
          ) : null}
          <DiffPane
            label={
              isNew
                ? t('permissionRequestCard.content')
                : t('permissionRequestCard.after')
            }
            text={newText}
            tone="add"
          />
        </div>
      ) : null}
    </div>
  );
}

function DiffPane({
  label,
  text,
  tone,
}: {
  label: string;
  text: string;
  tone: 'add' | 'del';
}) {
  return (
    <div>
      <div className="mb-0.5 text-[10px] uppercase tracking-wide text-warning/70">
        {label}
      </div>
      <pre
        className={cn(
          'max-h-64 overflow-auto whitespace-pre-wrap rounded border px-2 py-1 font-mono text-[11px]',
          tone === 'del'
            ? 'border-destructive/25 bg-destructive/5 text-destructive'
            : 'border-success/25 bg-success/5 text-success'
        )}
      >
        {text}
      </pre>
    </div>
  );
}
