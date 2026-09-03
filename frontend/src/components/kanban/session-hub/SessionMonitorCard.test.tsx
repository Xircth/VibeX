import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { KanbanProjectSessionRecord } from '@/hooks/useKanbanProjectSessions';
import { TooltipProvider } from '@/components/ui/tooltip';
import { SessionMonitorCard } from './SessionMonitorCard';

vi.mock('@/components/kanban/KanbanSessionConversationView', () => ({
  KanbanSessionConversationView: ({
    interactive,
  }: {
    interactive?: boolean;
  }) => (
    <div
      data-testid="session-conversation"
      data-interactive={String(!!interactive)}
    />
  ),
}));

function createSession(): KanbanProjectSessionRecord {
  return {
    id: 'session-1',
    fullName: '技术重构可行性',
    updatedAt: '2026-08-08T08:00:00.000Z',
    isErrored: false,
    workspace: { id: 'workspace-1' },
  } as KanbanProjectSessionRecord;
}

describe('SessionMonitorCard', () => {
  it('keeps the execution-area action on the monitor variant', () => {
    const onMoveToExecution = vi.fn();
    const session = createSession();

    render(
      <TooltipProvider>
        <SessionMonitorCard
          session={session}
          variant="monitor"
          canUseRightPanelForSessions
          onMoveToExecution={onMoveToExecution}
          onClose={vi.fn()}
        />
      </TooltipProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: '移入执行区' }));
    expect(onMoveToExecution).toHaveBeenCalledWith(session);
    expect(screen.getByTestId('session-conversation')).toHaveAttribute(
      'data-interactive',
      'false'
    );
  });

  it('replaces the execution-area action with reset-size and enables input on canvas', () => {
    const onZoom = vi.fn();
    const onClose = vi.fn();
    const session = createSession();

    const { container } = render(
      <TooltipProvider>
        <SessionMonitorCard
          session={session}
          variant="canvas"
          onZoom={onZoom}
          onClose={onClose}
        />
      </TooltipProvider>
    );

    expect(
      screen.queryByRole('button', { name: '移入执行区' })
    ).not.toBeInTheDocument();
    const reset = screen.getByRole('button', { name: '恢复默认大小' });
    expect(reset).toHaveClass('raised-control');
    expect(reset).not.toHaveClass('text-[var(--primary-control-foreground)]');
    expect(container.firstElementChild).toHaveClass('canvas-session-window');
    expect(container.querySelector('.nowheel')).toHaveClass(
      'canvas-session-thread',
      'w-full',
      'rounded-t-xl'
    );
    expect(container.querySelector('.nowheel')).not.toHaveClass('mb-2');
    expect(container.querySelector('.nowheel')).not.toHaveClass('mx-2');
    expect(container.firstElementChild).not.toHaveClass('is-selected');
    expect(container.firstElementChild).not.toHaveClass('ring-2');
    expect(container.firstElementChild).not.toHaveClass('border-transparent');
    fireEvent.click(reset);
    expect(onZoom).toHaveBeenCalledWith(session);
    fireEvent.click(screen.getByRole('button', { name: '收起会话' }));
    expect(onClose).toHaveBeenCalledWith(session);
    expect(screen.getByTestId('session-conversation')).toHaveAttribute(
      'data-interactive',
      'true'
    );
  });

  it('marks a selected canvas window so its border can change', () => {
    const { container } = render(
      <TooltipProvider>
        <SessionMonitorCard
          session={createSession()}
          variant="canvas"
          selected
          onClose={vi.fn()}
        />
      </TooltipProvider>
    );
    expect(container.firstElementChild).toHaveClass('is-selected');
  });

  it('marks a running canvas window for the breathing border', () => {
    const { container } = render(
      <TooltipProvider>
        <SessionMonitorCard
          session={{ ...createSession(), isRunning: true }}
          variant="canvas"
          onClose={vi.fn()}
        />
      </TooltipProvider>
    );
    expect(container.firstElementChild).toHaveClass('is-running');
  });

  it('marks an unviewed finished canvas window for review breathing', () => {
    const { container } = render(
      <TooltipProvider>
        <SessionMonitorCard
          session={{
            ...createSession(),
            isRunning: false,
            status: 'inreview',
          }}
          variant="canvas"
          onClose={vi.fn()}
        />
      </TooltipProvider>
    );
    expect(container.firstElementChild).toHaveClass('is-reviewing');
    expect(container.firstElementChild).not.toHaveClass('is-running');
  });

  it('applies the canvas window slot color to the shell', () => {
    const { container } = render(
      <TooltipProvider>
        <SessionMonitorCard
          session={createSession()}
          variant="canvas"
          slotIndex={1}
          onClose={vi.fn()}
        />
      </TooltipProvider>
    );
    expect(container.firstElementChild).toHaveClass('canvas-window-slotted');
    expect(container.firstElementChild).toHaveAttribute(
      'style',
      expect.stringContaining('--canvas-window-slot: var(--session-slot-2)')
    );
    expect(container.firstElementChild).toHaveAttribute(
      'style',
      expect.stringContaining('background-color')
    );
  });

  it('collapses from a double-click on the canvas title bar', () => {
    const onClose = vi.fn();
    const { container } = render(
      <TooltipProvider>
        <SessionMonitorCard
          session={createSession()}
          variant="canvas"
          onClose={onClose}
        />
      </TooltipProvider>
    );
    fireEvent.doubleClick(
      container.querySelector('.canvas-card-drag-handle') as HTMLElement
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
