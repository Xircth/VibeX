import { memo, useMemo, useState, type ReactNode } from 'react';
import { Wrench } from 'lucide-react';
import type { MessageTurn, TaskWithAttemptStatus } from 'shared/types';
import type { WorkspaceWithSession } from '@/types/attempt';
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

export const MessageTurnView = memo(function MessageTurnView({
  turn,
  attempt,
  task,
}: {
  turn: MessageTurn;
  attempt: WorkspaceWithSession;
  task: TaskWithAttemptStatus | null;
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
      <div className="conv-entry-item conv-user-turn">
        <div className="conv-user-bubble">
          <Markdown
            value={text}
            taskAttemptId={context.taskAttemptId}
            taskId={context.taskId}
            workspacePath={context.workspacePath}
          />
        </div>
      </div>
    );
  }

  const items = planTurnBlocks(turn.blocks);
  return (
    <div className="conv-entry-item conv-assistant-msg conv-msg-hover group px-4 py-2 text-sm">
      {items.map((item, index) => {
        const key = `${turn.id}-${index}`;
        // Adapt tool_use blocks to VibeX's rich cards; orphan results fall back.
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
      })}
    </div>
  );
});
