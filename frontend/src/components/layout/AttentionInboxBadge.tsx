import { useEffect, useState } from 'react';
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
import { attentionApi } from '@/lib/api/attention';
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
          <span className="shrink-0 text-[10px] text-muted-foreground">
            {relativeTime(item.happenedAtMs)}
          </span>
        </span>
        <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
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
          <span className="mt-0.5 block truncate text-[11px] text-muted-foreground/80">
            {item.detail}
          </span>
        ) : null}
      </span>
    </button>
  );
}

/**
 * Cross-project "needs me" inbox (status bar): pending permissions/questions
 * first (they block an agent right now), then failed/interrupted turns, then
 * sessions waiting for review. Clicking an item jumps straight to the session.
 */
export function AttentionInboxBadge() {
  const { t } = useTranslation('statusbar');
  const [open, setOpen] = useState(false);
  const [overlay, setOverlay] = useState<OverlayItem[]>([]);
  const openProjectSession = useOpenProjectSession();
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: ['attention-inbox'],
    queryFn: () => attentionApi.list(),
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

  const serverItems = data?.items ?? [];
  const items = [
    ...overlay.filter(
      (extra) =>
        !serverItems.some((item) => item.sessionId === extra.sessionId)
    ),
    ...serverItems,
  ];
  const blockingCount = data?.blockingCount ?? 0;

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

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={t('attentionInbox.title')}
          className={cn(
            'inline-flex items-center gap-1 rounded-full px-1.5 text-[10px] transition-colors hover:opacity-80',
            blockingCount > 0
              ? 'text-warning'
              : items.length > 0
                ? 'text-foreground'
                : 'text-muted-foreground'
          )}
        >
          <Inbox className="h-3 w-3" />
          {items.length > 0 ? items.length : null}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="top"
        className="w-96 p-2"
        sideOffset={6}
      >
        <div className="mb-1 flex items-center justify-between px-2 pt-1">
          <span className="text-xs font-semibold text-foreground">
            {t('attentionInbox.title')}
          </span>
          {blockingCount > 0 ? (
            <span className="text-[10px] text-warning">
              {t('attentionInbox.blockingCount', { count: blockingCount })}
            </span>
          ) : null}
        </div>
        {items.length === 0 ? (
          <div className="px-2 py-4 text-center text-xs text-muted-foreground">
            {t('attentionInbox.empty')}
          </div>
        ) : (
          <div className="max-h-80 overflow-y-auto">
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
