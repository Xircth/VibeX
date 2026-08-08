import { Info, RotateCcw, TriangleAlert, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ConversationStatusNotice } from '@/contexts/ConversationStatusContext';
import { TurnErrorCard } from '@/components/NormalizedConversation/conversation/TurnErrorCard';
import { ConversationStatusDetails } from '@/components/NormalizedConversation/conversation/ConversationStatusDetails';
import { getConversationSessionNoticeCopy } from '@/features/conversation/sessionNoticeCopy';
import { useConversationStatusDismissal } from '@/features/conversation/conversationStatusDismissal';

type ConversationStatusDockProps = {
  notices: ConversationStatusNotice[];
  localError?: string | null;
  onDismissLocalError?: () => void;
  dismissalScope?: string | null;
};

export function ConversationStatusDock({
  notices,
  localError,
  onDismissLocalError,
  dismissalScope,
}: ConversationStatusDockProps) {
  const { t } = useTranslation(['conversation']);
  const { dismiss: dismissNotice, isDismissed } =
    useConversationStatusDismissal(dismissalScope);
  const visibleNotices = notices.filter((notice) => !isDismissed(notice));

  if (visibleNotices.length === 0 && !localError) return null;

  return (
    <div
      className="conversation-status-dock mx-3 mt-2 shrink-0"
      data-testid="conversation-status-dock"
      aria-live="polite"
    >
      <div className="composer-status-surface overflow-hidden rounded-lg">
        {localError ? (
          <StatusSurface
            tone="error"
            role="alert"
            icon={<TriangleAlert />}
            action={
              onDismissLocalError ? (
                <DismissButton
                  label={t('statusDock.dismissLocalError')}
                  onClick={onDismissLocalError}
                />
              ) : null
            }
          >
            <div className="min-w-0">
              <p className="composer-status-title text-foreground">
                {t('statusDock.localErrorTitle')}
              </p>
              <ConversationStatusDetails
                key={localError}
                title={t('statusDock.localErrorTitle')}
                label={t('statusDock.showDetails')}
                accessibleLabel={t('statusDock.showDetailsFor', {
                  title: t('statusDock.localErrorTitle'),
                })}
                mono
              >
                <p className="whitespace-pre-wrap break-words">{localError}</p>
              </ConversationStatusDetails>
            </div>
          </StatusSurface>
        ) : null}

        {visibleNotices.map((notice) => {
          if (notice.kind === 'turn-error') {
            return (
              <TurnErrorCard
                key={notice.id}
                error={notice.error}
                onReload={notice.onReload}
                onDismiss={() => dismissNotice(notice)}
                dismissLabel={`${t('statusDock.dismiss')} ${notice.id}`}
                placement="composer"
              />
            );
          }

          if (notice.kind === 'interrupted-turn') {
            const title = t('messageTurnView.interruptedTitle');
            return (
              <StatusSurface
                key={notice.id}
                tone="warning"
                role="status"
                icon={<RotateCcw />}
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
              >
                <div className="min-w-0">
                  <p className="composer-status-title text-foreground">
                    {title}
                  </p>
                  <ConversationStatusDetails
                    key={t('messageTurnView.interruptedDescription')}
                    title={title}
                    label={t('statusDock.showDetails')}
                    accessibleLabel={t('statusDock.showDetailsFor', { title })}
                  >
                    <p className="break-words">
                      {t('messageTurnView.interruptedDescription')}
                    </p>
                  </ConversationStatusDetails>
                </div>
              </StatusSurface>
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
              icon={tone === 'info' ? <Info /> : <TriangleAlert />}
              action={
                <DismissButton
                  label={t('statusDock.dismiss')}
                  onClick={() => dismissNotice(notice)}
                />
              }
            >
              <div className="min-w-0">
                <p className="composer-status-title text-foreground">
                  {copy.title}
                </p>
                {copy.message ? (
                  <ConversationStatusDetails
                    key={copy.message}
                    title={copy.title}
                    label={t('statusDock.showDetails')}
                    accessibleLabel={t('statusDock.showDetailsFor', {
                      title: copy.title,
                    })}
                    mono={tone !== 'info'}
                  >
                    <p className="whitespace-pre-wrap break-words">
                      {copy.message}
                    </p>
                  </ConversationStatusDetails>
                ) : null}
              </div>
            </StatusSurface>
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
  icon,
  action,
  children,
}: {
  tone: 'error' | 'warning' | 'info';
  role: 'alert' | 'status';
  icon: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      className="composer-status-row grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2 text-xs"
      data-tone={tone}
      role={role}
    >
      <span className="composer-status-icon shrink-0">{icon}</span>
      {children}
      {action ? (
        <div className="composer-status-action-slot self-start">{action}</div>
      ) : null}
    </div>
  );
}
