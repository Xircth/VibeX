import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AsyncTaskRecord } from 'shared/types';
import {
  extractBackgroundedTaskId,
  groupConsecutiveBackgroundTasks,
  isToolCallBackgrounded,
  liveAsyncTasks,
  parseBackgroundPollTaskId,
} from '@/lib/asyncTasks';
import { toast } from '@/components/ui/toast';
import { SessionAsyncTaskBar } from './SessionAsyncTaskBar';

vi.mock('@/components/ui/toast', () => ({
  toast: {
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

function makeTask(overrides: Partial<AsyncTaskRecord> = {}): AsyncTaskRecord {
  return {
    id: 'task-1',
    task_type: 'bash',
    state: 'running',
    name: 'pnpm run dev',
    phase: 'listening',
    current_agent: null,
    last_tool_name: null,
    output_file_path: '/tmp/task-1.log',
    tool_call_id: 'call-1',
    can_stop: true,
    usage: { total_tokens: 1_500n, tool_uses: 2n, duration_ms: 5_000n },
    ...overrides,
  };
}

describe('asyncTasks helpers and SessionAsyncTaskBar', () => {
  it('filters liveAsyncTasks and checks strict backgrounded===true', () => {
    const running = makeTask({ id: 't1', state: 'running' });
    const completed = makeTask({ id: 't2', state: 'completed' });
    const stopped = makeTask({ id: 't3', state: 'stopped' });
    expect(liveAsyncTasks([running, completed, stopped])).toEqual([running]);

    expect(
      isToolCallBackgrounded({
        jetbrains: {
          air: { asyncTasks: { backgrounded: true, taskId: 't1' } },
        },
      })
    ).toBe(true);
    expect(
      isToolCallBackgrounded({
        jetbrains: {
          air: { asyncTasks: { backgrounded: 'true', taskId: 't1' } },
        },
      })
    ).toBe(false);
    expect(
      extractBackgroundedTaskId({
        jetbrains: {
          air: { asyncTasks: { backgrounded: true, taskId: 't1' } },
        },
      })
    ).toBe('t1');
  });

  it('groups consecutive background poll calls for the same taskId', () => {
    const a = {
      tool_name: 'TaskOutput',
      input_preview: JSON.stringify({ task_id: 'bg-1' }),
    };
    const b = {
      tool_name: 'TaskOutput',
      input_preview: JSON.stringify({ task_id: 'bg-1' }),
    };
    const c = {
      tool_name: 'Read',
      input_preview: JSON.stringify({ file_path: 'foo.ts' }),
    };
    expect(parseBackgroundPollTaskId(a)).toBe('bg-1');
    const grouped = groupConsecutiveBackgroundTasks([a, b, c], (item) =>
      parseBackgroundPollTaskId(item)
    );
    expect(grouped).toHaveLength(2);
    expect(grouped[0]).toEqual({
      kind: 'poll_group',
      taskId: 'bg-1',
      items: [a, b],
    });
    expect(grouped[1]).toEqual({ kind: 'single', item: c });
  });

  it('renders live tasks and handles stop action including false receipt toast', async () => {
    const onStopTask = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    render(
      <SessionAsyncTaskBar
        tasks={[makeTask()]}
        sessionBindReady={true}
        onStopTask={onStopTask}
      />
    );

    expect(screen.getByTestId('session-async-task-bar')).toBeInTheDocument();
    expect(screen.getByText('pnpm run dev')).toBeInTheDocument();

    const stopBtn = screen.getByTestId('session-async-task-stop-task-1');
    fireEvent.click(stopBtn);
    await waitFor(() => {
      expect(onStopTask).toHaveBeenCalledWith('task-1');
      expect(toast.error).toHaveBeenCalled();
    });
  });
});
