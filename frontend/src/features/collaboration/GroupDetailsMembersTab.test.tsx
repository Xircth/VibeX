import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { deriveMemberBotAvatar } from './MemberBotAvatar';
import {
  COLLABORATION_ADD_MEMBER_EVENT,
  GroupDetailsMembersTab,
} from './GroupDetailsMembersTab';

const collaborationCall = vi.hoisted(() => vi.fn());

vi.mock('./collaborationApi', () => ({
  collaborationCall,
}));

describe('GroupDetailsMembersTab', () => {
  beforeEach(() => {
    collaborationCall.mockReset();
    collaborationCall.mockImplementation(
      async (_capability: string, method: string) => {
        if (method === 'space.listMembers') {
          return {
            members: [
              {
                member_id: 'm1',
                nickname: '小A',
                kind: 'agent',
                visible_to_agents: 1,
                conversation_id: 'conv-1',
              },
            ],
          };
        }
        if (method === 'thread.listSidebar') {
          return {
            items: [
              {
                kind: 'dm',
                thread_id: 'direct:mem-b',
                name: '小B',
                member: {
                  member_id: 'mem-b',
                  name: '小B',
                  conversation_id: 'conv-2',
                },
              },
            ],
          };
        }
        return {};
      }
    );
  });

  it('lists members, adds an existing assistant, and removes on 移除', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    window.addEventListener(COLLABORATION_ADD_MEMBER_EVENT, onCreate);
    render(
      <GroupDetailsMembersTab
        spaceId="s1"
        workspaceId="workspace-1"
        getAvatar={(conversationId, nickname) =>
          deriveMemberBotAvatar(conversationId || nickname || 'bot')
        }
      />
    );

    expect(
      await screen.findByTestId('collaboration-group-member-小A')
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '移除 小A' }));
    expect(collaborationCall).toHaveBeenCalledWith(
      'collaboration',
      'space.moveMember',
      expect.objectContaining({
        fromSpaceId: 's1',
        toSpaceId: 'unassigned:workspace-1',
        conversationId: 'conv-1',
      })
    );

    await user.click(screen.getByTestId('collaboration-group-add-member'));
    await user.click(
      await screen.findByTestId('collaboration-group-add-candidate-小B')
    );
    expect(collaborationCall).toHaveBeenCalledWith(
      'collaboration',
      'space.addMember',
      expect.objectContaining({
        spaceId: 's1',
        conversationId: 'conv-2',
        nickname: '小B',
      })
    );

    await user.click(screen.getByTestId('collaboration-group-add-member'));
    await user.click(
      await screen.findByTestId('collaboration-group-create-assistant')
    );
    await waitFor(() => {
      expect(onCreate).toHaveBeenCalled();
    });
    window.removeEventListener(COLLABORATION_ADD_MEMBER_EVENT, onCreate);
  });
});
