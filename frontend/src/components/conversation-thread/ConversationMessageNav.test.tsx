import { fireEvent, render, screen } from '@testing-library/react';
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

    expect(screen.getByRole('button', { name: /Second request/ })).toHaveAttribute(
      'aria-current',
      'true'
    );

    fireEvent.click(screen.getByRole('button', { name: /First request/ }));

    expect(onSelect).toHaveBeenCalledWith(0);
  });
});
