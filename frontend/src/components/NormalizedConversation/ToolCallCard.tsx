import { useCallback } from 'react';
import type { FC } from 'react';
import type { NormalizedEntry } from 'shared/types.ts';
import type { ProcessStartPayload } from '@/types/logs';
import { Check, ChevronDown, Circle, CircleDot, Wrench } from 'lucide-react';
import WYSIWYGEditor from '@/components/ui/wysiwyg';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ScriptFixerDialog } from '@/components/dialogs/scripts/ScriptFixerDialog';
import { useAttemptRepo } from '@/hooks/useAttemptRepo';
import { useExpandable } from '@/stores/useExpandableStore';
import {
  getScriptType,
  type ToolStatusAppearance,
} from './conversation-entry-utils';
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
import { UnifiedDiffPreview } from './tools/UnifiedDiffPreview';

type ParsedPlanItem = {
  status: string;
  priority: string | null;
  content: string;
};

const PLAN_ITEM_PATTERN =
  /^\s*(?:\d+[.)]|[-*])\s+\[([^\]|]+)(?:\s*\|\s*([^\]]+))?\]\s+(.+?)\s*$/;

function isNormalizedEntry(
  entry: NormalizedEntry | ProcessStartPayload
): entry is NormalizedEntry {
  return 'entry_type' in entry;
}

function parsePlanItems(plan: string): ParsedPlanItem[] {
  return plan
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(PLAN_ITEM_PATTERN);
      if (!match?.[1] || !match?.[3]) {
        return null;
      }

      return {
        status: match[1].trim(),
        priority: match[2]?.trim() || null,
        content: match[3].trim(),
      } satisfies ParsedPlanItem;
    })
    .filter((item): item is ParsedPlanItem => Boolean(item));
}

function getPlanStatusIcon(status: string) {
  const normalized = status.toLowerCase().replace(/-/g, '_');
  if (normalized === 'completed' || normalized === 'done') {
    return <Check className="h-3.5 w-3.5 text-green-600" />;
  }
  if (normalized === 'in_progress' || normalized === 'inprogress') {
    return <CircleDot className="h-3.5 w-3.5 text-blue-600" />;
  }
  return <Circle className="h-3.5 w-3.5 text-muted-foreground" />;
}

export const LookupToolCallCard: FC<{
  entry: NormalizedEntry;
  expansionKey: string;
  statusAppearance?: ToolStatusAppearance;
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

  const fileEditAction = toolEntry?.action_type;
  if (fileEditAction?.action === 'file_edit') {
    return (
      <div className="space-y-3">
        {fileEditAction.changes.map((change, index) => (
          <UnifiedDiffPreview
            key={`${fileEditAction.path}:${index}`}
            path={fileEditAction.path}
            change={change}
            expansionKey={`diff:${expansionKey}:${index}`}
            forceExpanded={forceExpanded}
          />
        ))}
      </div>
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
    return <GeneratedImagesBlock entry={entry} />;
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

export const PlanPresentationCard: FC<{
  plan: string;
  expansionKey: string;
  defaultExpanded?: boolean;
  statusAppearance?: ToolStatusAppearance;
  taskAttemptId?: string;
}> = ({ plan, expansionKey, defaultExpanded = false, taskAttemptId }) => {
  const [expanded, toggle] = useExpandable(
    `plan-entry:${expansionKey}`,
    defaultExpanded
  );
  const planItems = parsePlanItems(plan);

  return (
    <div className="w-full">
      <button
        type="button"
        onClick={(event) => {
          event.preventDefault();
          toggle();
        }}
        title={expanded ? 'Hide plan' : 'Show plan'}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-sm conv-tool-card"
      >
        <span className="shrink-0 conv-tool-icon">
          <CircleDot className="h-3 w-3" />
        </span>
        <span className="conv-tool-label shrink-0">Plan</span>
        <span className="conv-tool-detail truncate min-w-0">
          {planItems[0]?.content ?? 'Plan updated'}
        </span>
        <div className="ml-auto flex items-center gap-2 shrink-0">
          <ChevronDown
            className={cn(
              'h-3.5 w-3.5 text-muted-foreground transition-transform',
              expanded ? '' : '-rotate-90'
            )}
          />
        </div>
      </button>

      {expanded ? (
        <div className="conv-tool-details text-xs">
          {planItems.length > 0 ? (
            <ol className="space-y-1.5 font-sans">
              {planItems.map((item, index) => (
                <li
                  key={`${item.status}:${item.content}:${index}`}
                  className="flex items-start gap-2 rounded-md px-2 py-1.5 text-sm"
                >
                  <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
                    {getPlanStatusIcon(item.status)}
                  </span>
                  <span className="min-w-0 flex-1 break-words text-foreground">
                    {item.content}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <div className="conv-tool-details-content font-sans text-sm">
              <WYSIWYGEditor
                value={plan}
                disabled
                className="whitespace-pre-wrap break-words"
                taskAttemptId={taskAttemptId}
              />
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
};
