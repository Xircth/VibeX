import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { CollaborationSessionBadge } from './CollaborationSessionBadge';
import { deriveMemberBotAvatar } from './MemberBotAvatar';

describe('CollaborationSessionBadge', () => {
  it('renders the member name in the avatar color and keeps the parent click', () => {
    const onOpen = vi.fn();
    const onParentClick = vi.fn();
    const avatar = deriveMemberBotAvatar('小A');
    render(
      <div onClick={onParentClick}>
        <CollaborationSessionBadge memberName="小A" onOpen={onOpen} />
      </div>
    );
    const badge = screen.getByTestId('collaboration-session-badge');
    expect(badge).toHaveAttribute('aria-label', '打开助手 小A');
    expect(badge).toHaveTextContent('小A');
    expect(badge.querySelector('span.font-semibold')).toHaveStyle({
      color: avatar.color,
    });
    fireEvent.click(badge);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onParentClick).not.toHaveBeenCalled();
  });
});
