import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ActionBarRunningControls } from './ActionBarRunningControls';

function renderRunningControls(
  props: Partial<Parameters<typeof ActionBarRunningControls>[0]> = {}
) {
  return render(
    <ActionBarRunningControls
      isCompactingContext={false}
      isStopping={false}
      hasQueueableContent={true}
      sessionId="session-1"
      onStopExecution={vi.fn()}
      {...props}
    />
  );
}

describe('ActionBarRunningControls', () => {
  it('does not show a queue action while a turn is running', () => {
    renderRunningControls();

    expect(screen.queryByRole('button', { name: '队列' })).toBeNull();
    expect(screen.getByRole('button', { name: '停止' })).toBeInTheDocument();
  });

  it('offers native insert only when a native channel is live', () => {
    const onSteer = vi.fn();
    const { rerender } = renderRunningControls({
      steeringChannel: null,
      onSteer,
    });
    expect(screen.queryByRole('button', { name: '插入当前回合' })).toBeNull();

    rerender(
      <ActionBarRunningControls
        isCompactingContext={false}
        isStopping={false}
        steeringChannel="native"
        hasQueueableContent={true}
        sessionId="session-1"
        onSteer={onSteer}
        onStopExecution={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: '插入当前回合' })).toBeEnabled();
  });

  it('labels the pull channel as a note the Agent will read', () => {
    renderRunningControls({
      steeringChannel: 'pull',
      onSteer: vi.fn(),
    });
    expect(
      screen.getByRole('button', { name: '发给 Agent 查阅' })
    ).toBeEnabled();
  });

  it('hides steer controls while compacting but keeps stop available', () => {
    renderRunningControls({
      isCompactingContext: true,
      steeringChannel: 'native',
      onSteer: vi.fn(),
    });

    expect(screen.queryByRole('button', { name: '插入当前回合' })).toBeNull();
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
        isCompactingContext={false}
        isStopping={true}
        hasQueueableContent={true}
        sessionId="session-1"
        onStopExecution={onStopExecution}
      />
    );

    const stopButton = screen.getByRole('button', { name: '停止' });
    expect(stopButton).toBeDisabled();
    expect(stopButton.querySelector('.animate-spin')).toBeInTheDocument();
  });
});
