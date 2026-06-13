import { useCallback } from 'react';
import type { FC } from 'react';
import type { NormalizedEntry } from 'shared/types.ts';
import type { ProcessStartPayload } from '@/types/logs';
import { Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScriptFixerDialog } from '@/components/dialogs/scripts/ScriptFixerDialog';
import { useAttemptRepo } from '@/hooks/useAttemptRepo';
import { getScriptType } from './conversation-entry-utils';
import { CommandToolCard } from './tools/CommandToolCard';
import { FileToolCard } from './tools/FileToolCard';
import { GenericToolCard } from './tools/GenericToolCard';
import { SearchToolCard } from './tools/SearchToolCard';
import {
  AskQuestionResultCard,
  isAskQuestionToolEntry,
} from './tools/AskQuestionResultCard';
import {
  FeedbackCheckResultCard,
  isFeedbackCheckToolEntry,
} from './tools/FeedbackCheckResultCard';
import {
  GeneratedImagesBlock,
  isGeneratedImageToolEntry,
} from './tools/GeneratedImagesBlock';
import { GoalToolCall, isGoalToolEntry } from './tools/GoalToolCall';
import { PlanCard, isPlanToolEntry } from './tools/PlanCard';

function isNormalizedEntry(
  entry: NormalizedEntry | ProcessStartPayload
): entry is NormalizedEntry {
  return 'entry_type' in entry;
}

export const LookupToolCallCard: FC<{
  entry: NormalizedEntry;
  expansionKey: string;
  forceExpanded?: boolean;
  containerRef?: string | null;
}> = ({ entry, expansionKey, forceExpanded = false, containerRef }) => {
  const toolEntry =
    entry.entry_type.type === 'tool_use' ? entry.entry_type : null;
  const action = toolEntry?.action_type.action;

  if (action === 'file_read') {
    return (
      <FileToolCard
        entry={entry}
        expansionKey={expansionKey}
        forceExpanded={forceExpanded}
        containerRef={containerRef}
      />
    );
  }

  if (action === 'search' || action === 'web_fetch') {
    return (
      <SearchToolCard
        entry={entry}
        expansionKey={expansionKey}
        forceExpanded={forceExpanded}
      />
    );
  }

  return null;
};

export const ToolCallCard: FC<{
  entry: NormalizedEntry | ProcessStartPayload;
  expansionKey: string;
  forceExpanded?: boolean;
  taskAttemptId?: string;
}> = ({ entry, expansionKey, forceExpanded = false, taskAttemptId }) => {
  if (!isNormalizedEntry(entry)) {
    return (
      <GenericToolCard
        entry={entry}
        expansionKey={expansionKey}
        forceExpanded={forceExpanded}
        taskAttemptId={taskAttemptId}
      />
    );
  }

  const toolEntry =
    entry.entry_type.type === 'tool_use' ? entry.entry_type : null;
  const action = toolEntry?.action_type.action;

  if (isPlanToolEntry(entry)) {
    return (
      <PlanCard
        entry={entry}
        expansionKey={expansionKey}
        forceExpanded={forceExpanded}
        taskAttemptId={taskAttemptId}
      />
    );
  }

  if (action === 'command_run') {
    return (
      <CommandToolCard
        entry={entry}
        expansionKey={expansionKey}
        forceExpanded={forceExpanded}
        defaultExpanded={toolEntry?.tool_name === 'Tool Install Script'}
        linkifyUrls={toolEntry?.tool_name === 'Tool Install Script'}
      />
    );
  }

  if (action === 'file_read' || action === 'search' || action === 'web_fetch') {
    return (
      <LookupToolCallCard
        entry={entry}
        expansionKey={expansionKey}
        forceExpanded={forceExpanded}
      />
    );
  }

  if (isGeneratedImageToolEntry(entry)) {
    return <GeneratedImagesBlock entry={entry} taskAttemptId={taskAttemptId} />;
  }

  if (isGoalToolEntry(entry)) {
    return <GoalToolCall entry={entry} />;
  }

  if (isAskQuestionToolEntry(entry)) {
    return (
      <AskQuestionResultCard entry={entry} expansionKey={expansionKey} />
    );
  }

  if (isFeedbackCheckToolEntry(entry)) {
    return <FeedbackCheckResultCard entry={entry} />;
  }

  return (
    <GenericToolCard
      entry={entry}
      expansionKey={expansionKey}
      forceExpanded={forceExpanded}
      defaultExpanded={action === 'task_create'}
      taskAttemptId={taskAttemptId}
    />
  );
};

export const ScriptToolCallCard: FC<{
  entry: NormalizedEntry | ProcessStartPayload;
  expansionKey: string;
  taskAttemptId?: string;
  sessionId?: string;
  isFailed: boolean;
  toolName: string;
  forceExpanded?: boolean;
}> = ({
  entry,
  expansionKey,
  taskAttemptId,
  sessionId,
  isFailed,
  toolName,
  forceExpanded = false,
}) => {
  const { repos } = useAttemptRepo(taskAttemptId);

  const handleFix = useCallback(() => {
    if (!taskAttemptId || repos.length === 0) return;

    const scriptType = getScriptType(toolName);

    ScriptFixerDialog.show({
      scriptType,
      repos,
      workspaceId: taskAttemptId,
      sessionId,
      initialRepoId: repos.length === 1 ? repos[0].id : undefined,
    });
  }, [toolName, taskAttemptId, sessionId, repos]);

  const canFix = taskAttemptId && repos.length > 0 && isFailed;

  return (
    <div className="flex items-start gap-2">
      <div className="flex-1">
        <ToolCallCard
          entry={entry}
          expansionKey={expansionKey}
          forceExpanded={forceExpanded}
          taskAttemptId={taskAttemptId}
        />
      </div>
      {canFix ? (
        <Button
          variant="outline"
          size="sm"
          onClick={handleFix}
          className="shrink-0 gap-1"
        >
          <Wrench className="h-3 w-3" />
          {'Fix Script'}
        </Button>
      ) : null}
    </div>
  );
};
