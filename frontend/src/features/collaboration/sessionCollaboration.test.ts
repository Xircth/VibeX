import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  setActiveTab: vi.fn(),
  requestSessionFocus: vi.fn(),
}));

vi.mock('@/stores/useLayoutStore', () => ({
  useLayoutStore: {
    getState: () => ({ setActiveTab: mocks.setActiveTab }),
  },
}));

vi.mock('./collaborationLayoutStore', () => ({
  useCollaborationLayoutStore: {
    getState: () => ({ requestSessionFocus: mocks.requestSessionFocus }),
  },
}));

import {
  collaborationStoredSessionName,
  openCollaborationSessionFromList,
} from './sessionCollaboration';

describe('collaborationStoredSessionName', () => {
  it('treats a stored title that equals the member nickname as unset', () => {
    expect(collaborationStoredSessionName('小A', '小A')).toBeNull();
    expect(collaborationStoredSessionName(' 小A ', '小A')).toBeNull();
    expect(collaborationStoredSessionName('修登录', '小A')).toBe('修登录');
    expect(collaborationStoredSessionName(null, '小A')).toBeNull();
    expect(collaborationStoredSessionName('   ', '小A')).toBeNull();
  });
});

describe('openCollaborationSessionFromList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('focuses the matching thread and switches to the collaboration tab', () => {
    openCollaborationSessionFromList({
      conversationId: 'conv-1',
      collaboration: {
        memberId: 'mem-a',
        memberName: '小A',
        threadId: 's1',
        threadKind: 'group',
        threadName: '设计',
      },
    });
    expect(mocks.requestSessionFocus).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      memberId: 'mem-a',
      memberName: '小A',
      threadId: 's1',
      threadKind: 'group',
      threadName: '设计',
    });
    expect(mocks.setActiveTab).toHaveBeenCalledWith('collaboration');
  });
});
