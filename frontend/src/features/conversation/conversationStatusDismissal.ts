import { useCallback, useState } from 'react';
import type { ConversationStatusNotice } from '@/contexts/ConversationStatusContext';

const DISMISSED_NOTICE_KEY_PREFIX = 'vibex:dismissed-conversation-notice';
const SEEN_ANNOUNCEMENTS_KEY = 'vibex:seen-session-announcements';
const DISMISSED_ANNOUNCEMENTS_KEY = 'vibex:dismissed-session-announcements';

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

export function announcementIdOf(
  notice: ConversationStatusNotice
): string | null {
  if (notice.kind !== 'session-notice') return null;
  const id = notice.notice.announcement_id?.trim();
  return id ? id : null;
}

function readJsonRecord(key: string): Record<string, string> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const record: Record<string, string> = {};
    for (const [entryKey, value] of Object.entries(parsed)) {
      if (typeof value === 'string') record[entryKey] = value;
    }
    return record;
  } catch {
    return {};
  }
}

function readJsonStringSet(key: string): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed.filter((value): value is string => typeof value === 'string')
    );
  } catch {
    return new Set();
  }
}

function writeJson(key: string, value: unknown): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Callers still update in-memory dismissal state when storage is unavailable.
  }
}

export function rememberSessionAnnouncement(
  scope: string | null | undefined,
  notice: ConversationStatusNotice
): void {
  const id = announcementIdOf(notice);
  if (!id || !scope) return;
  const seen = readJsonRecord(SEEN_ANNOUNCEMENTS_KEY);
  if (seen[id]) return;
  writeJson(SEEN_ANNOUNCEMENTS_KEY, { ...seen, [id]: scope });
}

export function rememberVisibleSessionAnnouncements(
  scope: string | null | undefined,
  notices: ConversationStatusNotice[]
): void {
  for (const notice of notices) {
    rememberSessionAnnouncement(scope, notice);
  }
}

function wasAnnouncementDismissed(notice: ConversationStatusNotice): boolean {
  const id = announcementIdOf(notice);
  if (!id) return false;
  return readJsonStringSet(DISMISSED_ANNOUNCEMENTS_KEY).has(id);
}

function wasAnnouncementSeenInOtherScope(
  scope: string | null | undefined,
  notice: ConversationStatusNotice
): boolean {
  const id = announcementIdOf(notice);
  if (!id) return false;
  const firstScope = readJsonRecord(SEEN_ANNOUNCEMENTS_KEY)[id];
  return Boolean(firstScope && firstScope !== scope);
}

function persistAnnouncementDismissal(notice: ConversationStatusNotice): void {
  const id = announcementIdOf(notice);
  if (!id) return;
  const dismissed = readJsonStringSet(DISMISSED_ANNOUNCEMENTS_KEY);
  dismissed.add(id);
  writeJson(DISMISSED_ANNOUNCEMENTS_KEY, [...dismissed]);
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
      wasConversationStatusDismissed(scope, notice) ||
      wasAnnouncementDismissed(notice) ||
      wasAnnouncementSeenInOtherScope(scope, notice),
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
      persistAnnouncementDismissal(notice);
    },
    [scope]
  );
  return { dismiss, isDismissed };
}
