import { Badge } from '@astryxdesign/core/Badge';
import { RefreshCw, RotateCcw, X } from 'lucide-react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConversationStatusNotice } from '@/contexts/ConversationStatusContext';
import { TurnErrorCard } from '@/components/NormalizedConversation/conversation/TurnErrorCard';
import {
  ConversationStatusDetailsContent,
  ConversationStatusDetailsTrigger,
} from '@/components/NormalizedConversation/conversation/ConversationStatusDetails';
import { getConversationSessionNoticeCopy } from '@/features/conversation/sessionNoticeCopy';
import {
  rememberVisibleSessionAnnouncements,
  useConversationStatusDismissal,
} from '@/features/conversation/conversationStatusDismissal';
import { sessionNoticeNeedsRebind } from '@/features/conversation/sessionNoticeNeedsRebind';
import { AgentRuntimeStatus } from './AgentRuntimeStatus';
import { SessionNoticeActions } from './SessionNoticeActions';

type ConversationStatusDockProps = {
  notices: ConversationStatusNotice[];
  localError?: string | null;
  onDismissLocalError?: () => void;
  dismissalScope?: string | null;
  placement?: 'composer' | 'panel';
  extra?: ReactNode;
};

export function ConversationStatusDock({
  notices,
  localError,
  onDismissLocalError,
  dismissalScope,
  placement = 'composer',
  extra,
}: ConversationStatusDockProps) {
  const { t } = useTranslation(['conversation']);
  const { dismiss: dismissNotice, isDismissed } =
    useConversationStatusDismissal(dismissalScope);
  const visibleNotices = notices.filter(
    (notice) =>
      (notice.kind === 'session-notice' &&
        (notice.notice.connection_status || notice.notice.request_status)) ||
      !isDismissed(notice)
  );
  const blockingNotice = visibleNotices.some(
    (notice) =>
      notice.kind === 'turn-error' ||
      Boolean(
        notice.kind === 'session-notice' &&
          (notice.notice.connection_status ||
            notice.onReload ||
            notice.onRebind ||
            notice.onNewConversation)
      )
  );

  useEffect(() => {
    rememberVisibleSessionAnnouncements(dismissalScope, visibleNotices);
  }, [dismissalScope, visibleNotices]);

  if (visibleNotices.length === 0 && !localError && extra == null) return null;

  return (
    <div
      className={
        placement === 'panel'
          ? 'conversation-status-dock conversation-status-dock--panel'
          : 'conversation-status-dock'
      }
      data-testid="conversation-status-dock"
      data-placement={placement}
      data-expanded={blockingNotice ? 'true' : undefined}
      aria-live="polite"
    >
      <div className="composer-status-surface rounded-[var(--radius-composer,0.75rem)]">
        {extra}
        {localError ? (
          <StatusSurface
            tone="error"
            role="alert"
            title={t('statusDock.localErrorTitle')}
            badgeLabel={t('statusDock.errorBadge')}
            detailsLabel={t('statusDock.showDetails')}
            detailsAccessibleLabel={t('statusDock.showDetailsFor', {
              title: t('statusDock.localErrorTitle'),
            })}
            detailsKey={localError}
            detailsMono
            detailsContent={
              <p className="whitespace-pre-wrap break-words">{localError}</p>
            }
            action={
              onDismissLocalError ? (
                <DismissButton
                  label={t('statusDock.dismissLocalError')}
                  onClick={onDismissLocalError}
                />
              ) : null
            }
          />
        ) : null}

        {visibleNotices.map((notice) => {
          if (notice.kind === 'turn-error') {
            return (
              <TurnErrorCard
                key={notice.id}
                error={notice.error}
                onReload={notice.onReload}
                onRebind={notice.onRebind}
                onRetry={notice.onRetry}
                onDismiss={() => dismissNotice(notice)}
                dismissLabel={`${t('statusDock.dismiss')} ${notice.id}`}
                placement="composer"
              />
            );
          }

          if (notice.kind === 'interrupted-turn') {
            const title = t('messageTurnView.interruptedTitle');
            const detailText = t('messageTurnView.interruptedDescription');
            return (
              <StatusSurface
                key={notice.id}
                tone="warning"
                role="status"
                title={title}
                badgeLabel={t('statusDock.warningBadge')}
                detailsLabel={t('statusDock.showDetails')}
                detailsAccessibleLabel={t('statusDock.showDetailsFor', {
                  title,
                })}
                detailsKey={detailText}
                detailsContent={<p className="break-words">{detailText}</p>}
                action={
                  <div className="flex items-center gap-1">
                    {notice.onResend ? (
                      <button
                        type="button"
                        className="composer-status-action"
                        onClick={notice.onResend}
                        title={t('messageTurnView.resendHint')}
                        aria-label={t('messageTurnView.resend')}
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                        {t('messageTurnView.resend')}
                      </button>
                    ) : null}
                    <DismissButton
                      label={`${t('statusDock.dismiss')} ${notice.id}`}
                      onClick={() => dismissNotice(notice)}
                    />
                  </div>
                }
              />
            );
          }

          if (notice.notice.connection_status || notice.notice.request_status) {
            return (
              <AgentRuntimeStatus
                key={notice.id}
                notice={notice.notice}
                titleOverride={notice.titleOverride}
                onReconnect={notice.onReload}
                onCancel={notice.onCancel}
                onRetry={notice.onRetry}
              />
            );
          }
          const tone =
            notice.notice.severity === 'error'
              ? 'error'
              : notice.notice.severity === 'warning'
                ? 'warning'
                : 'info';
          const copy = getConversationSessionNoticeCopy(notice.notice, t);
          return (
            <StatusSurface
              key={notice.id}
              tone={tone}
              role={tone === 'error' ? 'alert' : 'status'}
              title={copy.title}
              badgeLabel={t(`statusDock.${tone}Badge`)}
              detailsLabel={t('statusDock.showDetails')}
              detailsAccessibleLabel={t('statusDock.showDetailsFor', {
                title: copy.title,
              })}
              detailsKey={copy.message ?? ''}
              detailsMono={tone !== 'info'}
              detailsContent={
                copy.message ? (
                  <p className="whitespace-pre-wrap break-words">
                    {copy.message}
                  </p>
                ) : null
              }
              action={
                <div className="flex items-center gap-1">
                  {notice.notice.action ? (
                    <SessionNoticeActions action={notice.notice.action} />
                  ) : null}
                  {notice.kind === 'session-notice' && notice.onReload ? (
                    <button
                      type="button"
                      className="composer-status-action"
                      onClick={() => void notice.onReload?.()}
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      {t('turnErrorCard.reloadSession')}
                    </button>
                  ) : null}
                  {notice.kind === 'session-notice' &&
                  notice.onNewConversation ? (
                    <button
                      type="button"
                      className="composer-status-action"
                      onClick={() => void notice.onNewConversation?.()}
                    >
                      {t('turnErrorCard.newConversation')}
                    </button>
                  ) : null}
                  {notice.onRebind &&
                  sessionNoticeNeedsRebind(notice.notice, notice.id) ? (
                    <button
                      type="button"
                      className="composer-status-action"
                      onClick={() => void notice.onRebind?.()}
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      {t('turnErrorCard.rebindSession')}
                    </button>
                  ) : null}
                  <DismissButton
                    label={t('statusDock.dismiss')}
                    onClick={() => dismissNotice(notice)}
                  />
                </div>
              }
            />
          );
        })}
      </div>
    </div>
  );
}

function DismissButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="composer-status-dismiss focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      onClick={onClick}
      title={label}
      aria-label={label}
    >
      <X className="h-4 w-4" />
    </button>
  );
}

function StatusSurface({
  tone,
  role,
  title,
  badgeLabel,
  action,
  detailsLabel,
  detailsAccessibleLabel,
  detailsKey,
  detailsMono = false,
  detailsContent,
}: {
  tone: 'error' | 'warning' | 'info';
  role: 'alert' | 'status';
  title: string;
  badgeLabel: string;
  action?: React.ReactNode;
  detailsLabel?: string;
  detailsAccessibleLabel?: string;
  detailsKey?: string;
  detailsMono?: boolean;
  detailsContent?: React.ReactNode;
}) {
  const detailsId = useId();
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    setExpanded(false);
  }, [detailsKey]);

  const hasDetails = Boolean(detailsContent && detailsLabel);

  return (
    <div className="composer-status-row text-xs" data-tone={tone} role={role}>
      <div className="composer-status-header">
        <div className="composer-status-heading">
          <p className="composer-status-title text-foreground">{title}</p>
          <Badge
            className="composer-status-badge"
            variant={tone}
            label={badgeLabel}
          />
        </div>
        {hasDetails || action ? (
          <div className="composer-status-action-slot">
            {hasDetails ? (
              <ConversationStatusDetailsTrigger
                title={title}
                label={detailsLabel!}
                accessibleLabel={detailsAccessibleLabel}
                expanded={expanded}
                controlsId={detailsId}
                onToggle={() => setExpanded((current) => !current)}
              />
            ) : null}
            {action}
          </div>
        ) : null}
      </div>
      {hasDetails && expanded ? (
        <ConversationStatusDetailsContent id={detailsId} mono={detailsMono}>
          {detailsContent}
        </ConversationStatusDetailsContent>
      ) : null}
    </div>
  );
}
