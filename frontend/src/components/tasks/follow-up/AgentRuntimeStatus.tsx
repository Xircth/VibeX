import { useEffect, useState } from 'react';
import { Info, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ConversationSessionNotice } from 'shared/types';
import { toast } from '@/components/ui/toast';
import { PixelGridLoader } from '@/components/ui/pixel-grid-loader';
import { getErrorMessage } from '@/lib/modals';
import { cn } from '@/lib/utils';
import {
  waitingAdvisory,
  isRequestTerminal,
} from '@/features/conversation/runtimeStatus';
import { parseReconnectProgressTitle } from '@/features/conversation/inlineRuntimeStatus';
import { ConversationStatusDetails } from '@/components/NormalizedConversation/conversation/ConversationStatusDetails';

type Props = {
  notice: ConversationSessionNotice;
  placement?: 'composer' | 'stream';
  titleOverride?: string | null;
  onReconnect?: () => void | Promise<unknown>;
  onCancel?: () => void | Promise<unknown>;
  onRetry?: () => void | Promise<unknown>;
};

export function AgentRuntimeStatus({
  notice,
  placement = 'composer',
  titleOverride,
  onReconnect,
  onCancel,
  onRetry,
}: Props) {
  const { t } = useTranslation('conversation');
  const [now, setNow] = useState(Date.now);
  const [actionPending, setActionPending] = useState(false);
  const runAction = async (action: () => void | Promise<unknown>) => {
    if (actionPending) return;
    setActionPending(true);
    try {
      await action();
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setActionPending(false);
    }
  };
  const connection = notice.connection_status;
  const request = notice.request_status;
  const phase = request?.activity.phase;
  const terminal = phase != null && isRequestTerminal(phase);
  const retry = request?.activity.retry;
  const connectionFailed =
    connection?.status === 'error' || connection?.status === 'closed';
  const requestFailed = phase === 'failed';
  const isError = Boolean(connectionFailed || requestFailed);

  useEffect(() => {
    if (
      (placement === 'stream' && !isError) ||
      terminal ||
      (!request &&
        (!connection ||
          connection.bound ||
          connection.status === 'error' ||
          connection.status === 'closed'))
    )
      return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [placement, isError, terminal, request, connection]);

  if (placement === 'stream' && !isError) {
    const parsedReconnect = parseReconnectProgressTitle(titleOverride);
    const attempt = retry?.attempt ?? parsedReconnect?.attempt ?? null;
    const maxAttempts =
      retry?.max_attempts ?? parsedReconnect?.maxAttempts ?? null;
    const streamLabel =
      phase === 'cancelling'
        ? t('runtime.stream.cancelling')
        : attempt != null && maxAttempts != null
          ? t('runtime.stream.connectingRetryingCount', {
              attempt,
              max: maxAttempts,
            })
          : attempt != null
            ? t('runtime.stream.connectingRetryingAttempt', { attempt })
            : phase === 'retrying' || connection?.status === 'recovering'
              ? t('runtime.stream.connectingRetrying')
              : connection ||
                  !phase ||
                  phase === 'submitting' ||
                  phase === 'waiting_agent' ||
                  phase === 'waiting_model'
                ? t('runtime.stream.connecting')
                : t(`runtime.request.${phase}`);
    return (
      <div className="conv-entry-item conv-assistant-msg px-4 py-2 text-sm">
        <div
          className="conv-thinking-placeholder"
          role="status"
          aria-live="polite"
          data-testid={
            connection ? 'agent-connection-status' : 'agent-request-status'
          }
          data-placement={placement}
        >
          <PixelGridLoader size="sm" />
          <span className="conv-shimmer-text tabular-nums">{streamLabel}</span>
        </div>
      </div>
    );
  }

  const since = request?.since ?? connection?.since;
  const parsedSince = since ? Date.parse(since) : Number.NaN;
  const hasValidSince = Number.isFinite(parsedSince);
  const elapsed = hasValidSince
    ? Math.max(0, Math.floor((now - parsedSince) / 1000))
    : null;
  const connectionKey = connection?.bound
    ? 'ready'
    : connection?.status === 'ready'
      ? 'binding'
      : connection?.status;
  const title =
    titleOverride?.trim() ||
    (connection
      ? t(`runtime.connection.${connectionKey}`)
      : t(`runtime.request.${phase ?? 'waiting_agent'}`));
  const advisory =
    request && phase && since ? waitingAdvisory(phase, since, now) : null;
  const message = connection?.message ?? retry?.reason ?? notice.message;
  const waitingConnection =
    Boolean(connection && !connection.bound && !connectionFailed);
  const isActive =
    Boolean(request && !terminal) || waitingConnection;

  const content = (
    <div
      className={cn(
        placement === 'stream'
          ? cn(
              'rounded-lg border px-3 py-2 text-xs text-muted-foreground transition-colors',
              isError
                ? 'border-destructive/30 bg-destructive/5'
                : 'border-border/60 bg-muted/35'
            )
          : 'composer-status-row text-xs text-muted-foreground'
      )}
      data-testid={
        connection ? 'agent-connection-status' : 'agent-request-status'
      }
      data-placement={placement}
    >
      <div className="flex flex-wrap items-center gap-2">
        {isActive ? (
          <PixelGridLoader size="sm" />
        ) : isError ? (
          <TriangleAlert
            className="h-3.5 w-3.5 shrink-0 text-destructive"
            aria-hidden="true"
          />
        ) : placement === 'stream' ? (
          <Info
            className="h-3.5 w-3.5 shrink-0 text-muted-foreground/80"
            aria-hidden="true"
          />
        ) : null}
        <span
          role="status"
          className={cn(
            isError ? 'font-medium text-destructive' : 'font-medium text-foreground/90'
          )}
        >
          {title}
        </span>
        {elapsed !== null &&
        !terminal &&
        (!connection || waitingConnection) ? (
          <span
            className="tabular-nums text-muted-foreground/80"
            aria-label={t('runtime.elapsed')}
          >
            {elapsed}s
          </span>
        ) : null}
        {retry?.attempt != null ? (
          <span className="tabular-nums">
            {t('runtime.attempt', { count: retry.attempt })}
            {retry.max_attempts != null ? ` / ${retry.max_attempts}` : ''}
          </span>
        ) : null}
        {retry?.delay_ms != null && hasValidSince ? (
          <span className="tabular-nums">
            {t('runtime.backoff', {
              seconds: Math.max(
                0,
                Math.ceil((Number(retry.delay_ms) - (now - parsedSince)) / 1000)
              ),
            })}
          </span>
        ) : null}
        <div
          className={cn(
            'flex items-center gap-1.5',
            placement === 'stream' ? 'ml-auto' : 'composer-status-action-slot ml-auto'
          )}
        >
          {connectionFailed && onReconnect ? (
            <button
              type="button"
              className="composer-status-action"
              disabled={actionPending}
              onClick={() => void runAction(onReconnect)}
            >
              {t('runtime.reconnect')}
            </button>
          ) : null}
          {((request && !terminal && phase !== 'cancelling') ||
            waitingConnection) &&
          onCancel ? (
            <button
              type="button"
              className="composer-status-action"
              disabled={actionPending}
              onClick={() => void runAction(onCancel)}
            >
              {t('runtime.cancel')}
            </button>
          ) : null}
          {request &&
          (phase === 'failed' ||
            phase === 'interrupted' ||
            phase === 'cancelled') &&
          onRetry ? (
            <button
              type="button"
              className="composer-status-action"
              disabled={actionPending}
              onClick={() => void runAction(onRetry)}
            >
              {t('runtime.retry')}
            </button>
          ) : null}
        </div>
      </div>
      {advisory != null ? (
        <p className="mt-1">{t('runtime.longWait')}</p>
      ) : null}
      {waitingConnection && elapsed !== null && elapsed >= 30 ? (
        <p className="mt-1">{t('runtime.connectionWait')}</p>
      ) : null}
      {message || retry?.code ? (
        <ConversationStatusDetails
          title={title}
          label={t('statusDock.showDetails')}
        >
          <p className="whitespace-pre-wrap break-words">
            {message}
            {retry?.code ? ` (${retry.code})` : ''}
          </p>
          <button
            type="button"
            className="composer-status-action"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(
                  [message, retry?.code].filter(Boolean).join(' ')
                );
              } catch {
                toast.error(t('runtime.copyFailed'));
              }
            }}
          >
            {t('runtime.copyError')}
          </button>
        </ConversationStatusDetails>
      ) : null}
    </div>
  );

  if (placement === 'stream') {
    return <div className="conv-entry-item px-4 py-1.5">{content}</div>;
  }

  return content;
}
