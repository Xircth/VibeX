import { beforeEach, describe, expect, it, vi } from 'vitest';

const persistFrontendPreference = vi.hoisted(() => vi.fn());

vi.mock('@/lib/frontendPreferences', () => ({
  persistFrontendPreference,
}));

import {
  DEFAULT_HIDE_BOT_SESSIONS,
  HIDE_BOT_SESSIONS_KEY,
  filterVisibleBotSessions,
  getHideBotSessions,
  resetHideBotSessions,
  setHideBotSessions,
  subscribeHideBotSessions,
} from './hideBotSessions';

describe('hideBotSessions', () => {
  beforeEach(() => {
    persistFrontendPreference.mockReset();
    localStorage.clear();
    resetHideBotSessions();
    persistFrontendPreference.mockReset();
  });

  it('defaults to false and persists updates', () => {
    expect(DEFAULT_HIDE_BOT_SESSIONS).toBe(false);
    expect(getHideBotSessions()).toBe(false);

    const listener = vi.fn();
    const unsubscribe = subscribeHideBotSessions(listener);

    setHideBotSessions(true);
    expect(getHideBotSessions()).toBe(true);
    expect(localStorage.getItem(HIDE_BOT_SESSIONS_KEY)).toBe('true');
    expect(persistFrontendPreference).toHaveBeenCalledWith(
      HIDE_BOT_SESSIONS_KEY,
      true
    );
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  it('filters out Bot sessions when enabled', () => {
    const userSession = { id: 'user-1', collaboration: null };
    const botSession = {
      id: 'bot-1',
      collaboration: {
        memberId: 'mem-1',
        memberName: 'Bot A',
        threadId: 'direct:mem-1',
        threadKind: 'dm' as const,
        threadName: 'Bot A',
      },
    };

    expect(filterVisibleBotSessions([userSession, botSession], false)).toEqual([
      userSession,
      botSession,
    ]);
    expect(filterVisibleBotSessions([userSession, botSession], true)).toEqual([
      userSession,
    ]);
  });
});
