import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  CircleAlert,
  Eye,
  Inbox,
  MessageCircleQuestion,
  ShieldQuestion,
  XCircle,
  ZapOff,
  type LucideIcon,
} from 'lucide-react';
import { AttentionItemKind, type AttentionItem } from 'shared/types';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  PulseInteractionCard,
  type PulseInteractionLabels,
} from '@/components/kanban/PulseInteractionForm';
import { attentionApi } from '@/lib/api/attention';
import { useOpenProjectSession } from '@/hooks/useOpenProjectSession';
import { usePulseDeckSnapshot } from '@/hooks/usePulseDeckSnapshot';
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
    if (diffMs < 60_000) {
      return t('attentionInbox.justNow', { defaultValue: 'just now' });
    }
    const minutes = Math.floor(diffMs / 60_000);
    if (minutes < 60) {
      return t('attentionInbox.minutesAgo', {
        count: minutes,
        defaultValue: `${minutes} min ago`,
      });
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
      return t('attentionInbox.hoursAgo', {
        count: hours,
        defaultValue: `${hours} h ago`,
      });
    }
    const days = Math.floor(hours / 24);
    return t('attentionInbox.daysAgo', {
      count: days,
      defaultValue: `${days} d ago`,
    });
  };
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
    item.sessionName ??
    item.agentType ??
    t('attentionInbox.unnamedSession', { defaultValue: 'Untitled session' });

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
 * typed ask-forms first, then pending permissions/questions, failed/interrupted
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

  const { snapshot: pulseSnapshot, invalidateSnapshot } =
    usePulseDeckSnapshot();

  useEffect(() => {
    const pendingList = pulseSnapshot?.pendingInteractions;
    if (!pendingList) return;
    const activePendingIds = new Set(
      pendingList
        .filter((item) => !item.resolvedAt && item.status !== 'resolved')
        .map((item) => item.id)
    );
    setResolvedPulseIds((prev) => {
      if (prev.size === 0) return prev;
      let changed = false;
      const next = new Set<string>();
      prev.forEach((id) => {
        if (activePendingIds.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [pulseSnapshot?.pendingInteractions]);

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

  const pulseLabels = useMemo<PulseInteractionLabels>(
    () => ({
      approve: t('attentionInbox.pulseApprove', { defaultValue: 'Approve' }),
      reject: t('attentionInbox.pulseReject', { defaultValue: 'Reject' }),
      acknowledge: t('attentionInbox.pulseAcknowledge', {
        defaultValue: 'Acknowledge',
      }),
      submit: t('attentionInbox.pulseSubmit', { defaultValue: 'Submit' }),
      decisionNoteAria: t('attentionInbox.pulseDecisionNote', {
        defaultValue: 'Decision note',
      }),
      decisionNotePlaceholder: t('attentionInbox.pulseOptionalNote', {
        defaultValue: 'Optional note…',
      }),
      noteRequiredError: t('attentionInbox.pulseNoteRequired', {
        defaultValue: 'Note is required for this decision.',
      }),
      selectPlaceholder: t('attentionInbox.pulseSelectPlaceholder', {
        defaultValue: 'Select…',
      }),
    }),
    [t]
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
    void invalidateSnapshot();
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={t('attentionInbox.title', {
            defaultValue: 'Needs your attention',
          })}
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
            {t('attentionInbox.title', {
              defaultValue: 'Needs your attention',
            })}
          </span>
          {blockingCount > 0 ? (
            <span className="text-[10px] text-warning tabular-nums">
              {t('attentionInbox.blockingCount', {
                count: blockingCount,
                defaultValue: `${blockingCount} blocking an agent`,
              })}
            </span>
          ) : null}
        </div>
        {totalCount === 0 ? (
          <div className="px-2 py-4 text-center text-xs text-muted-foreground">
            {t('attentionInbox.empty', {
              defaultValue: 'Nothing needs your attention right now',
            })}
          </div>
        ) : (
          <div className="max-h-80 overflow-y-auto">
            {pendingPulseInteractions.map((interaction) => (
              <PulseInteractionCard
                key={`pulse:${interaction.id}`}
                interaction={interaction}
                onResolved={handlePulseResolved}
                labels={pulseLabels}
                className="mb-1.5"
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
