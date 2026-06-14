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

/**
 * Renders one unified-timeline `MessageTurn` (codeg-aligned model) by mapping its
 * content blocks onto VibeX's existing components: text/output -> Markdown,
 * thinking -> ThinkingEntry, plan -> TimelinePlanCard, images inline, and tool
 * calls -> the full VibeX tool cards (via an adapter to NormalizedEntry +
 * DisplayConversationEntry) so file/search/command/generic cards render exactly
 * as before. User turns render as a bubble. VibeX-authored.
 */

export interface MessageTurnContext {
  taskAttemptId?: string;
  taskId?: string;
  workspacePath?: string | null;
}

/** Fallback card for an orphan tool_result (no matching tool_use to adapt). */
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
          Generating image…
        </div>
      );
    case 'plan':
      return <TimelinePlanCard key={key} entries={item.entries} />;
    case 'tool':
      // tool_use blocks are adapted + rendered in the parent; only orphan
      // results reach here.
      return <OrphanToolResultCard key={key} result={item.result} context={context} />;
  }
}

/**
 * The legacy "整组过程消息折叠成一行" behavior: a run of process items (thinking,
 * tools, intermediate text before the turn's final answer) collapses into one
 * "已折叠 N 条过程消息" line, expandable. Keyed expand state survives virtual
 * scrolling. Only used when the user's `ai_message_default_collapsed` is on.
 */
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
        <span>已折叠 {items.length} 条过程消息</span>
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
  /** When set (user turns), shows a retry affordance (optional rollback + resend). */
  onRetry?: () => void;
  /** Collapse a turn's process items before its final answer into one line. */
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
            title="重试:可选回滚工作区到本条消息前并重发"
            aria-label="重试"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
    );
  }

  // Renders one item: tool_use blocks become VibeX's rich cards (via the adapter
  // + DisplayConversationEntry); everything else goes through renderItem.
  const renderTurnItem = (item: TurnRenderItem, key: string): ReactNode => {
    if (item.kind === 'tool' && item.use) {
      return (
        <DisplayConversationEntry
          key={key}
          entry={toolBlockToNormalizedEntry(item.use, item.result, turn.timestamp)}
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
    // Collapse everything before the turn's final answer (its last text block) —
    // matches the legacy prelude-collapsing.
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
    body = items.map((item, index) => renderTurnItem(item, `${turn.id}-${index}`));
  }

  return (
    <div className="conv-entry-item conv-assistant-msg conv-msg-hover group px-4 py-2 text-sm">
      {body}
    </div>
  );
});
