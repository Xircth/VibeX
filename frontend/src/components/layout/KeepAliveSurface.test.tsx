import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { KeepAliveSurface } from './KeepAliveSurface';

describe('KeepAliveSurface', () => {
  it('does not mount children until the surface has been active', () => {
    render(
      <KeepAliveSurface active={false}>
        <div data-testid="board">board</div>
      </KeepAliveSurface>
    );

    expect(screen.queryByTestId('board')).not.toBeInTheDocument();
  });

  it('keeps children mounted after the surface becomes inactive', () => {
    const { rerender } = render(
      <KeepAliveSurface active className="kanban-overlay">
        <div data-testid="board">board</div>
      </KeepAliveSurface>
    );

    expect(screen.getByTestId('board')).toBeInTheDocument();

    rerender(
      <KeepAliveSurface active={false} className="kanban-overlay">
        <div data-testid="board">board</div>
      </KeepAliveSurface>
    );

    const board = screen.getByTestId('board');
    expect(board).toBeInTheDocument();
    expect(board.parentElement).toHaveAttribute('hidden');
    expect(board.parentElement).toHaveAttribute('aria-hidden', 'true');
  });
});
