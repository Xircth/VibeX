import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  Check,
  CircleAlert,
  Eye,
  Inbox,
  MessageCircleQuestion,
  ShieldQuestion,
  X,
  XCircle,
  Zap,
  ZapOff,
  type LucideIcon,
} from 'lucide-react';
import { AttentionItemKind, type AttentionItem } from 'shared/types';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { attentionApi } from '@/lib/api/attention';
import {
  pulseApi,
  type ApprovalOptionSpec,
  type PulseUserInteractionView,
} from '@/lib/api/pulse';
import { useOpenProjectSession } from '@/hooks/useOpenProjectSession';
import { backendListen } from '@/lib/backendTransport';
import { cn } from '@/lib/utils';

type SessionAttentionKind =
  | 'permission'
  | 'question'
  | 'notice'
  | 'warning'
  | 'error'
  | 'completed';

type SessionAttentionPayload = {
  projectId: string;
  workspaceId: string;
  sessionId: string;
  kind: SessionAttentionKind;
  title?: string | null;
  message?: string | null;
};

type OverlayItem = AttentionItem & { overlay: true };

const POLL_MS = 15_000;

const KIND_PRESENTATION: Record<
  AttentionItemKind,
  { icon: LucideIcon; labelKey: string; tone: 'blocking' | 'error' | 'info' }
> = {
  [AttentionItemKind.PENDING_PERMISSION]: {
    icon: ShieldQuestion,
    labelKey: 'attentionInbox.kindPermission',
    tone: 'blocking',
  },
  [AttentionItemKind.PENDING_QUESTION]: {
    icon: MessageCircleQuestion,
    labelKey: 'attentionInbox.kindQuestion',
    tone: 'blocking',
  },
  [AttentionItemKind.SESSION_NOTICE]: {
    icon: CircleAlert,
    labelKey: 'attentionInbox.kindNotice',
    tone: 'info',
  },
  [AttentionItemKind.TURN_COMPLETED]: {
    icon: Eye,
    labelKey: 'attentionInbox.kindCompleted',
    tone: 'info',
  },
  [AttentionItemKind.TURN_FAILED]: {
    icon: XCircle,
    labelKey: 'attentionInbox.kindFailed',
    tone: 'error',
  },
  [AttentionItemKind.TURN_INTERRUPTED]: {
    icon: ZapOff,
    labelKey: 'attentionInbox.kindInterrupted',
    tone: 'error',
  },
  [AttentionItemKind.IN_REVIEW]: {
    icon: Eye,
    labelKey: 'attentionInbox.kindInReview',
    tone: 'info',
  },
};

function useRelativeTime() {
  const { t } = useTranslation('statusbar');
  return (timestampMs: number | null) => {
    if (timestampMs === null) return null;
    const diffMs = Date.now() - timestampMs;
    if (diffMs < 60_000) return t('attentionInbox.justNow');
    const minutes = Math.floor(diffMs / 60_000);
    if (minutes < 60) return t('attentionInbox.minutesAgo', { count: minutes });
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return t('attentionInbox.hoursAgo', { count: hours });
    return t('attentionInbox.daysAgo', { count: Math.floor(hours / 24) });
  };
}

function extractFormFields(
  formSchema?: Record<string, unknown> | null
): Array<{ key: string; label: string }> {
  if (!formSchema || typeof formSchema !== 'object') {
    return [{ key: 'response', label: 'Response' }];
  }
  const properties = formSchema.properties;
  if (!properties || typeof properties !== 'object') {
    return [{ key: 'response', label: 'Response' }];
  }
  const entries = Object.entries(properties as Record<string, unknown>);
  if (entries.length === 0) {
    return [{ key: 'response', label: 'Response' }];
  }
  return entries.map(([key, schema]) => {
    const label =
      schema &&
      typeof schema === 'object' &&
      typeof (schema as { title?: unknown }).title === 'string'
        ? ((schema as { title: string }).title || key)
        : key;
    return { key, label };
  });
}

