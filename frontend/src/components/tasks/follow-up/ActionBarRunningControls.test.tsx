import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ActionBarRunningControls } from './ActionBarRunningControls';

function renderRunningControls(
  props: Partial<Parameters<typeof ActionBarRunningControls>[0]> = {}
) {
  return render(
    <ActionBarRunningControls
      isQueueLoading={false}
      isCompactingContext={false}
      isStopping={false}
      hasQueueableContent={true}
      sessionId="session-1"
      onQueueMessage={vi.fn()}
      onStopExecution={vi.fn()}
      {...props}
    />
  );
}

describe('ActionBarRunningControls', () => {
  it('queues another message whenever running content is available', () => {
    const onQueueMessage = vi.fn();
    renderRunningControls({ onQueueMessage });

    fireEvent.click(screen.getByRole('button', { name: '队列' }));

    expect(onQueueMessage).toHaveBeenCalledTimes(1);
  });

  it('shows steering only when the live Agent negotiated it', () => {
    const onSteer = vi.fn();
    const { rerender } = renderRunningControls({
      supportsSteering: false,
      onSteer,
    });
    expect(screen.queryByRole('button', { name: '纠偏' })).toBeNull();

    rerender(
      <ActionBarRunningControls
        isQueueLoading={false}
        isCompactingContext={false}
        isStopping={false}
        supportsSteering={true}
        hasQueueableContent={true}
        sessionId="session-1"
        onQueueMessage={vi.fn()}
        onSteer={onSteer}
        onStopExecution={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: '纠偏' }));
    expect(onSteer).toHaveBeenCalledTimes(1);
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

  it('shows the queue loading state', () => {
    renderRunningControls({ isQueueLoading: true });

    expect(
      screen
        .getByRole('button', { name: '队列' })
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
    expect(runningStopButton).toHaveClass('h-[22.4px]', 'w-[22.4px]');
    expect(
      runningStopButton.querySelector('.lucide-square')
    ).toBeInTheDocument();
    expect(runningStopButton).not.toHaveTextContent('停止');

    fireEvent.click(runningStopButton);
    expect(onStopExecution).toHaveBeenCalledTimes(1);

    rerender(
      <ActionBarRunningControls
        isQueueLoading={false}
        isCompactingContext={false}
        isStopping={true}
        hasQueueableContent={true}
        sessionId="session-1"
        onQueueMessage={vi.fn()}
        onStopExecution={onStopExecution}
      />
    );

    const stopButton = screen.getByRole('button', { name: '停止' });
    expect(stopButton).toBeDisabled();
    expect(stopButton.querySelector('.animate-spin')).toBeInTheDocument();
  });
});
