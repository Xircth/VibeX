import { Suspense, lazy, useContext, useState } from 'react';
import {
  QueryClient,
  QueryClientContext,
  useQuery,
} from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Activity, AlertTriangle } from 'lucide-react';

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { requestOpenPulseDeck } from '@/components/kanban/pulseDeckEvents';
import { usePulseDeckSnapshot } from '@/hooks/usePulseDeckSnapshot';
import { automationApi } from '@/lib/api/automations';

const LazyPulseDeckView = lazy(() =>
  import('@/components/kanban/PulseDeckView').then((module) => ({
    default: module.PulseDeckView,
  }))
);

const FAILURE_POLL_MS = 60_000;

/**
 * Status-bar badge surfacing unseen automation failures and pending Pulse
 * Observe candidates. Clicking the Observe badge opens Pulse Deck directly in
 * Kanban (or opens an inline Tahoe Pulse Deck popover when in workspace stage).
 */
export function AutomationFailureBadge() {
  const { t } = useTranslation('statusbar');
  const [observePopoverOpen, setObservePopoverOpen] = useState(false);

  const contextQueryClient = useContext(QueryClientContext);
  const [standaloneClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
      })
  );
  const effectiveClient = contextQueryClient ?? standaloneClient;
  const hasSharedProvider = Boolean(contextQueryClient);

  const { data: failureCount = 0 } = useQuery<number>(
    {
      queryKey: ['automation-unseen-failures'],
      queryFn: () => automationApi.unseenFailures().catch(() => 0),
      staleTime: hasSharedProvider ? 15_000 : 0,
      refetchInterval: hasSharedProvider ? FAILURE_POLL_MS : false,
      refetchIntervalInBackground: false,
      retry: false,
      meta: { suppressGlobalError: true },
    },
    effectiveClient
  );

  const { snapshot } = usePulseDeckSnapshot();
  const observeCount = Array.isArray(snapshot?.observedCandidates)
    ? snapshot.observedCandidates.filter((candidate) => !candidate.promoted)
        .length
    : 0;

  const [markedSeen, setMarkedSeen] = useState(false);
  const effectiveFailureCount = markedSeen ? 0 : failureCount;

  if (effectiveFailureCount <= 0 && observeCount <= 0 && !observePopoverOpen) {
    return null;
  }

  const observeTitle = t('pulseObserveTitle', {
    count: observeCount,
  });
  const failureTitle = t('automationFailureTitle');

  return (
    <span className="inline-flex items-center gap-1">
      {observeCount > 0 || observePopoverOpen ? (
        <Popover open={observePopoverOpen} onOpenChange={setObservePopoverOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              title={observeTitle}
              aria-label={observeTitle}
              data-testid="pulse-observe-status-badge"
              className="inline-flex items-center gap-1 rounded-full px-1.5 text-[10px] text-muted-foreground tabular-nums transition-colors hover:text-foreground"
              onClick={(event) => {
                event.preventDefault();
                if (observePopoverOpen) {
                  setObservePopoverOpen(false);
                  return;
                }
                const handledByStage = requestOpenPulseDeck();
                if (!handledByStage) {
                  setObservePopoverOpen(true);
                }
              }}
            >
              <Activity className="h-3 w-3 text-primary" />
              <span>{observeCount}</span>
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            side="top"
            sideOffset={6}
            className="h-[520px] w-[640px] max-w-[92vw] overflow-hidden border border-border bg-popover p-0 shadow-md"
            data-testid="pulse-observe-inline-popover"
          >
            <Suspense fallback={null}>
              <LazyPulseDeckView className="h-full" />
            </Suspense>
          </PopoverContent>
        </Popover>
      ) : null}
      {effectiveFailureCount > 0 ? (
        <button
          type="button"
          title={failureTitle}
          aria-label={failureTitle}
          data-testid="automation-failure-status-badge"
          className="inline-flex items-center gap-1 rounded-full px-1.5 text-[10px] text-destructive tabular-nums hover:opacity-80"
          onClick={() => {
            setMarkedSeen(true);
            void automationApi.markSeen().finally(() => {
              void effectiveClient.invalidateQueries({
                queryKey: ['automation-unseen-failures'],
              });
            });
            requestOpenPulseDeck({ navigateToKanban: true });
          }}
        >
          <AlertTriangle className="h-3 w-3" />
          {effectiveFailureCount}
        </button>
      ) : null}
    </span>
  );
}
