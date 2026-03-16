import React from 'react';
import { Brain, ChevronRight } from 'lucide-react';
import { useExpandable } from '@/stores/useExpandableStore';
import { Markdown } from './Markdown';
import { extractThinkingTitle } from './conversation-entry-utils';

/***********************
 * Phase 3: ThinkingEntry — enhanced with left border + collapsible
 ***********************/

export const ThinkingEntry: React.FC<{
  content: string;
  expansionKey: string;
  taskAttemptId?: string;
}> = ({ content, expansionKey }) => {
  const title = extractThinkingTitle(content);
  const [expanded, toggle] = useExpandable(`thinking:${expansionKey}`, false);

  return (
    <div className="px-4 py-1.5">
      <div className="conv-thinking">
        <div className="conv-thinking-header" onClick={() => toggle()}>
          <Brain className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--conv-thinking-border)' }} />
          <ChevronRight
            className={`h-3 w-3 shrink-0 conv-thinking-chevron ${expanded ? 'is-expanded' : ''}`}
          />
          <span className="truncate">
            {title ?? '思考中...'}
          </span>
        </div>
        {expanded && (
          <div className="conv-thinking-content">
            <Markdown value={content} />
          </div>
        )}
      </div>
    </div>
  );
};
