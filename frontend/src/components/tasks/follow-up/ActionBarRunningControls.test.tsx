import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ActionBarRunningControls } from './ActionBarRunningControls';

function renderRunningControls(
  props: Partial<Parameters<typeof ActionBarRunningControls>[0]> = {}
) {
  return render(
    <ActionBarRunningControls
      isQueued={false}
      isQueueLoading={false}
      isCompactingContext={false}
      isStopping={false}
      hasQueueableContent={true}
      sessionId="session-1"
      onQueueMessage={vi.fn()}
      onCancelQueue={vi.fn()}
      onStopExecution={vi.fn()}
      {...props}
    />
  );
}

describe('ActionBarRunningControls', () => {
  it('queues a message when running, not queued, and content is available', () => {
    const onQueueMessage = vi.fn();
    renderRunningControls({ onQueueMessage });

    fireEvent.click(screen.getByRole('button', { name: '队列' }));

    expect(onQueueMessage).toHaveBeenCalledTimes(1);
  });

  it('disables queueing without a session id or queueable content', () => {
    const onQueueMessage = vi.fn();
    renderRunningControls({
      sessionId: undefined,
      hasQueueableContent: false,
      onQueueMessage,
    });

    const queueButton = screen.getByRole('button', { name: '队列' });
    expect(queueButton).toBeDisabled();

    fireEvent.click(queueButton);
    expect(onQueueMessage).not.toHaveBeenCalled();
  });

  it('cancels an existing queued message', () => {
    const onCancelQueue = vi.fn();
    renderRunningControls({ isQueued: true, onCancelQueue });

    fireEvent.click(screen.getByRole('button', { name: '取消队列' }));

    expect(onCancelQueue).toHaveBeenCalledTimes(1);
  });

  it('shows queue loading state for queue and cancel actions', () => {
    const { rerender } = renderRunningControls({ isQueueLoading: true });

    expect(
      screen
        .getByRole('button', { name: '队列' })
        .querySelector('.animate-spin')
    ).toBeInTheDocument();

    rerender(
      <ActionBarRunningControls
        isQueued={true}
        isQueueLoading={true}
        isCompactingContext={false}
        isStopping={false}
        hasQueueableContent={true}
        sessionId="session-1"
        onQueueMessage={vi.fn()}
        onCancelQueue={vi.fn()}
        onStopExecution={vi.fn()}
      />
    );

    expect(
      screen
        .getByRole('button', { name: '取消队列' })
        .querySelector('.animate-spin')
    ).toBeInTheDocument();
  });

  it('hides queue controls while compacting but keeps stop available', () => {
    renderRunningControls({ isCompactingContext: true });

    expect(screen.queryByRole('button', { name: '队列' })).toBeNull();
    expect(screen.getByRole('button', { name: '停止' })).toBeInTheDocument();
  });

  it('stops execution and shows stopping state', () => {
    const onStopExecution = vi.fn();
    const { rerender } = renderRunningControls({ onStopExecution });

    const runningStopButton = screen.getByRole('button', { name: '停止' });
    expect(
      runningStopButton.querySelector('.lucide-square')
    ).toBeInTheDocument();
    expect(runningStopButton).not.toHaveTextContent('停止');

    fireEvent.click(runningStopButton);
    expect(onStopExecution).toHaveBeenCalledTimes(1);

    rerender(
      <ActionBarRunningControls
        isQueued={false}
        isQueueLoading={false}
        isCompactingContext={false}
        isStopping={true}
        hasQueueableContent={true}
        sessionId="session-1"
        onQueueMessage={vi.fn()}
        onCancelQueue={vi.fn()}
        onStopExecution={onStopExecution}
      />
    );

    const stopButton = screen.getByRole('button', { name: '停止' });
    expect(stopButton).toBeDisabled();
    expect(stopButton.querySelector('.animate-spin')).toBeInTheDocument();
  });
});