function PulseInteractionRow({
  interaction,
  onResolved,
}: {
  interaction: PulseUserInteractionView;
  onResolved: (id: string) => void;
}) {
  const [note, setNote] = useState('');
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [resolving, setResolving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const formFields = useMemo(
    () =>
      interaction.kind === 'ask_form'
        ? extractFormFields(interaction.formSchema)
        : [],
    [interaction.formSchema, interaction.kind]
  );

  const approvalOptions: ApprovalOptionSpec[] =
    interaction.approvalOptions.length > 0
      ? interaction.approvalOptions
      : [
          { id: 'approve', label: 'Approve' },
          { id: 'reject', label: 'Reject', destructive: true },
        ];

  const handleResolveOption = async (option: ApprovalOptionSpec) => {
    if (option.requireNote && !note.trim()) {
      setErrorMsg('Note is required for this decision.');
      return;
    }
    setResolving(true);
    setErrorMsg(null);
    try {
      await pulseApi.resolveUserInteraction({
        interactionId: interaction.id,
        optionId: option.id,
        note: note.trim() || null,
        formValues: null,
      });
      onResolved(interaction.id);
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Failed to submit decision.'
      );
    } finally {
      setResolving(false);
    }
  };

  const handleSubmitForm = async () => {
    setResolving(true);
    setErrorMsg(null);
    try {
      await pulseApi.resolveUserInteraction({
        interactionId: interaction.id,
        optionId: 'submit',
        note: note.trim() || null,
        formValues,
      });
      onResolved(interaction.id);
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Failed to submit form.'
      );
    } finally {
      setResolving(false);
    }
  };

  return (
    <div
      data-testid={`pulse-interaction-${interaction.id}`}
      className="mb-1.5 rounded-md border border-border bg-muted/40 p-2 text-xs"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5 font-medium text-foreground">
          <Zap
            className={cn(
              'h-3.5 w-3.5 shrink-0',
              interaction.severity === 'urgent'
                ? 'text-destructive'
                : interaction.severity === 'warning'
                  ? 'text-warning'
                  : 'text-primary'
            )}
          />
          <span className="truncate">{interaction.title}</span>
        </div>
        <span className="shrink-0 rounded border border-border bg-background px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
          {interaction.kind.replace('_', ' ')}
        </span>
      </div>

      {interaction.body ? (
        <p className="mt-1 text-xs text-muted-foreground">{interaction.body}</p>
      ) : null}

      {interaction.kind === 'ask_form' ? (
        <div className="mt-2 space-y-1.5">
          {formFields.map((field) => (
            <input
              key={field.key}
              type="text"
              aria-label={field.label}
              placeholder={field.label}
              value={formValues[field.key] ?? ''}
              onChange={(event) =>
                setFormValues((prev) => ({
                  ...prev,
                  [field.key]: event.target.value,
                }))
              }
              className="h-7 w-full rounded border border-border bg-background px-2 text-xs text-foreground focus:outline-none"
            />
          ))}
          <Button
            type="button"
            size="xs"
            disabled={resolving}
            className="h-6 w-full text-[11px]"
            data-testid={`pulse-interaction-submit-${interaction.id}`}
            onClick={() => void handleSubmitForm()}
          >
            Submit
          </Button>
        </div>
      ) : interaction.kind === 'approval' ? (
        <div className="mt-2 space-y-1.5">
          <input
            type="text"
            aria-label="Decision note"
            placeholder="Optional note…"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            className="h-6 w-full rounded border border-border bg-background px-2 text-[11px] text-foreground focus:outline-none"
          />
          <div className="flex flex-wrap items-center gap-1.5">
            {approvalOptions.map((option) => (
              <Button
                key={option.id}
                type="button"
                size="xs"
                variant={option.destructive ? 'destructive' : 'default'}
                disabled={resolving}
                data-testid={`pulse-approval-${interaction.id}-${option.id}`}
                className="h-6 gap-1 px-2 text-[11px]"
                onClick={() => void handleResolveOption(option)}
              >
                {option.destructive ? (
                  <X className="h-3 w-3" />
                ) : (
                  <Check className="h-3 w-3" />
                )}
                <span>{option.label}</span>
              </Button>
            ))}
          </div>
        </div>
      ) : (
        <div className="mt-2 flex justify-end">
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={resolving}
            className="h-6 px-2 text-[11px]"
            onClick={() =>
              void handleResolveOption({
                id: 'acknowledge',
                label: 'Acknowledge',
              })
            }
          >
            Acknowledge
          </Button>
        </div>
      )}

      {errorMsg ? (
        <div role="alert" className="mt-1 text-[11px] text-destructive">
          {errorMsg}
        </div>
      ) : null}
    </div>
  );
}

function AttentionItemRow({
  item,
  onOpen,
}: {
  item: AttentionItem;
  onOpen: (item: AttentionItem) => void;
}) {
  const { t } = useTranslation('statusbar');
  const relativeTime = useRelativeTime();
  const presentation = KIND_PRESENTATION[item.kind];
  const Icon = presentation.icon;
  const title =
    item.sessionName ?? item.agentType ?? t('attentionInbox.unnamedSession');

  return (
    <button
      type="button"
      onClick={() => onOpen(item)}
      className="flex w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted"
    >
      <Icon
        className={cn(
          'mt-0.5 h-4 w-4 shrink-0',
          presentation.tone === 'blocking'
            ? 'text-warning'
            : presentation.tone === 'error'
              ? 'text-destructive'
              : 'text-muted-foreground'
        )}
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className="truncate text-xs font-medium text-foreground">
            {title}
          </span>
          <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
            {relativeTime(item.happenedAtMs)}
          </span>
        </span>
        <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
          <span
            className={cn(
              presentation.tone === 'blocking' && 'text-warning',
              presentation.tone === 'error' && 'text-destructive'
            )}
          >
            {t(presentation.labelKey)}
          </span>
          <span className="opacity-50">·</span>
          <span className="truncate">{item.projectName}</span>
        </span>
        {item.detail ? (
          <span className="mt-0.5 block truncate text-xs text-muted-foreground/80">
            {item.detail}
          </span>
        ) : null}
      </span>
    </button>
  );
}

