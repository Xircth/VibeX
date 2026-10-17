import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Brain, ChevronDown, Loader2 } from 'lucide-react';
import { useExpandable } from '@/stores/useExpandableStore';
import { AstryxMarkdown } from './AstryxMarkdown';
import { cn } from '@/lib/utils';

function conversationScrollerFrom(
  node: EventTarget | null
): HTMLElement | null {
  return node instanceof Element
    ? node.closest('[data-panel="conversation-logs"]')
    : null;
}

export const ThinkingEntry: React.FC<{
  content: string;
  expansionKey: string;
  taskAttemptId?: string;
  taskId?: string;
  workspacePath?: string | null;
  count?: number;
  isStreaming?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  elapsedMs?: number;
}> = ({
  content,
  expansionKey,
  taskAttemptId,
  taskId,
  workspacePath,
  count = 1,
  isStreaming = false,
  onExpandedChange,
}) => {
  const { t } = useTranslation(['conversation']);
  const [expanded, toggle] = useExpandable(
    `thinking:${expansionKey}:${isStreaming ? 'streaming' : 'finished'}`,
    isStreaming
  );
  const forwardWheelToConversation = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      if (!isStreaming) return;
      const scroller = conversationScrollerFrom(event.currentTarget);
      if (!scroller) return;
      scroller.scrollTop += event.deltaY;
      event.preventDefault();
    },
    [isStreaming]
  );

  return (
    <div
      className={cn('conv-thinking', isStreaming && 'conv-thinking-streaming')}
    >
      <button
        type="button"
        className="conv-thinking-header"
        onClick={() => {
          toggle(!expanded);
          onExpandedChange?.(!expanded);
        }}
        aria-expanded={expanded}
        aria-label={expanded ? t('thinking.collapse') : t('thinking.expand')}
      >
        {isStreaming ? (
          <Loader2
            aria-hidden="true"
            className="conv-thinking-spinner h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none"
          />
        ) : (
          <Brain
            aria-hidden="true"
            className="conv-thinking-icon h-3.5 w-3.5 shrink-0"
          />
        )}
        <span
          className={cn(
            'conv-thinking-label',
            isStreaming && 'conv-shimmer-text'
          )}
        >
          {isStreaming ? t('thinking.streaming') : t('thinking.label')}
        </span>
        {count > 1 ? (
          <span className="conv-thinking-count">{count}</span>
        ) : null}
        <ChevronDown
          className={cn(
            'size-3.5 shrink-0 conv-thinking-chevron',
            expanded && 'is-expanded'
          )}
        />
      </button>
      {expanded ? (
        <div
          className="conv-thinking-content"
          onWheel={isStreaming ? forwardWheelToConversation : undefined}
        >
          <AstryxMarkdown
            value={content}
            taskAttemptId={taskAttemptId}
            taskId={taskId}
            workspacePath={workspacePath}
            isStreaming={isStreaming}
          />
        </div>
      ) : null}
    </div>
  );
};
