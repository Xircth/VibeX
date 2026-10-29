import { describe, expect, it } from 'vitest';

import {
  COLLAB_THREAD_BOTTOM_THRESHOLD_PX,
  isCollabThreadLogAtBottom,
  isCollabThreadUserBubble,
  scrollCollabThreadLogToBottom,
} from './collaborationThreadLog';

describe('collaboration thread log scroll', () => {
  it('treats a log within the threshold as at the bottom', () => {
    expect(
      isCollabThreadLogAtBottom({
        scrollHeight: 2000,
        scrollTop: 2000 - 400 - COLLAB_THREAD_BOTTOM_THRESHOLD_PX,
        clientHeight: 400,
      })
    ).toBe(true);
    expect(
      isCollabThreadLogAtBottom({
        scrollHeight: 2000,
        scrollTop: 2000 - 400 - COLLAB_THREAD_BOTTOM_THRESHOLD_PX - 1,
        clientHeight: 400,
      })
    ).toBe(false);
  });

  it('scrolls the log to the bottom edge', () => {
    const el = {
      scrollHeight: 2000,
      clientHeight: 400,
      scrollTop: 12,
      scrollTo: undefined as
        | ((options: { top: number; behavior?: ScrollBehavior }) => void)
        | undefined,
    };
    scrollCollabThreadLogToBottom(el);
    expect(el.scrollTop).toBe(1600);
  });
});

describe('isCollabThreadUserBubble', () => {
  it('parses flattened Person and bot senders', () => {
    expect(isCollabThreadUserBubble({ envelope: { sender: 'Person' } })).toBe(
      true
    );
    expect(isCollabThreadUserBubble({ envelope: { sender: 'User' } })).toBe(
      true
    );
    expect(isCollabThreadUserBubble({ envelope: { sender: '小A' } })).toBe(
      false
    );
    expect(
      isCollabThreadUserBubble({
        envelope: { sender: 'system' },
      })
    ).toBe(false);
  });
});
