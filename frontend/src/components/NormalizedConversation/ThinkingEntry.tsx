import React from 'react';
import { useTranslation } from 'react-i18next';
import { Brain, ChevronDown } from 'lucide-react';
import { useExpandable } from '@/stores/useExpandableStore';
import { AstryxMarkdown } from './AstryxMarkdown';

export const ThinkingEntry: React.FC<{
  content: string;
  expansionKey: string;
  taskAttemptId?: string;
  isStreaming?: boolean;
  elapsedMs?: number;
}> = ({ content, expansionKey, isStreaming = false }) => {
  const { t } = useTranslation(['conversation']);
  const [expanded, toggle] = useExpandable(
    `thinking:${expansionKey}`,
    isStreaming
  );

  return (
    <div
      className={`conv-thinking ${isStreaming ? 'conv-thinking-streaming' : ''}`}
    >
      <button
        type="button"
        className="conv-thinking-header"
        onClick={() => toggle()}
        aria-expanded={expanded}
        aria-label={expanded ? t('thinking.collapse') : t('thinking.expand')}
      >
        <Brain className="conv-thinking-icon h-3.5 w-3.5 shrink-0" />
        <span>{t('thinking.label')}</span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 conv-thinking-chevron ${
            expanded ? 'is-expanded' : ''
          }`}
        />
      </button>
      {expanded ? (
        <div className="conv-thinking-content">
          <AstryxMarkdown value={content} />
        </div>
      ) : null}
    </div>
  );
};
