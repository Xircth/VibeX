import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ActionBarRunningControls } from './ActionBarRunningControls';

function renderRunningControls(
  props: Partial<Parameters<typeof ActionBarRunningControls>[0]> = {}
) {
  return render(
    <ActionBarRunningControls
      isStopping={false}
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

  it('keeps only stop next to a running turn', () => {
    renderRunningControls();

    expect(screen.queryByRole('button', { name: '插入当前回合' })).toBeNull();
    expect(
      screen.queryByRole('button', { name: '发给 Agent 查阅' })
    ).toBeNull();
    expect(screen.queryByRole('button', { name: '纠偏' })).toBeNull();
    expect(screen.getByRole('button', { name: '停止' })).toBeInTheDocument();
  });

  it('stops execution and shows stopping state', () => {
    const onStopExecution = vi.fn();
    const { rerender } = renderRunningControls({ onStopExecution });

    const runningStopButton = screen.getByRole('button', { name: '停止' });
    expect(runningStopButton).toHaveClass('h-8', 'w-8');
    expect(
      runningStopButton.querySelector('.lucide-square')
    ).toBeInTheDocument();
    expect(runningStopButton).not.toHaveTextContent('停止');

    fireEvent.click(runningStopButton);
    expect(onStopExecution).toHaveBeenCalledTimes(1);

    rerender(
      <ActionBarRunningControls
        isStopping={true}
        onStopExecution={onStopExecution}
      />
    );

    const stopButton = screen.getByRole('button', { name: '停止' });
    expect(stopButton).toBeDisabled();
    expect(stopButton.querySelector('.animate-spin')).toBeInTheDocument();
  });
});
