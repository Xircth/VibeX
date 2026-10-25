import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CollaborationWorkingStatus } from './CollaborationWorkingStatus';
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
});
