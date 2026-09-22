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

  it('opens the conversation plan card in the popover', () => {
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

    expect(screen.getByTestId('conversation-plan-card')).toBeInTheDocument();
    const list = screen.getByRole('region', { name: '任务列表' });
    expect(list).toHaveClass('composer-todo-list');
    expect(list).toHaveAttribute('tabindex', '0');
    expect(
      screen.getByRole('button', { name: '收起计划' })
    ).toBeInTheDocument();
    expect(screen.getByText('1 / 2 已完成')).toBeInTheDocument();
    expect(screen.getByText('01')).toBeInTheDocument();
    expect(screen.getByText('02')).toBeInTheDocument();
    expect(screen.getByText('Ship cleanup')).toBeInTheDocument();
    expect(screen.getByText('Review plan')).toBeInTheDocument();
  });
});
