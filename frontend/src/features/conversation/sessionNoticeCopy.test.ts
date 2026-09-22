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

  it('localizes auto-approved permission notices with the folded count', () => {
    const t = (key: string, options?: Record<string, unknown>) => {
      if (key === 'conversation:statusDock.autoPermissionTitle') {
        return 'Permissions auto-approved';
      }
      if (key === 'conversation:statusDock.autoPermissionDescription') {
        return `Automatically approved ${options?.count ?? 0} permission requests`;
      }
      return translations[key] ?? key;
    };
    expect(
      getConversationSessionNoticeCopy(
        {
          title: '已自动批准权限',
          message: '已自动批准 3 项权限请求',
          severity: 'info',
        },
        t
      )
    ).toEqual({
      title: 'Permissions auto-approved',
      message: 'Automatically approved 3 permission requests',
    });
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
