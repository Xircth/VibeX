import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CollaborationWorkingStatus,
  WORKING_AVATAR_FLIP_MS,
} from './CollaborationWorkingStatus';
import { deriveMemberBotAvatar } from './MemberBotAvatar';

describe('CollaborationWorkingStatus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders nothing when no members are working', () => {
    const { container } = render(<CollaborationWorkingStatus members={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows one nickname and does not cycle a single avatar', () => {
    render(
      <CollaborationWorkingStatus
        members={[{ name: '小A', avatar: deriveMemberBotAvatar('小A') }]}
      />
    );
    const status = screen.getByTestId('collaboration-working-status');
    expect(status).toHaveTextContent('小A正在工作...');
    expect(screen.getByTestId('collaboration-working-avatar')).toHaveAttribute(
      'data-working-name',
      '小A'
    );
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(screen.getByTestId('collaboration-working-avatar')).toHaveAttribute(
      'data-working-name',
      '小A'
    );
    const avatar = screen
      .getByTestId('collaboration-working-avatar')
      .querySelector('svg');
    expect(avatar).toHaveClass('collaboration-bot-avatar--animated');
    expect(avatar).toHaveAttribute('data-bot-session-active', 'true');
  });

  it('cycles the visible avatar when several bots are working', () => {
    render(
      <CollaborationWorkingStatus
        members={[
          { name: 'Ulwonder', avatar: deriveMemberBotAvatar('Ulwonder') },
          { name: 'Designer', avatar: deriveMemberBotAvatar('Designer') },
        ]}
      />
    );
    expect(
      screen.getByTestId('collaboration-working-status')
    ).toHaveTextContent('Ulwonder和Designer正在工作...');
    expect(screen.getByTestId('collaboration-working-avatar')).toHaveAttribute(
      'data-working-name',
      'Ulwonder'
    );
    act(() => {
      vi.advanceTimersByTime(1600);
    });
    expect(screen.getByTestId('collaboration-working-avatar')).toHaveAttribute(
      'data-working-name',
      'Designer'
    );
    act(() => {
      vi.advanceTimersByTime(1600);
    });
    expect(screen.getByTestId('collaboration-working-avatar')).toHaveAttribute(
      'data-working-name',
      'Ulwonder'
    );
  });

  it('flips the outgoing avatar onto the incoming one', () => {
    render(
      <CollaborationWorkingStatus
        members={[
          { name: 'Ulwonder', avatar: deriveMemberBotAvatar('Ulwonder') },
          { name: 'Designer', avatar: deriveMemberBotAvatar('Designer') },
        ]}
      />
    );
    const slot = screen.getByTestId('collaboration-working-avatar');
    expect(slot).toHaveAttribute('data-flipping', 'false');

    act(() => {
      vi.advanceTimersByTime(1600);
    });

    expect(slot).toHaveAttribute('data-flipping', 'true');
    expect(slot).toHaveAttribute('data-working-name', 'Designer');
    expect(
      screen.getByTestId('collaboration-working-avatar-front')
    ).toHaveAttribute('data-working-name', 'Ulwonder');
    expect(
      screen.getByTestId('collaboration-working-avatar-back')
    ).toHaveAttribute('data-working-name', 'Designer');
    const flipper = screen.getByTestId('collaboration-working-avatar-flipper');
    expect(flipper).toHaveClass('is-flipping');

    act(() => {
      vi.advanceTimersByTime(WORKING_AVATAR_FLIP_MS);
    });
    expect(slot).toHaveAttribute('data-flipping', 'false');
    expect(
      screen.queryByTestId('collaboration-working-avatar-front')
    ).toBeNull();
    expect(slot.querySelector('svg')).toHaveAttribute(
      'data-bot-session-active',
      'true'
    );
  });
});
