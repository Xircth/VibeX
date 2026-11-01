import type { ConversationSessionNotice } from 'shared/types';

const NEWER_EVENT_TITLE = '此会话包含较新版本的记录';
const UNREADABLE_EVENT_TITLE = '部分会话记录无法显示';
const AUTO_PERMISSION_TITLE = '已自动批准权限';

type Translate = {
  (key: string, options?: Record<string, unknown>): string;
};

/**
 * Backend (crates/conversations/src/projection.rs) emits fixed notice titles in
 * a single language. Map them to i18n keys so the card follows the UI language.
 * Messages are only replaced when they equal the known fixed backend text;
 * dynamic messages (agent errors, recovery commands) are passed through.
 */
const BACKEND_NOTICES: Record<
  string,
  { title: string; message?: { source: string; key: string } }
> = {
  '正在连接 Agent…': { title: 'connectingAgent' },
  代理会话已过期: {
    title: 'sessionExpired',
    message: {
      source:
        '代理侧已不存在该会话。可见历史仍在，但 Agent 隐藏上下文已丢失。确认重新绑定后才能继续。',
      key: 'sessionExpiredDescription',
    },
  },
  需要重新认证: { title: 'reauthRequired' },
  代理不支持会话恢复: {
    title: 'resumeUnsupported',
    message: {
      source:
        '该代理无法恢复原会话。确认重新绑定后将冷启动，不会保留 Agent 侧上下文。',
      key: 'resumeUnsupportedDescription',
    },
  },
  代理会话已归档: {
    title: 'sessionArchived',
    message: {
      source: '会话已归档。重新加载或新建对话。',
      key: 'sessionArchivedDescription',
    },
  },
  代理会话正被占用: {
    title: 'sessionBusy',
    message: {
      source:
        '关闭占用该会话的窗口后重新加载。不要新建会话，否则会丢掉唯一指针。',
      key: 'sessionBusyDescription',
    },
  },
  代理会话不可用: {
    title: 'sessionUnavailable',
    message: {
      source:
        '代理侧会话已结束或不存在。可见历史仍在，但 Agent 隐藏上下文已丢失。',
      key: 'sessionUnavailableDescription',
    },
  },
  加载代理会话失败: { title: 'sessionLoadFailed' },
  'Agent 会话已重新绑定': { title: 'sessionRebound' },
  'Agent session recovery failed': { title: 'sessionRecoveryFailed' },
  'Agent configuration changed': { title: 'agentConfigChanged' },
  会话出错: { title: 'sessionError' },
  会话配置未应用: { title: 'configOverrideSkipped' },
  未识别的会话更新: { title: 'unrecognizedUpdate' },
};

/** Localize a fixed backend notice title; unknown titles pass through. */
export function localizeBackendNoticeTitle(
  title: string,
  t: Translate
): string {
  const entry = BACKEND_NOTICES[title];
  return entry ? t(`conversation:backendNotice.${entry.title}`) : title;
}

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

  const entry = BACKEND_NOTICES[notice.title];
  if (entry) {
    const message =
      entry.message && notice.message === entry.message.source
        ? t(`conversation:backendNotice.${entry.message.key}`)
        : (notice.message ?? null);
    return { title: t(`conversation:backendNotice.${entry.title}`), message };
  }

  return { title: notice.title, message: notice.message ?? null };
}
