import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { KanbanNavArrow } from './KanbanNavArrow';

describe('KanbanNavArrow', () => {
  it('pins a bare chevron pair to the page edge', () => {
    const { container } = render(
      <KanbanNavArrow side="left" label="上一页" onClick={vi.fn()} />
    );

    const rail = container.querySelector('[data-kanban-nav="left"]');
    const button = screen.getByRole('button', { name: '上一页' });

    expect(rail).toHaveClass('absolute', 'left-0');
    expect(button).toHaveClass('kanban-nav-arrow');
    expect(button.className).not.toMatch(/rounded/);
    expect(button.className).not.toMatch(/border/);
    expect(button.querySelector('svg')).not.toBeNull();
  });

  it('places the right rail on the far right edge', () => {
    const { container } = render(
      <KanbanNavArrow side="right" label="下一页" onClick={vi.fn()} />
    );

    expect(container.querySelector('[data-kanban-nav="right"]')).toHaveClass(
      'absolute',
      'right-0'
    );
  });

  it('invokes the page-switch handler', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();

    render(<KanbanNavArrow side="right" label="下一页" onClick={onClick} />);
    await user.click(screen.getByRole('button', { name: '下一页' }));

    expect(onClick).toHaveBeenCalledOnce();
  });
});
