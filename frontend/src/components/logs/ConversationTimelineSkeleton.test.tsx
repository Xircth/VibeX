import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ConversationTimelineSkeleton } from './ConversationTimelineSkeleton';

describe('ConversationTimelineSkeleton', () => {
  it('renders a thread shell skeleton instead of a spinner', () => {
    render(<ConversationTimelineSkeleton label="正在加载会话..." />);

    const status = screen.getByRole('status', { name: '正在加载会话...' });
    expect(status).toHaveAttribute(
      'data-testid',
      'conversation-timeline-skeleton'
    );
    expect(
      status.querySelectorAll('.conv-thread-skeleton-bar').length
    ).toBeGreaterThan(3);
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });
});
