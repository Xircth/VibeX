import { memo, useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, RotateCcw, Wrench } from 'lucide-react';
import type { MessageTurn, TaskWithAttemptStatus } from 'shared/types';
import type { WorkspaceWithSession } from '@/types/attempt';
import { cn } from '@/lib/utils';
import { useExpandable } from '@/stores/useExpandableStore';
import { Markdown } from './Markdown';
import { ThinkingEntry } from './ThinkingEntry';
import { ToolCardShell } from './tools/ToolCardShell';
import { TimelinePlanCard } from './TimelinePlanCard';
import DisplayConversationEntry from './DisplayConversationEntry';
import { toolBlockToNormalizedEntry } from './messageTurnTool';
import {
  planTurnBlocks,
  type ToolResultBlock,
  type TurnRenderItem,
} from './messageTurnBlocks';

export interface MessageTurnContext {
  taskAttemptId?: string;
  taskId?: string;
  workspacePath?: string | null;
}

function OrphanToolResultCard({
  result,
  context,
}: {
  result: ToolResultBlock | null;
  context: MessageTurnContext;
}) {
  const [expanded, setExpanded] = useState(false);
  const output = result?.output_preview ?? null;
  const isError = result?.is_error ?? false;
  return (
    <ToolCardShell
      icon={<Wrench className="h-3.5 w-3.5" />}
      label="tool result"
      statusClassName={isError ? 'conv-tool-card-error' : ''}
      statusDotClassName={isError ? 'conv-tool-dot conv-tool-dot-error' : ''}
      expandable={Boolean(output)}
      expanded={expanded}
      onToggle={() => setExpanded((value) => !value)}
    >
      {output ? (
        <Markdown
          value={output}
          taskAttemptId={context.taskAttemptId}
          taskId={context.taskId}
          workspacePath={context.workspacePath}
        />
      ) : null}
    </ToolCardShell>
  );
}

function renderItem(
  item: TurnRenderItem,
  key: string,
  context: MessageTurnContext
): ReactNode {
  switch (item.kind) {
    case 'markdown':
      return (
        <Markdown
          key={key}
          value={item.text}
          taskAttemptId={context.taskAttemptId}
          taskId={context.taskId}
          workspacePath={context.workspacePath}
        />
      );
    case 'thinking':
      return (
        <ThinkingEntry
          key={key}
          content={item.text}
          expansionKey={key}
          taskAttemptId={context.taskAttemptId}
        />
      );
    case 'image':
      return (
        <img
          key={key}
          className="conv-image"
          src={item.uri ?? `data:${item.mimeType};base64,${item.data}`}
          alt=""
        />
      );
    case 'image_generation':
      return item.image ? (
        <img
          key={key}
          className="conv-image"
          src={
            item.image.uri ??
            `data:${item.image.mime_type};base64,${item.image.data}`
          }
          alt={item.revisedPrompt ?? ''}
        />
      ) : (
        <div key={key} className="conv-tool-card conv-tool-card-pending">
          Generating image...
        </div>
      );
    case 'plan':
      return <TimelinePlanCard key={key} entries={item.entries} />;
    case 'tool':
      return (
        <OrphanToolResultCard key={key} result={item.result} context={context} />
      );
  }
}

function CollapsedProcessGroup({
  turnId,
  items,
  renderItem: render,
}: {
  turnId: string;
  items: TurnRenderItem[];
  renderItem: (item: TurnRenderItem, key: string) => ReactNode;
}) {
  const [expanded, toggle] = useExpandable(`process:${turnId}`, false);
  return (
    <div className="conv-collapsed-process px-1 py-1">
      <button
        type="button"
        onClick={() => toggle()}
        className="inline-flex items-center gap-1 text-[11px] text-muted-foreground"
        aria-expanded={expanded}
      >
        <ChevronDown
          className={cn(
            'h-3.5 w-3.5 transition-transform',
            expanded ? '' : '-rotate-90'
          )}
        />
        <span>Collapsed {items.length} process messages</span>
      </button>
      {expanded
        ? items.map((item, index) =>
            render(item, `${turnId}-prelude-${index}`)
          )
        : null}
    </div>
  );
}

export const MessageTurnView = memo(function MessageTurnView({
  turn,
  attempt,
  task,
  onRetry,
  collapseProcess = false,
}: {
  turn: MessageTurn;
  attempt: WorkspaceWithSession;
  task: TaskWithAttemptStatus | null;
  onRetry?: () => void;
  collapseProcess?: boolean;
}) {
  const context = useMemo<MessageTurnContext>(
    () => ({
      taskAttemptId: attempt.id,
      taskId: task?.id ?? attempt.task_id ?? undefined,
      workspacePath: attempt.container_ref,
    }),
    [attempt.container_ref, attempt.id, attempt.task_id, task?.id]
  );

  if (turn.role === 'user') {
    const text = turn.blocks
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n\n');
    return (
      <div className="conv-entry-item conv-user-turn group relative">
        <div className="conv-user-bubble">
          <Markdown
            value={text}
            taskAttemptId={context.taskAttemptId}
            taskId={context.taskId}
            workspacePath={context.workspacePath}
          />
        </div>
        {onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            className="conv-copy-btn absolute right-1 top-1 rounded p-1 text-muted-foreground hover:text-foreground"
            title="Retry: optionally restore files before resending"
            aria-label="Retry"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
    );
  }

  const renderTurnItem = (item: TurnRenderItem, key: string): ReactNode => {
    if (item.kind === 'tool' && item.use) {
      return (
        <DisplayConversationEntry
          key={key}
          entry={toolBlockToNormalizedEntry(
            item.use,
            item.result,
            turn.timestamp
          )}
          expansionKey={key}
          taskAttempt={attempt}
          task={task ?? undefined}
        />
      );
    }
    return renderItem(item, key, context);
  };

  const items = planTurnBlocks(turn.blocks);
  let body: ReactNode[];

  if (collapseProcess) {
    const lastTextIndex = items.reduce(
      (acc, item, index) => (item.kind === 'markdown' ? index : acc),
      -1
    );
    const collapsibleEnd = lastTextIndex >= 0 ? lastTextIndex : items.length;
    const prelude = items.slice(0, collapsibleEnd);
    const rest = items.slice(collapsibleEnd);
    body = [
      ...(prelude.length > 0
        ? [
            <CollapsedProcessGroup
              key={`${turn.id}-collapsed`}
              turnId={turn.id}
              items={prelude}
              renderItem={renderTurnItem}
            />,
          ]
        : []),
      ...rest.map((item, index) =>
        renderTurnItem(item, `${turn.id}-${collapsibleEnd + index}`)
      ),
    ];
  } else {
    body = items.map((item, index) =>
      renderTurnItem(item, `${turn.id}-${index}`)
    );
  }

  return (
    <div className="conv-entry-item conv-assistant-msg conv-msg-hover group px-4 py-2 text-sm">
      {body}
    </div>
  );
});
