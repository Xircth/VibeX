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
  collaborationSessionTitle,
  openCollaborationSessionFromList,
} from './sessionCollaboration';

describe('collaborationSessionTitle', () => {
  it('names direct chats User → Bot and group seats Group → Bot', () => {
    expect(
      collaborationSessionTitle({
        threadKind: 'direct',
        threadName: '',
        memberName: 'Master',
      })
    ).toBe('User → Master');
    expect(
      collaborationSessionTitle({
        threadKind: 'group',
        threadName: '后端工程师群',
        memberName: 'Master',
      })
    ).toBe('后端工程师群 → Master');
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
        threadMembers: [],
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
