import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_MASTER_BOT_AVATAR,
  deriveMemberBotAvatar,
  resolveMemberBotAvatar,
} from './MemberBotAvatar';
import {
  COLLABORATION_ADD_MEMBER_EVENT,
  COLLABORATION_MEMBERS_CHANGED_EVENT,
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
              {
                member_id: 'm2',
                nickname: '小B',
                kind: 'agent',
                visible_to_agents: 1,
                conversation_id: 'conv-2',
              },
            ],
          };
        }
        if (method === 'space.list') {
          return {
            spaces: [{ space_id: 's1', name: '设计', lead_member_id: 'm2' }],
          };
        }
        if (method === 'thread.listSidebar') {
          return {
            items: [
              {
                kind: 'dm',
                thread_id: 'direct:mem-c',
                name: '小C',
                member: {
                  member_id: 'mem-c',
                  name: '小C',
                  conversation_id: 'conv-3',
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
    const onMembersChanged = vi.fn();
    window.addEventListener(COLLABORATION_ADD_MEMBER_EVENT, onCreate);
    window.addEventListener(
      COLLABORATION_MEMBERS_CHANGED_EVENT,
      onMembersChanged
    );
    render(
      <GroupDetailsMembersTab
        spaceId="s1"
        workspaceId="workspace-1"
        getAvatar={(conversationId, nickname) =>
          deriveMemberBotAvatar(conversationId || nickname || 'bot')
        }
      />
    );

    const rowA = await screen.findByTestId('collaboration-group-member-小A');
    const rowB = await screen.findByTestId('collaboration-group-member-小B');
    const list = screen.getByTestId('collaboration-group-members-tab');
    expect(
      list.querySelectorAll('[data-testid^="collaboration-group-member-"]')[0]
    ).toBe(rowB);
    expect(
      rowB.querySelector('[data-testid="collaboration-bot-avatar-lead-star"]')
    ).toBeTruthy();
    expect(
      rowA.querySelector('[data-testid="collaboration-bot-avatar-lead-star"]')
    ).toBeNull();
    expect(screen.queryByRole('button', { name: '设为负责人 小B' })).toBeNull();
    expect(screen.getByRole('button', { name: '设为负责人 小A' })).toBeTruthy();
    const remove = screen.getByRole('button', { name: '移除 小A' });
    expect(remove).toHaveAttribute('data-variant', 'destructive');
    expect(remove.className).toMatch(/bg-destructive\/10/);
    const addMember = screen.getByTestId('collaboration-group-add-member');
    expect(addMember).toHaveAttribute('data-variant', 'secondary');
    expect(
      addMember.closest('.collaboration-group-add-member-wrap')
    ).toBeTruthy();
    await user.click(remove);
    expect(collaborationCall).toHaveBeenCalledWith(
      'collaboration',
      'space.moveMember',
      expect.objectContaining({
        fromSpaceId: 's1',
        toSpaceId: 'unassigned:workspace-1',
        conversationId: 'conv-1',
      })
    );
    await waitFor(() => {
      expect(onMembersChanged).toHaveBeenCalled();
    });
    expect((onMembersChanged.mock.calls[0]?.[0] as CustomEvent).detail).toEqual(
      {
        spaceId: 's1',
        workspaceId: 'workspace-1',
      }
    );

    await user.click(screen.getByTestId('collaboration-group-add-member'));
    await user.click(
      await screen.findByTestId('collaboration-group-add-candidate-小C')
    );
    expect(collaborationCall).toHaveBeenCalledWith(
      'collaboration',
      'space.addMember',
      expect.objectContaining({
        spaceId: 's1',
        conversationId: 'conv-3',
        nickname: '小C',
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
    window.removeEventListener(
      COLLABORATION_MEMBERS_CHANGED_EVENT,
      onMembersChanged
    );
  });

  it('sets the group lead from the member row', async () => {
    const user = userEvent.setup();
    render(
      <GroupDetailsMembersTab
        spaceId="s1"
        workspaceId="workspace-1"
        getAvatar={(conversationId, nickname) =>
          deriveMemberBotAvatar(conversationId || nickname || 'bot')
        }
      />
    );

    await screen.findByTestId('collaboration-group-member-小A');
    await user.click(screen.getByRole('button', { name: '设为负责人 小A' }));
    await waitFor(() => {
      expect(collaborationCall).toHaveBeenCalledWith(
        'collaboration',
        'space.update',
        { spaceId: 's1', leadMemberId: 'm1' }
      );
    });
    const rowA = screen.getByTestId('collaboration-group-member-小A');
    expect(
      rowA.querySelector('[data-testid="collaboration-bot-avatar-lead-star"]')
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: '设为负责人 小A' })).toBeNull();
  });

  it('shows Master with the identity avatar in a group seat', async () => {
    collaborationCall.mockImplementation(
      async (_capability: string, method: string) => {
        if (method === 'space.listMembers') {
          return {
            members: [
              {
                member_id: 'seat-master',
                nickname: 'Master',
                kind: 'agent',
                visible_to_agents: 1,
                conversation_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
              },
            ],
          };
        }
        return { items: [] };
      }
    );

    render(
      <GroupDetailsMembersTab
        spaceId="s1"
        workspaceId="workspace-1"
        getAvatar={(conversationId, nickname, identityMemberId) =>
          resolveMemberBotAvatar({
            conversationId,
            nickname,
            identityMemberId,
            stored: {},
          })
        }
      />
    );

    const row = await screen.findByTestId('collaboration-group-member-Master');
    const avatar = row.querySelector('[data-bot-shape]');
    expect(avatar).toHaveAttribute(
      'data-bot-shape',
      DEFAULT_MASTER_BOT_AVATAR.shape
    );
    expect(avatar).toHaveAttribute(
      'data-bot-color',
      DEFAULT_MASTER_BOT_AVATAR.color
    );
  });
});
