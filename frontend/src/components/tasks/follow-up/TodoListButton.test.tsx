import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TodoListButton } from './TodoListButton';

describe('TodoListButton', () => {
  it('renders an empty-state popover without a count badge', () => {
    render(<TodoListButton todos={[]} />);

    const button = screen.getByRole('button', { name: '任务列表' });
    expect(button).toHaveClass('opacity-50');
    expect(screen.queryByText('0')).not.toBeInTheDocument();

    fireEvent.click(button);

    expect(screen.getByText('暂无任务')).toBeInTheDocument();
  });

  it('renders todo count and status presentation in the popover', () => {
    render(
      <TodoListButton
        todos={[
          { content: 'Ship cleanup', status: 'completed' },
          { content: 'Review plan', status: 'in_progress' },
        ]}
      />
    );

    const button = screen.getByRole('button', { name: '任务列表' });
    expect(screen.getByText('2')).toBeInTheDocument();

    fireEvent.click(button);

    expect(screen.getByText('任务列表 (2)')).toBeInTheDocument();
    expect(screen.getByText('Ship cleanup')).toBeInTheDocument();
    expect(screen.getByText('Review plan')).toBeInTheDocument();
    expect(screen.getByText('\u2713')).toHaveClass('text-green-500');
    expect(screen.getByText('\u25CF')).toHaveClass('text-blue-500');
  });
});
