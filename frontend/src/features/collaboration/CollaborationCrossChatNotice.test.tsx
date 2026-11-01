import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  CollaborationCrossChatNotice,
  CROSS_CHAT_GROUP_AVATAR_PX,
} from './CollaborationCrossChatNotice';
import { deriveMemberBotAvatar } from './MemberBotAvatar';

describe('CollaborationCrossChatNotice', () => {
  it('renders 已发送给 with a member chip and the sender avatar color on the lines', () => {
    const avatar = deriveMemberBotAvatar('小B');
    render(
      <CollaborationCrossChatNotice
        kind="sent"
        seq={3}
        lineColor="#8b52ff"
        peers={[{ kind: 'member', name: '小B' }]}
        memberAvatarFor={() => avatar}
      />
    );

    expect(screen.getByText('已发送给')).toBeTruthy();
    expect(
      screen.getByTestId('collaboration-member-mention-chip-小B')
    ).toBeTruthy();
    const notice = screen
      .getByText('已发送给')
      .closest('.collaboration-cross-chat-notice') as HTMLElement;
    expect(notice.style.getPropertyValue('--cross-chat-line-color')).toBe(
      '#8b52ff'
    );
  });

  it('renders 已收到 with a member chip and no message body slot', () => {
    render(
      <CollaborationCrossChatNotice
        kind="received"
        seq={4}
        lineColor="#2563eb"
        peers={[{ kind: 'member', name: '小A' }]}
        memberAvatarFor={() => deriveMemberBotAvatar('小A')}
      />
    );

    expect(screen.getByText('已收到')).toBeTruthy();
    expect(screen.getByText('的消息')).toBeTruthy();
    const notice = screen
      .getByText('已收到')
      .closest('.collaboration-cross-chat-notice') as HTMLElement;
    expect(
      within(notice).getByTestId('collaboration-member-mention-chip-小A')
    ).toBeTruthy();
  });

  it('renders a group counterpart with GroupAvatar and the group name', () => {
    render(
      <CollaborationCrossChatNotice
        kind="sent"
        seq={5}
        lineColor="#0f766e"
        peers={[{ kind: 'group', name: '设计', id: 's1' }]}
        groupAvatarsFor={() => [deriveMemberBotAvatar('小A')]}
      />
    );

    expect(screen.getByText('已发送给')).toBeTruthy();
    expect(
      screen.getByTestId('collaboration-cross-chat-peer-设计')
    ).toBeTruthy();
    const avatar = screen.getByTestId(
      'collaboration-cross-chat-group-avatar-设计'
    );
    expect(avatar).toBeTruthy();
    expect(avatar).toHaveStyle({
      width: `${CROSS_CHAT_GROUP_AVATAR_PX}px`,
      height: `${CROSS_CHAT_GROUP_AVATAR_PX}px`,
    });
    expect(screen.getByText('设计')).toBeTruthy();
    expect(
      screen.getByTestId('collaboration-cross-chat-peer-设计')
    ).toHaveClass('collaboration-cross-chat-group-chip');
  });
});
