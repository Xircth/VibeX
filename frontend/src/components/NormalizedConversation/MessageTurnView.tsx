import { memo, useState, type ReactNode } from 'react';
import { Wrench } from 'lucide-react';
import type { MessageTurn } from 'shared/types';
import { Markdown } from './Markdown';
import { ThinkingEntry } from './ThinkingEntry';
import { ToolCardShell } from './tools/ToolCardShell';
import { TimelinePlanCard } from './TimelinePlanCard';
import {
  planTurnBlocks,
  type ToolResultBlock,
  type ToolUseBlock,
  type TurnRenderItem,
} from './messageTurnBlocks';

/**
 * Renders one unified-timeline `MessageTurn` (codeg-aligned model) by mapping its
 * content blocks onto VibeX's existing block components (Markdown, ThinkingEntry,
 * tool card). User turns render as a bubble; assistant/system turns render their
 * blocks inline. Rich diff/file/command cards are intentionally deferred — the
 * parser's `ContentBlock` carries only a generic tool name + previews, so tools
 * render through the shared `ToolCardShell`. VibeX-authored.
 */

export interface MessageTurnContext {
  taskAttemptId?: string;
  taskId?: string;
  workspacePath?: string | null;
}

const EMPTY_TOOL_IDS: ReadonlySet<string> = new Set();

function ToolBlockCard({
  use,
  result,
  inProgress,
  context,
}: {
  use: ToolUseBlock | null;
  result: ToolResultBlock | null;
  inProgress: boolean;
  context: MessageTurnContext;
}) {
  const [expanded, setExpanded] = useState(false);
  const isError = result?.is_error ?? false;
  const pending = !result && inProgress;

  const statusClassName = isError
    ? 'conv-tool-card-error'
    : pending
      ? 'conv-tool-card-pending'
      : '';
  const statusDotClassName = isError
    ? 'conv-tool-dot conv-tool-dot-error'
    : pending
      ? 'conv-tool-dot conv-tool-dot-pending'
      : '';

  const output = result?.output_preview ?? null;

  return (
    <ToolCardShell
      icon={<Wrench className="h-3.5 w-3.5" />}
      label={use?.tool_name ?? 'tool'}
      detail={use?.input_preview ?? undefined}
      statusClassName={statusClassName}
      statusDotClassName={statusDotClassName}
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
  context: MessageTurnContext,
  inProgress: ReadonlySet<string>
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
      return (
        <ToolBlockCard
          key={key}
          use={item.use}
          result={item.result}
          inProgress={
            item.use?.tool_use_id ? inProgress.has(item.use.tool_use_id) : false
          }
          context={context}
        />
      );
  }
}

export const MessageTurnView = memo(function MessageTurnView({
  turn,
  context,
  inProgressToolCallIds,
}: {
  turn: MessageTurn;
  context: MessageTurnContext;
  inProgressToolCallIds?: ReadonlySet<string>;
}) {
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

  const inProgress = inProgressToolCallIds ?? EMPTY_TOOL_IDS;
  const items = planTurnBlocks(turn.blocks);
  return (
    <div className="conv-entry-item conv-assistant-msg conv-msg-hover group px-4 py-2 text-sm">
      {items.map((item, index) =>
        renderItem(item, `${turn.id}-${index}`, context, inProgress)
      )}
    </div>
  );
});
