import React from 'react';
import { Brain, ChevronRight } from 'lucide-react';
import { useExpandable } from '@/stores/useExpandableStore';
import { Markdown } from './Markdown';

/***********************
 * Phase 3: ThinkingEntry — enhanced with left border + collapsible
 ***********************/

export const ThinkingEntry: React.FC<{
  content: string;
  expansionKey: string;
  taskAttemptId?: string;
}> = ({ content, expansionKey }) => {
  const [expanded, toggle] = useExpandable(`thinking:${expansionKey}`, false);

  return (
    <div className="px-4 py-1">
      <div className="conv-thinking">
        <button
          type="button"
          className="conv-thinking-header w-full"
          onClick={() => toggle()}
          title={expanded ? 'Collapse Thinking' : 'Expand Thinking'}
          aria-label={expanded ? 'Collapse Thinking' : 'Expand Thinking'}
        >
          <Brain className="conv-thinking-icon h-3 w-3 shrink-0" />
          <ChevronRight
            className={`h-3 w-3 shrink-0 conv-thinking-chevron ${expanded ? 'is-expanded' : ''}`}
          />
          <span className="truncate">Thinking</span>
        </button>
        {expanded && (
          <div className="conv-thinking-content">
            <Markdown value={content} />
          </div>
        )}
      </div>
    </div>
  );
};
