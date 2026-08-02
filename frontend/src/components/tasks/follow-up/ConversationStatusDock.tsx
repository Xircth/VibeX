import { useState } from 'react';
import { Info, RotateCcw, TriangleAlert, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ConversationStatusNotice } from '@/contexts/ConversationStatusContext';
import { TurnErrorCard } from '@/components/NormalizedConversation/conversation/TurnErrorCard';
import { getConversationSessionNoticeCopy } from '@/features/conversation/sessionNoticeCopy';
import type { ConversationSessionNotice } from 'shared/types';

const DISMISSED_NOTICE_KEY_PREFIX = 'vibex:dismissed-conversation-notice';

function dismissalStorageKey(
  scope: string | null | undefined,
  noticeId: string
): string | null {
  return scope ? `${DISMISSED_NOTICE_KEY_PREFIX}:${scope}:${noticeId}` : null;
}

function wasNoticeDismissed(
  scope: string | null | undefined,
  noticeId: string,
  notice: ConversationSessionNotice
): boolean {
  const key = dismissalStorageKey(scope, noticeId);
  if (!key || typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(key) === noticeSignature(notice);
  } catch {
    return false;
  }
}

function noticeSignature(notice: ConversationSessionNotice): string {
  return JSON.stringify([notice.title, notice.message, notice.severity]);
}

function noticeDismissalIdentity(
  noticeId: string,
  notice: ConversationSessionNotice
): string {
  return `${noticeId}:${noticeSignature(notice)}`;
}

type ConversationStatusDockProps = {
  notices: ConversationStatusNotice[];
  localError?: string | null;
  dismissalScope?: string | null;
};

export function ConversationStatusDock({
  notices,
  localError,
  dismissalScope,
}: ConversationStatusDockProps) {
  const { t } = useTranslation(['conversation']);
  const [dismissedNotices, setDismissedNotices] = useState<Set<string>>(
    () => new Set()
  );
  const visibleNotices = notices.filter(
    (notice) =>
      notice.kind !== 'session-notice' ||
      (!dismissedNotices.has(
        noticeDismissalIdentity(notice.id, notice.notice)
      ) &&
        !wasNoticeDismissed(dismissalScope, notice.id, notice.notice))
  );

  if (visibleNotices.length === 0 && !localError) return null;

  return (
    <div
      className="conversation-status-dock mx-3 mt-2 shrink-0"
      data-testid="conversation-status-dock"
      aria-live="polite"
    >
      <div className="composer-status-surface overflow-hidden rounded-[10px]">
        {localError ? (
          <StatusSurface tone="error" role="alert" icon={<TriangleAlert />}>
            <p className="break-words">{localError}</p>
          </StatusSurface>
        ) : null}

        {visibleNotices.map((notice) => {
          if (notice.kind === 'turn-error') {
            return (
              <TurnErrorCard
                key={notice.id}
                error={notice.error}
                onReload={notice.onReload}
                placement="composer"
              />
            );
          }

          if (notice.kind === 'interrupted-turn') {
            return (
              <StatusSurface
                key={notice.id}
                tone="warning"
                role="status"
                icon={<RotateCcw />}
                action={
                  notice.onResend ? (
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
                  ) : null
                }
              >
                <div className="min-w-0">
                  <p className="font-medium text-foreground">
                    {t('messageTurnView.interruptedTitle')}
                  </p>
                  <p className="mt-1 break-words text-muted-foreground">
                    {t('messageTurnView.interruptedDescription')}
                  </p>
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
                <button
                  type="button"
                  className="composer-status-dismiss"
                  onClick={() =>
                    setDismissedNotices((current) => {
                      const next = new Set(current);
                      next.add(
                        noticeDismissalIdentity(notice.id, notice.notice)
                      );
                      const storageKey = dismissalStorageKey(
                        dismissalScope,
                        notice.id
                      );
                      if (storageKey) {
                        try {
                          window.localStorage.setItem(
                            storageKey,
                            noticeSignature(notice.notice)
                          );
                        } catch {
                          // Dismissal still works for this mount when storage is unavailable.
                        }
                      }
                      return next;
                    })
                  }
                  title={t('statusDock.dismiss')}
                  aria-label={t('statusDock.dismiss')}
                >
                  <X className="h-4 w-4" />
                </button>
              }
            >
              <div className="min-w-0">
                <p className="font-medium text-foreground">{copy.title}</p>
                {copy.message ? (
                  <p className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">
                    {copy.message}
                  </p>
                ) : null}
              </div>
            </StatusSurface>
          );
        })}
      </div>
    </div>
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
      className="composer-status-row grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2 px-3 py-2 text-xs"
      data-tone={tone}
      role={role}
    >
      <span className="composer-status-icon mt-0.5 shrink-0">{icon}</span>
      {children}
      {action ? (
        <div className="composer-status-action-slot self-center">{action}</div>
      ) : null}
    </div>
  );
}
