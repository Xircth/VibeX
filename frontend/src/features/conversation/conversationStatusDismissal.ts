import { useCallback, useState } from 'react';
import type { ConversationStatusNotice } from '@/contexts/ConversationStatusContext';

const DISMISSED_NOTICE_KEY_PREFIX = 'vibex:dismissed-conversation-notice';

function dismissalStorageKey(
  scope: string | null | undefined,
  noticeId: string
): string | null {
  return scope ? `${DISMISSED_NOTICE_KEY_PREFIX}:${scope}:${noticeId}` : null;
}

export function conversationStatusSignature(
  notice: ConversationStatusNotice
): string {
  switch (notice.kind) {
    case 'turn-error':
      return JSON.stringify([
        notice.error.message,
        notice.error.code,
        notice.error.raw,
      ]);
    case 'interrupted-turn':
      return 'interrupted-turn';
    case 'session-notice':
      return JSON.stringify([
        notice.notice.title,
        notice.notice.message,
        notice.notice.severity,
      ]);
  }
}

export function conversationStatusIdentity(
  notice: ConversationStatusNotice,
  scope?: string | null
): string {
  return `${scope ?? ''}:${notice.id}:${conversationStatusSignature(notice)}`;
}

export function wasConversationStatusDismissed(
  scope: string | null | undefined,
  notice: ConversationStatusNotice
): boolean {
  const key = dismissalStorageKey(scope, notice.id);
  if (!key || typeof window === 'undefined') return false;
  try {
    return (
      window.localStorage.getItem(key) === conversationStatusSignature(notice)
    );
  } catch {
    return false;
  }
}

export function persistConversationStatusDismissal(
  scope: string | null | undefined,
  notice: ConversationStatusNotice
): void {
  const key = dismissalStorageKey(scope, notice.id);
  if (!key || typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, conversationStatusSignature(notice));
  } catch {
    // The caller still hides the notice for this mount when storage is unavailable.
  }
}

export function useConversationStatusDismissal(scope?: string | null) {
  const [dismissedStatuses, setDismissedStatuses] = useState<Set<string>>(
    () => new Set()
  );
  const isDismissed = useCallback(
    (notice: ConversationStatusNotice) =>
      dismissedStatuses.has(conversationStatusIdentity(notice, scope)) ||
      wasConversationStatusDismissed(scope, notice),
    [dismissedStatuses, scope]
  );
  const dismiss = useCallback(
    (notice: ConversationStatusNotice) => {
      setDismissedStatuses((current) => {
        const next = new Set(current);
        next.add(conversationStatusIdentity(notice, scope));
        return next;
      });
      persistConversationStatusDismissal(scope, notice);
    },
    [scope]
  );
  return { dismiss, isDismissed };
}
