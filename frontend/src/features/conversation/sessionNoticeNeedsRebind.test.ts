import { describe, expect, it } from 'vitest';
import type { ConversationSessionNotice } from 'shared/types';
import {
  AGENT_BINDING_LOAD_FAILURE_NOTICE_ROW_ID,
  AGENT_BINDING_REBIND_NOTICE_ROW_ID,
  AGENT_CONNECTION_RECOVERING_NOTICE_ROW_ID,
  AGENT_SESSION_CONNECT_ERROR_NOTICE_ROW_ID,
  isResendColdStartNotice,
  sessionNoticeNeedsRebind,
} from './sessionNoticeNeedsRebind';

function notice(
  overrides: Partial<ConversationSessionNotice> = {}
): ConversationSessionNotice {
  return {
    title: 'Notice',
    message: 'hello',
    severity: 'info',
    ...overrides,
  };
}

describe('isResendColdStartNotice', () => {
  it('hides the cold-start banner resend records', () => {
    expect(
      isResendColdStartNotice(AGENT_BINDING_REBIND_NOTICE_ROW_ID, {
        message:
          '可见历史仍在，但 Agent 隐藏上下文已丢失。后续消息从新的冷启动会话继续。',
      })
    ).toBe(true);
  });

  it('keeps a rebind that still links the previous thread', () => {
    expect(
      isResendColdStartNotice(AGENT_BINDING_REBIND_NOTICE_ROW_ID, {
        message:
          '可见历史已链接到上一线程。后续消息走新的 Agent 线程，不会混入其他会话。',
      })
    ).toBe(false);
    expect(
      isResendColdStartNotice(AGENT_BINDING_LOAD_FAILURE_NOTICE_ROW_ID, {
        message:
          '可见历史仍在，但 Agent 隐藏上下文已丢失。后续消息从新的冷启动会话继续。',
      })
    ).toBe(false);
  });
});

describe('sessionNoticeNeedsRebind', () => {
  it('does not offer rebind for product notices or non-blocking warnings', () => {
    expect(
      sessionNoticeNeedsRebind(
        notice({
          title: 'Grok 4.6 is here!',
          severity: 'info',
          announcement_id: 'grok-4-6',
        })
      )
    ).toBe(false);
    expect(
      sessionNoticeNeedsRebind(
        notice({
          title: '部分会话记录无法显示',
          severity: 'warning',
        })
      )
    ).toBe(false);
    expect(
      sessionNoticeNeedsRebind(
        notice({
          title: 'Agent 会话已重新绑定',
          severity: 'warning',
        }),
        AGENT_BINDING_REBIND_NOTICE_ROW_ID
      )
    ).toBe(false);
    expect(
      sessionNoticeNeedsRebind(
        notice({
          title: '会话加载异常，正在重连 1/10 次…',
          severity: 'warning',
        }),
        AGENT_CONNECTION_RECOVERING_NOTICE_ROW_ID
      )
    ).toBe(false);
    expect(
      sessionNoticeNeedsRebind(
        notice({
          title: '会话出错',
          severity: 'error',
        }),
        AGENT_SESSION_CONNECT_ERROR_NOTICE_ROW_ID
      )
    ).toBe(false);
  });

  it('offers rebind only when the Agent session cannot continue', () => {
    expect(
      sessionNoticeNeedsRebind(
        notice({
          title: '代理会话已过期',
          severity: 'warning',
        }),
        AGENT_BINDING_LOAD_FAILURE_NOTICE_ROW_ID
      )
    ).toBe(false);
    expect(
      sessionNoticeNeedsRebind(
        notice({
          title: 'Agent session recovery failed',
          severity: 'error',
        })
      )
    ).toBe(true);
  });
});
