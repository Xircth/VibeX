import { describe, expect, it } from 'vitest';
import {
  ExecutionProcessStatus,
  type ExecutionProcess,
} from 'shared/types';
import { getConversationReloadPlan } from './conversationReloadPlan';

function process(
  id: string,
  status: ExecutionProcessStatus
): ExecutionProcess {
  return {
    id,
    session_id: 'session-1',
    run_reason: 'setupscript',
    executor_action: {
      typ: {
        type: 'ScriptRequest',
        script: `echo ${id}`,
        language: 'Bash',
        context: 'SetupScript',
        working_dir: null,
      },
      next_action: null,
    },
    status,
    exit_code: status === ExecutionProcessStatus.completed ? 0n : null,
    dropped: false,
    started_at: '2026-05-26T00:00:00.000Z',
    completed_at:
      status === ExecutionProcessStatus.running
        ? null
        : '2026-05-26T00:00:05.000Z',
    created_at: '2026-05-26T00:00:00.000Z',
    updated_at: '2026-05-26T00:00:05.000Z',
  };
}

describe('conversationReloadPlan', () => {
  it('plans displayed running-to-stopped processes for reload and stopped-state emit', () => {
    const stopped = process('process-1', ExecutionProcessStatus.completed);
    const plan = getConversationReloadPlan({
      processes: [stopped],
      displayedProcessIds: new Set(['process-1']),
      previousStatusMap: new Map([
        ['process-1', ExecutionProcessStatus.running],
      ]),
      loadingHistoricProcessIds: new Set(),
      loadedInitialEntries: true,
    });

    expect(plan.processesToReload).toEqual([stopped]);
    expect(plan.lateHistoricProcesses).toEqual([]);
    expect(plan.shouldEmitStoppedState).toBe(true);
    expect(plan.loadingHistoricProcessIdsToAdd).toEqual([]);
    expect(plan.nextPreviousStatuses).toEqual([
      ['process-1', ExecutionProcessStatus.completed],
    ]);
  });

  it('does not treat non-displayed stopped processes as live stream stops', () => {
    const stopped = process('process-1', ExecutionProcessStatus.completed);
    const plan = getConversationReloadPlan({
      processes: [stopped],
      displayedProcessIds: new Set(),
      previousStatusMap: new Map([
        ['process-1', ExecutionProcessStatus.running],
      ]),
      loadingHistoricProcessIds: new Set(),
      loadedInitialEntries: false,
    });

    expect(plan.processesToReload).toEqual([]);
    expect(plan.shouldEmitStoppedState).toBe(false);
  });

  it('plans undisplayed stopped processes as late historic loads after initial load', () => {
    const late = process('process-late', ExecutionProcessStatus.completed);
    const plan = getConversationReloadPlan({
      processes: [late],
      displayedProcessIds: new Set(),
      previousStatusMap: new Map(),
      loadingHistoricProcessIds: new Set(),
      loadedInitialEntries: true,
    });

    expect(plan.lateHistoricProcesses).toEqual([late]);
    expect(plan.loadingHistoricProcessIdsToAdd).toEqual(['process-late']);
  });

  it('suppresses late historic loads that are already loading or still running', () => {
    const alreadyLoading = process(
      'process-loading',
      ExecutionProcessStatus.completed
    );
    const running = process('process-running', ExecutionProcessStatus.running);
    const plan = getConversationReloadPlan({
      processes: [alreadyLoading, running],
      displayedProcessIds: new Set(),
      previousStatusMap: new Map(),
      loadingHistoricProcessIds: new Set(['process-loading']),
      loadedInitialEntries: true,
    });

    expect(plan.lateHistoricProcesses).toEqual([]);
    expect(plan.loadingHistoricProcessIdsToAdd).toEqual([]);
    expect(plan.nextPreviousStatuses).toEqual([
      ['process-loading', ExecutionProcessStatus.completed],
      ['process-running', ExecutionProcessStatus.running],
    ]);
  });
});
