import { beforeEach, describe, expect, it } from 'vitest';
import type { ConversationStatusNotice } from '@/contexts/ConversationStatusContext';
import {
  announcementIdOf,
  rememberSessionAnnouncement,
  wasConversationStatusDismissed,
  persistConversationStatusDismissal,
} from './conversationStatusDismissal';

function announcementNotice(
  announcementId: string,
  title = 'Grok 4.6 is here!'
): ConversationStatusNotice {
  return {
    id: `announcement:${announcementId}`,
    kind: 'session-notice',
    notice: {
      title,
      message: 'See what is new.',
      severity: 'info',
      announcement_id: announcementId,
    },
  };
}

describe('conversationStatusDismissal announcements', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('identifies announcement notices by announcement_id', () => {
    expect(announcementIdOf(announcementNotice('grok-4-6'))).toBe('grok-4-6');
    expect(
      announcementIdOf({
        id: 'notice-1',
        kind: 'session-notice',
        notice: {
          title: '部分会话记录无法显示',
          message: null,
          severity: 'warning',
        },
      })
    ).toBeNull();
  });

  it('records the first conversation that saw an announcement', () => {
    const notice = announcementNotice('grok-4-6');
    rememberSessionAnnouncement('session-1', notice);
    rememberSessionAnnouncement('session-1', notice);

    expect(localStorage.getItem('vibex:seen-session-announcements')).toBe(
      JSON.stringify({ 'grok-4-6': 'session-1' })
    );
  });

  it('keeps per-conversation dismissal for ordinary session notices', () => {
    const notice: ConversationStatusNotice = {
      id: 'notice-1',
      kind: 'session-notice',
      notice: {
        title: '部分会话记录无法显示',
        message: '其余会话内容不受影响。',
        severity: 'warning',
      },
    };

    persistConversationStatusDismissal('session-1', notice);

    expect(wasConversationStatusDismissed('session-1', notice)).toBe(true);
    expect(wasConversationStatusDismissed('session-2', notice)).toBe(false);
  });

  it('keeps a dismissed notice hidden when the same content returns with a new row id', () => {
    persistConversationStatusDismissal('session-1', {
      id: 'err:turn-1:12',
      kind: 'turn-error',
      error: {
        message: 'agent connection closed',
        code: 'connection_closed',
        raw: { attempt: 1 },
        kind: 'connection_closed',
      },
    });

    expect(
      wasConversationStatusDismissed('session-1', {
        id: 'err:turn-1:44',
        kind: 'turn-error',
        error: {
          message: 'agent connection closed',
          code: 'connection_closed',
          raw: { attempt: 2 },
          kind: 'connection_closed',
        },
      })
    ).toBe(true);
  });

  it('still shows a later notice that reuses a row id but has different content', () => {
    persistConversationStatusDismissal('session-1', {
      id: 'notice-1',
      kind: 'session-notice',
      notice: {
        title: '部分会话记录无法显示',
        message: '其余会话内容不受影响。',
        severity: 'warning',
      },
    });

    expect(
      wasConversationStatusDismissed('session-1', {
        id: 'notice-1',
        kind: 'session-notice',
        notice: {
          title: '回退后产生的新提示',
          message: '即使复用了事件序号也应显示。',
          severity: 'warning',
        },
      })
    ).toBe(false);
  });
});
