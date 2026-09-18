import type { ConversationSessionNotice } from 'shared/types';

const NEWER_EVENT_TITLE = '此会话包含较新版本的记录';
const UNREADABLE_EVENT_TITLE = '部分会话记录无法显示';
const AUTO_PERMISSION_TITLE = '已自动批准权限';

type Translate = {
  (key: string, options?: Record<string, unknown>): string;
};

export function getConversationSessionNoticeCopy(
  notice: ConversationSessionNotice,
  t: Translate
): { title: string; message: string | null } {
  if (notice.title === NEWER_EVENT_TITLE) {
    return {
      title: t('conversation:statusDock.newerEventTitle'),
      message: t('conversation:statusDock.newerEventDescription'),
    };
  }

  if (notice.title === UNREADABLE_EVENT_TITLE) {
    return {
      title: t('conversation:statusDock.unreadableEventTitle'),
      message: t('conversation:statusDock.unreadableEventDescription'),
    };
  }

  if (notice.title === AUTO_PERMISSION_TITLE) {
    const count = Number(notice.message?.match(/\d+/)?.[0] ?? '0');
    return {
      title: t('conversation:statusDock.autoPermissionTitle'),
      message: t('conversation:statusDock.autoPermissionDescription', {
        count,
      }),
    };
  }

  return { title: notice.title, message: notice.message ?? null };
}
