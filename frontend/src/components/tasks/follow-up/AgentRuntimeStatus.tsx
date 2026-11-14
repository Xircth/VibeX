import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConversationSessionNotice } from 'shared/types';
import { toast } from '@/components/ui/toast';
import { getErrorMessage } from '@/lib/modals';
import {
  waitingAdvisory,
  isRequestTerminal,
} from '@/features/conversation/runtimeStatus';
import { ConversationStatusDetails } from '@/components/NormalizedConversation/conversation/ConversationStatusDetails';

type Props = {
  notice: ConversationSessionNotice;
  onReconnect?: () => void | Promise<unknown>;
  onCancel?: () => void | Promise<unknown>;
  onRetry?: () => void | Promise<unknown>;
};

export function AgentRuntimeStatus({
  notice,
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
  useEffect(() => {
    if (
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
  }, [terminal, request, connection]);
  const since = request?.since ?? connection?.since;
  const elapsed = since
    ? Math.max(0, Math.floor((now - Date.parse(since)) / 1000))
    : 0;
  const retry = request?.activity.retry;
  const connectionFailed =
    connection?.status === 'error' || connection?.status === 'closed';
  const connectionKey = connection?.bound
    ? 'ready'
    : connection?.status === 'ready'
      ? 'binding'
      : connection?.status;
  const title = connection
    ? t(`runtime.connection.${connectionKey}`)
    : t(`runtime.request.${phase ?? 'waiting_agent'}`);
  const advisory =
    request && phase ? waitingAdvisory(phase, request.since, now) : null;
  const message = connection?.message ?? retry?.reason;
  const waitingConnection =
    connection && !connection.bound && !connectionFailed;
  return (
    <div
      className="px-3 py-2 text-xs text-muted-foreground"
      data-testid={
        connection ? 'agent-connection-status' : 'agent-request-status'
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          role="status"
          className={connectionFailed ? 'text-destructive' : undefined}
        >
          {title}
        </span>
        {!terminal &&
        (!connection || waitingConnection) &&
        Number.isFinite(elapsed) ? (
          <span className="tabular-nums" aria-label={t('runtime.elapsed')}>
            {elapsed}s
          </span>
        ) : null}
        {retry?.attempt != null ? (
          <span className="tabular-nums">
            {t('runtime.attempt', { count: retry.attempt })}
            {retry.max_attempts != null ? ` / ${retry.max_attempts}` : ''}
          </span>
        ) : null}
        {retry?.delay_ms != null ? (
          <span className="tabular-nums">
            {t('runtime.backoff', {
              seconds: Math.max(
                0,
                Math.ceil(
                  (Number(retry.delay_ms) -
                    (now - Date.parse(request!.since))) /
                    1000
                )
              ),
            })}
          </span>
        ) : null}
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
      {advisory != null ? (
        <p className="mt-1">{t('runtime.longWait')}</p>
      ) : null}
      {waitingConnection && elapsed >= 30 ? (
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
}
