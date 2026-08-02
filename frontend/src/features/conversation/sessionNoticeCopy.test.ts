import { describe, expect, it } from 'vitest';
import { getConversationSessionNoticeCopy } from './sessionNoticeCopy';

describe('getConversationSessionNoticeCopy', () => {
  const translations: Record<string, string> = {
    'conversation:statusDock.newerEventTitle': 'Newer record',
    'conversation:statusDock.newerEventDescription': 'Update to view it.',
    'conversation:statusDock.unreadableEventTitle': 'Unreadable record',
    'conversation:statusDock.unreadableEventDescription':
      'The rest of the conversation is unaffected.',
  };
  const t = (key: string) => translations[key] ?? key;

  it('localizes forward-version notices instead of exposing backend copy', () => {
    expect(
      getConversationSessionNoticeCopy(
        {
          title: '此会话包含较新版本的记录',
          message:
            '当前版本暂时无法显示其中一条记录，其余会话内容不受影响。更新 VibeX 后可再次查看。',
          severity: 'warning',
        },
        t
      )
    ).toEqual({ title: 'Newer record', message: 'Update to view it.' });
  });

  it('keeps unrelated agent notices unchanged', () => {
    expect(
      getConversationSessionNoticeCopy(
        {
          title: '代理不支持会话恢复',
          message: '已自动新建会话继续。',
          severity: 'info',
        },
        t
      )
    ).toEqual({
      title: '代理不支持会话恢复',
      message: '已自动新建会话继续。',
    });
  });
});
