import { describe, expect, it } from 'vitest';
import type { ConversationSessionNotice } from 'shared/types';
import {
  AGENT_BINDING_LOAD_FAILURE_NOTICE_ROW_ID,
  AGENT_BINDING_REBIND_NOTICE_ROW_ID,
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
    ).toBe(true);
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
