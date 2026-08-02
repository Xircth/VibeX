import type { ConversationSessionNotice } from 'shared/types';

const NEWER_EVENT_TITLE = '此会话包含较新版本的记录';
const UNREADABLE_EVENT_TITLE = '部分会话记录无法显示';

type Translate = (key: string) => string;

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

  return { title: notice.title, message: notice.message ?? null };
}
