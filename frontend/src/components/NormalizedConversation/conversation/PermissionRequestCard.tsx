import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, ShieldQuestion, Terminal } from 'lucide-react';
import type {
  AgentPermissionOption,
  AgentPermissionResponse,
  ConversationPermissionView,
} from 'shared/types';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Inline, answerable permission request (VibeX style — anchored in the timeline,
 * not a blocking modal). Renders the *real* ACP tool-call detail behind the
 * request (file-edit before/after, command, file locations) so the user can
 * review exactly what the agent will do before allowing it, then answer with the
 * agent's own permission options. All data comes from the live/persisted
 * `permission_requested` event — nothing is synthesized.
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
  const detail = useMemo(() => parseToolDetail(request.details), [request.details]);

  return (
    <div className="conv-entry-item rounded-lg border border-amber-300/55 bg-amber-50/80 px-3 py-2.5 text-sm dark:border-amber-500/30 dark:bg-amber-950/25">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 shrink-0 rounded-md border border-amber-300/60 bg-amber-100/70 p-1 text-amber-700 dark:border-amber-500/30 dark:bg-amber-900/40 dark:text-amber-200">
          <ShieldQuestion className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium text-amber-900 dark:text-amber-100">
              {request.title ?? t('permissionRequestCard.title')}
            </span>
            {detail.kind ? (
              <span className="conv-count-badge shrink-0">{detail.kind}</span>
            ) : null}
          </div>

          {detail.body ? (
            <div className="mt-2">{detail.body}</div>
          ) : null}

          {pending ? (
            <div className="mt-2.5 flex flex-wrap gap-2">
              {options.map((option) => (
                <Button
                  key={option.id}
                  type="button"
                  size="sm"
                  variant={optionVariant(option)}
                  disabled={responding}
                  onClick={() =>
                    onRespond(request.permission_id, {
                      kind: 'selected',
                      option_id: option.id,
                    })
                  }
                >
                  {option.label}
                </Button>
              ))}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={responding}
                onClick={() =>
                  onRespond(request.permission_id, { kind: 'cancelled' })
                }
              >
                {t('common:cancel')}
              </Button>
            </div>
          ) : (
            <div className="mt-2 text-xs text-amber-800/70 dark:text-amber-100/60">
              {t('permissionRequestCard.responded')}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function optionVariant(
  option: AgentPermissionOption
): 'default' | 'outline' | 'destructive' {
  if (option.kind === 'reject_always') return 'destructive';
  if (option.kind === 'reject_once') return 'outline';
  return 'default';
}

type ParsedDetail = { kind: string | null; body: React.ReactNode | null };

/** ACP tool-call shape behind a permission request (camelCase from ACP serde). */
type ToolDetail = {
  fields?: {
    kind?: string | null;
    title?: string | null;
    content?: unknown[] | null;
    locations?: { path?: string }[] | null;
    rawInput?: unknown;
  } | null;
};

/** Faithfully render whatever the agent actually sent — never fabricate. */
function parseToolDetail(details: unknown): ParsedDetail {
  if (!details || typeof details !== 'object') {
    return { kind: null, body: null };
  }
  const fields = (details as ToolDetail).fields ?? null;
  const kind = typeof fields?.kind === 'string' ? fields.kind : null;
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
          className="overflow-x-auto whitespace-pre-wrap rounded-md border border-amber-300/40 bg-amber-100/40 px-2.5 py-1.5 font-mono text-xs text-amber-950 dark:border-amber-500/25 dark:bg-amber-900/25 dark:text-amber-100"
        >
          {text}
        </pre>
      );
    }
  });

  // 2) Command preview from rawInput when no content block surfaced one.
  if (blocks.length === 0) {
    const command = extractCommand(fields?.rawInput);
    if (command) {
      blocks.push(
        <div
          key="command"
          className="flex items-start gap-2 rounded-md border border-amber-300/40 bg-amber-100/40 px-2.5 py-1.5 dark:border-amber-500/25 dark:bg-amber-900/25"
        >
          <Terminal className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-700 dark:text-amber-200" />
          <code className="overflow-x-auto whitespace-pre-wrap font-mono text-xs text-amber-950 dark:text-amber-100">
            {command}
          </code>
        </div>
      );
    }
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
        className="mt-1 space-y-0.5 text-xs text-amber-800/80 dark:text-amber-100/70"
      >
        {paths.map((p) => (
          <li key={p} className="truncate font-mono">
            {p}
          </li>
        ))}
      </ul>
    );
  }

  // 4) Nothing structured recognized → show the real raw detail (collapsed).
  if (blocks.length === 0) {
    blocks.push(<RawDetail key="raw" details={details} />);
  }

  return { kind, body: <div className="space-y-1.5">{blocks}</div> };
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
    <div className="rounded-md border border-amber-300/40 bg-amber-100/30 dark:border-amber-500/25 dark:bg-amber-900/20">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-xs"
        aria-expanded={open}
      >
        <ChevronRight
          className={cn('h-3 w-3 shrink-0 transition-transform', open && 'rotate-90')}
        />
        <span className="truncate font-mono text-amber-900 dark:text-amber-100">
          {path}
        </span>
        <span className="ml-auto shrink-0 text-amber-700/70 dark:text-amber-200/60">
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
      <div className="mb-0.5 text-[10px] uppercase tracking-wide text-amber-700/70 dark:text-amber-200/60">
        {label}
      </div>
      <pre
        className={cn(
          'max-h-64 overflow-auto whitespace-pre-wrap rounded border px-2 py-1 font-mono text-[11px]',
          tone === 'del'
            ? 'border-red-300/40 bg-red-50/60 text-red-900 dark:border-red-500/25 dark:bg-red-950/25 dark:text-red-100'
            : 'border-emerald-300/40 bg-emerald-50/60 text-emerald-900 dark:border-emerald-500/25 dark:bg-emerald-950/25 dark:text-emerald-100'
        )}
      >
        {text}
      </pre>
    </div>
  );
}

function RawDetail({ details }: { details: unknown }) {
  const { t } = useTranslation(['conversation', 'common']);
  const [open, setOpen] = useState(false);
  const json = useMemo(() => {
    try {
      return JSON.stringify(details, null, 2);
    } catch {
      return String(details);
    }
  }, [details]);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-xs text-amber-800/80 dark:text-amber-100/70"
        aria-expanded={open}
      >
        <ChevronRight
          className={cn('h-3 w-3 transition-transform', open && 'rotate-90')}
        />
        {t('permissionRequestCard.viewDetails')}
      </button>
      {open ? (
        <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-amber-300/40 bg-amber-100/40 px-2.5 py-1.5 font-mono text-[11px] text-amber-950 dark:border-amber-500/25 dark:bg-amber-900/25 dark:text-amber-100">
          {json}
        </pre>
      ) : null}
    </div>
  );
}
