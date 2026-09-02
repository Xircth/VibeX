import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FloatingSessionList } from './FloatingSessionList';

describe('FloatingSessionList', () => {
  it('renders a translucent overlay without a full-height collapse strip', () => {
    const { container } = render(
      <FloatingSessionList collapsed={false} width={280}>
        <div>session list</div>
      </FloatingSessionList>
    );

    expect(screen.getByText('session list')).toBeInTheDocument();
    expect(
      container.querySelector('.session-canvas-floating-panel')
    ).toHaveClass('session-canvas-floating-panel');
    expect(
      screen.queryByRole('button', { name: '隐藏会话列表' })
    ).not.toBeInTheDocument();
  });

  it('hides the overlay when collapsed', () => {
    render(
      <FloatingSessionList collapsed width={280}>
        <div>session list</div>
      </FloatingSessionList>
    );

    expect(screen.queryByText('session list')).not.toBeInTheDocument();
  });
});
