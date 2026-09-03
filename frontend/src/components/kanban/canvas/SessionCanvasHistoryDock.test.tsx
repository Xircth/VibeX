import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SessionCanvasHistoryDock } from './SessionCanvasHistoryDock';

describe('SessionCanvasHistoryDock', () => {
  it('calls undo and redo from the history pill', async () => {
    const user = userEvent.setup();
    const onUndo = vi.fn();
    const onRedo = vi.fn();
    render(
      <SessionCanvasHistoryDock
        canUndo
        canRedo
        onUndo={onUndo}
        onRedo={onRedo}
      />
    );

    await user.click(screen.getByRole('button', { name: '后退' }));
    await user.click(screen.getByRole('button', { name: '前进' }));
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(onRedo).toHaveBeenCalledTimes(1);
  });

  it('disables history actions when the stack is empty', () => {
    render(
      <SessionCanvasHistoryDock
        canUndo={false}
        canRedo={false}
        onUndo={vi.fn()}
        onRedo={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: '后退' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '前进' })).toBeDisabled();
  });
});
