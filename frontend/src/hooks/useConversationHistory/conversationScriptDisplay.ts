import {
  ExecutionProcess,
  ExecutionProcessStatus,
  NormalizedEntry,
  PatchType,
  ScriptContext,
  ToolStatus,
} from 'shared/types';
import type { ExecutionProcessState, PatchTypeWithKey } from './types';

type ConversationScriptDisplay = {
  entry: PatchTypeWithKey;
  isRunning: boolean;
  isFailedOrKilled: boolean;
};

function getScriptToolName(context: ScriptContext): string | null {
  switch (context) {
    case 'SetupScript':
      return 'Setup Script';
    case 'CleanupScript':
      return 'Cleanup Script';
    case 'ArchiveScript':
      return 'Archive Script';
    case 'ToolInstallScript':
      return 'Tool Install Script';
    case 'DevServer':
      return null;
  }
}

export function getConversationScriptDisplay(
  processState: ExecutionProcessState,
  liveProcess: ExecutionProcess | undefined
): ConversationScriptDisplay | null {
  const scriptRequest = processState.executionProcess.executor_action.typ;
  if (scriptRequest.type !== 'ScriptRequest') {
    return null;
  }

  const toolName = getScriptToolName(scriptRequest.context);
  if (!toolName) {
    return null;
  }

  const isRunning = liveProcess?.status === ExecutionProcessStatus.running;
  const isFailedOrKilled =
    liveProcess?.status === ExecutionProcessStatus.failed ||
    liveProcess?.status === ExecutionProcessStatus.killed;
  const exitCode = Number(liveProcess?.exit_code) || 0;
  const exit_status = isRunning
    ? null
    : {
        type: 'exit_code' as const,
        code: exitCode,
      };
  const toolStatus: ToolStatus = isRunning
    ? { status: 'created' }
    : exitCode === 0
      ? { status: 'success' }
      : { status: 'failed' };
  const output = processState.entries.map((line) => line.content).join('\n');

  const toolNormalizedEntry: NormalizedEntry = {
    entry_type: {
      type: 'tool_use',
      tool_name: toolName,
      action_type: {
        action: 'command_run',
        command: scriptRequest.script,
        result: {
          output,
          exit_status,
        },
      },
      status: toolStatus,
    },
    content: toolName,
    timestamp: null,
  };
  const toolPatch: PatchType = {
    type: 'NORMALIZED_ENTRY',
    content: toolNormalizedEntry,
  };

  return {
    entry: {
      ...toolPatch,
      patchKey: `${processState.executionProcess.id}:0`,
      executionProcessId: processState.executionProcess.id,
    },
    isRunning,
    isFailedOrKilled,
  };
}