/**
 * Cross-project "needs me" inbox (status bar): inline Pulse user approvals &
 * ask-forms first, then pending permissions/questions, failed/interrupted
 * turns, and sessions waiting for review.
 */
export function AttentionInboxBadge() {
  const { t } = useTranslation('statusbar');
  const [open, setOpen] = useState(false);
  const [overlay, setOverlay] = useState<OverlayItem[]>([]);
  const [resolvedPulseIds, setResolvedPulseIds] = useState<Set<string>>(
    () => new Set()
  );
  const openProjectSession = useOpenProjectSession();
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: ['attention-inbox'],
    queryFn: () => attentionApi.list(),
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: true,
    meta: { suppressGlobalError: true },
  });

  const { data: pulseSnapshot } = useQuery({
    queryKey: ['pulse-deck-snapshot'],
    queryFn: () => pulseApi.deckSnapshot().catch(() => null),
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: true,
    meta: { suppressGlobalError: true },
  });

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void backendListen<SessionAttentionPayload>(
      'desktop-session-attention',
      (payload) => {
        void queryClient.invalidateQueries({ queryKey: ['attention-inbox'] });
        if (
          payload.kind === 'permission' ||
          payload.kind === 'question' ||
          payload.kind === 'error'
        ) {
          return;
        }
        const kind =
          payload.kind === 'completed'
            ? AttentionItemKind.TURN_COMPLETED
            : AttentionItemKind.SESSION_NOTICE;
        setOverlay((current) => [
          {
            overlay: true,
            kind,
            sessionId: payload.sessionId,
            workspaceId: payload.workspaceId,
            taskId: payload.sessionId,
            projectId: payload.projectId,
            projectName: '',
            sessionName: payload.title ?? null,
            agentType: null,
            detail: payload.message ?? payload.title ?? null,
            happenedAtMs: Date.now(),
          },
          ...current.filter((item) => item.sessionId !== payload.sessionId),
        ]);
      }
    ).then((dispose) => {
      if (cancelled) dispose();
      else unlisten = dispose;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [queryClient]);

  const pendingPulseInteractions = useMemo(
    () =>
      (pulseSnapshot?.pendingInteractions ?? []).filter(
        (item) =>
          !resolvedPulseIds.has(item.id) &&
          !item.resolvedAt &&
          item.status !== 'resolved'
      ),
    [pulseSnapshot?.pendingInteractions, resolvedPulseIds]
  );

  const serverItems = data?.items ?? [];
  const items = [
    ...overlay.filter(
      (extra) => !serverItems.some((item) => item.sessionId === extra.sessionId)
    ),
    ...serverItems,
  ];
  const pulseBlockingCount = pendingPulseInteractions.filter(
    (item) => item.kind === 'approval' || item.kind === 'ask_form'
  ).length;
  const blockingCount = (data?.blockingCount ?? 0) + pulseBlockingCount;
  const totalCount = items.length + pendingPulseInteractions.length;

  const handleOpen = (item: AttentionItem) => {
    setOpen(false);
    setOverlay((current) =>
      current.filter((extra) => extra.sessionId !== item.sessionId)
    );
    openProjectSession({
      projectId: item.projectId,
      workspaceId: item.workspaceId,
      sessionId: item.sessionId,
    });
  };

  const handlePulseResolved = (id: string) => {
    setResolvedPulseIds((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    void queryClient.invalidateQueries({ queryKey: ['pulse-deck-snapshot'] });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={t('attentionInbox.title')}
          data-testid="attention-inbox-trigger"
          className={cn(
            'inline-flex items-center gap-1 rounded-full px-1.5 text-[10px] tabular-nums transition-colors hover:opacity-80',
            blockingCount > 0
              ? 'text-warning'
              : totalCount > 0
                ? 'text-foreground'
                : 'text-muted-foreground'
          )}
        >
          <Inbox className="h-3 w-3" />
          {totalCount > 0 ? totalCount : null}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="top"
        className="w-96 border border-border bg-popover p-2"
        sideOffset={6}
      >
        <div className="mb-1 flex items-center justify-between px-2 pt-1">
          <span className="text-xs font-semibold text-foreground">
            {t('attentionInbox.title')}
          </span>
          {blockingCount > 0 ? (
            <span className="text-[10px] text-warning tabular-nums">
              {t('attentionInbox.blockingCount', { count: blockingCount })}
            </span>
          ) : null}
        </div>
        {totalCount === 0 ? (
          <div className="px-2 py-4 text-center text-xs text-muted-foreground">
            {t('attentionInbox.empty')}
          </div>
        ) : (
          <div className="max-h-80 overflow-y-auto">
            {pendingPulseInteractions.map((interaction) => (
              <PulseInteractionRow
                key={`pulse:${interaction.id}`}
                interaction={interaction}
                onResolved={handlePulseResolved}
              />
            ))}
            {items.map((item) => (
              <AttentionItemRow
                key={`${item.kind}:${item.sessionId}`}
                item={item}
                onOpen={handleOpen}
              />
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
