import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ConversationMessageNav } from './ConversationMessageNav';

describe('ConversationMessageNav', () => {
  it('highlights the active anchor and calls onSelect with the virtual row index', () => {
    const onSelect = vi.fn();

    render(
      <ConversationMessageNav
        activeIndex={5}
        onSelect={onSelect}
        entries={[
          {
            key: 'first',
            index: 0,
            ordinal: 1,
            preview: 'First request',
            additions: 0,
            deletions: 0,
          },
          {
            key: 'second',
            index: 4,
            ordinal: 2,
            preview: 'Second request',
            additions: 3,
            deletions: 1,
          },
        ]}
      />
    );

    expect(
      screen.getByRole('button', { name: '跳转到第 2 条消息' })
    ).toHaveAttribute('aria-current', 'true');

    fireEvent.click(screen.getByRole('button', { name: '跳转到第 1 条消息' }));

    expect(onSelect).toHaveBeenCalledWith(0);
  });

  it('shows a two-line message preview to the left when a tick is hovered', async () => {
    const user = userEvent.setup();

    render(
      <ConversationMessageNav
        activeIndex={0}
        onSelect={vi.fn()}
        entries={[
          {
            key: 'first',
            index: 0,
            ordinal: 1,
            preview: 'Please polish the conversation monitor layout',
            additions: 0,
            deletions: 0,
          },
        ]}
      />
    );

    const tick = screen.getByRole('button', {
      name: '跳转到第 1 条消息',
    });
    await user.hover(tick);

    const previews = await screen.findAllByText(
      'Please polish the conversation monitor layout'
    );
    const preview = previews.find((element) =>
      element.classList.contains('conv-message-nav-preview')
    );

    expect(preview).toBeDefined();
    expect(preview).toHaveClass('conv-message-nav-preview');
    expect(preview).toHaveAttribute('data-side', 'left');
  });
});
