import { useLayoutEffect } from 'react';
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
    expect(board.parentElement).toHaveStyle({ display: 'none' });
    expect(board.parentElement).toHaveAttribute('aria-hidden', 'true');
  });

  it('does not tear down descendant layout effects while inactive', () => {
    const events: string[] = [];
    function Child() {
      useLayoutEffect(() => {
        events.push('mount');
        return () => {
          events.push('unmount');
        };
      }, []);
      return <div data-testid="slot">slot</div>;
    }

    const { rerender } = render(
      <KeepAliveSurface active>
        <Child />
      </KeepAliveSurface>
    );
    rerender(
      <KeepAliveSurface active={false}>
        <Child />
      </KeepAliveSurface>
    );
    rerender(
      <KeepAliveSurface active>
        <Child />
      </KeepAliveSurface>
    );

    expect(events).toEqual(['mount']);
    expect(screen.getByTestId('slot')).toBeInTheDocument();
  });
});
