import { ExecutionProcessStatus } from 'shared/types';
import { describe, expect, it } from 'vitest';
import { getConversationScriptDisplay } from './conversationScriptDisplay';
import type { ExecutionProcessState, PatchTypeWithKey } from './types';
import type { ExecutionProcess, NormalizedEntry, ScriptContext } from 'shared/types';

function scriptAction(context: ScriptContext, script = 'pnpm test') {
  return {
    typ: {
      type: 'ScriptRequest',
      script,
      language: 'Bash',
      context,
      working_dir: null,
    },
    next_action: null,
  } as const;
}

function storedEntry(content: string, index: number): PatchTypeWithKey {
  return {
    type: 'NORMALIZED_ENTRY',
    content: {
      entry_type: { type: 'assistant_message' },
      content,
      timestamp: null,
    },
    patchKey: `process-1:${index}`,
    executionProcessId: 'process-1',
  };
}

function processState(
  context: ScriptContext,
  entries: PatchTypeWithKey[] = [storedEntry('line 1', 0)]
): ExecutionProcessState {
  return {
    executionProcess: {
      id: 'process-1',
      created_at: '2026-03-22T00:00:00.000Z',
      updated_at: '2026-03-22T00:00:00.000Z',
      executor_action: scriptAction(context),
    },
    entries,
  };
}

function liveProcess(
  status: ExecutionProcessStatus,
  exitCode: bigint | null
): ExecutionProcess {
  return {
    id: 'process-1',
    session_id: 'session-1',
    run_reason: 'setupscript',
    executor_action: scriptAction('SetupScript'),
    status,
    exit_code: exitCode,
    dropped: false,
    started_at: '2026-03-22T00:00:00.000Z',
    completed_at:
      status === ExecutionProcessStatus.running
        ? null
        : '2026-03-22T00:00:05.000Z',
    created_at: '2026-03-22T00:00:00.000Z',
    updated_at: '2026-03-22T00:00:05.000Z',
  };
}

function normalizedContent(
  display: NonNullable<ReturnType<typeof getConversationScriptDisplay>>
): NormalizedEntry {
  const { content } = display.entry;
  if (typeof content === 'string' || !('entry_type' in content)) {
    throw new Error('Expected a normalized script display entry');
  }
  return content;
}

describe('conversationScriptDisplay', () => {
  it.each([
    ['SetupScript', 'Setup Script'],
    ['CleanupScript', 'Cleanup Script'],
    ['ArchiveScript', 'Archive Script'],
    ['ToolInstallScript', 'Tool Install Script'],
  ] as const)('labels %s entries as %s', (context, label) => {
    const display = getConversationScriptDisplay(
      processState(context),
      liveProcess(ExecutionProcessStatus.completed, BigInt(0))
    );

    expect(display).not.toBeNull();
    expect(normalizedContent(display!).entry_type).toMatchObject({
      type: 'tool_use',
      tool_name: label,
    });
    expect(normalizedContent(display!).content).toBe(label);
  });

  it('suppresses dev-server script requests from conversation history', () => {
    expect(
      getConversationScriptDisplay(
        processState('DevServer'),
        liveProcess(ExecutionProcessStatus.running, null)
      )
    ).toBeNull();
  });

  it('marks running scripts as created with no exit status', () => {
    const display = getConversationScriptDisplay(
      processState('SetupScript'),
      liveProcess(ExecutionProcessStatus.running, null)
    );

    expect(display?.isRunning).toBe(true);
    expect(display?.isFailedOrKilled).toBe(false);
    expect(display).not.toBeNull();
    expect(normalizedContent(display!).entry_type).toMatchObject({
      status: { status: 'created' },
      action_type: {
        result: {
          exit_status: null,
        },
      },
    });
  });

  it('uses non-zero completed exit codes as failed tool status', () => {
    const display = getConversationScriptDisplay(
      processState('SetupScript', [
        storedEntry('line 1', 0),
        storedEntry('line 2', 1),
      ]),
      liveProcess(ExecutionProcessStatus.completed, BigInt(7))
    );

    expect(display?.isRunning).toBe(false);
    expect(display?.isFailedOrKilled).toBe(false);
    expect(display).not.toBeNull();
    expect(normalizedContent(display!).entry_type).toMatchObject({
      status: { status: 'failed' },
      action_type: {
        action: 'command_run',
        command: 'pnpm test',
        result: {
          output: '[object Object]\n[object Object]',
          exit_status: {
            type: 'exit_code',
            code: 7,
          },
        },
      },
    });
  });

  it('flags failed live processes while keeping exit-code-based tool status', () => {
    const display = getConversationScriptDisplay(
      processState('SetupScript'),
      liveProcess(ExecutionProcessStatus.failed, BigInt(0))
    );

    expect(display?.isFailedOrKilled).toBe(true);
    expect(display).not.toBeNull();
    expect(normalizedContent(display!).entry_type).toMatchObject({
      status: { status: 'success' },
    });
  });

  it('preserves the missing-live-process success fallback', () => {
    const display = getConversationScriptDisplay(
      processState('SetupScript'),
      undefined
    );

    expect(display?.isRunning).toBe(false);
    expect(display?.isFailedOrKilled).toBe(false);
    expect(display).not.toBeNull();
    expect(normalizedContent(display!).entry_type).toMatchObject({
      status: { status: 'success' },
      action_type: {
        result: {
          exit_status: {
            type: 'exit_code',
            code: 0,
          },
        },
      },
    });
  });
});
