import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Brain, ChevronRight } from 'lucide-react';
import { useExpandable } from '@/stores/useExpandableStore';
import { AstryxMarkdown } from './AstryxMarkdown';

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function useThinkingElapsed(isStreaming: boolean, elapsedMs?: number) {
  const startRef = useRef(Date.now());
  const [liveSeconds, setLiveSeconds] = useState(0);

  useEffect(() => {
    if (!isStreaming || typeof elapsedMs === 'number') return;

    const interval = window.setInterval(() => {
      setLiveSeconds(Math.floor((Date.now() - startRef.current) / 1000));
    }, 1000);

    return () => window.clearInterval(interval);
  }, [elapsedMs, isStreaming]);

  if (typeof elapsedMs === 'number') {
    return Math.max(0, Math.floor(elapsedMs / 1000));
  }

  return isStreaming ? liveSeconds : null;
}

export const ThinkingEntry: React.FC<{
  content: string;
  expansionKey: string;
  taskAttemptId?: string;
  isStreaming?: boolean;
  elapsedMs?: number;
}> = ({ content, expansionKey, isStreaming = false, elapsedMs }) => {
  const { t } = useTranslation(['conversation', 'common']);
  const [expanded, toggle] = useExpandable(
    `thinking:${expansionKey}`,
    isStreaming
  );
  const elapsedSeconds = useThinkingElapsed(isStreaming, elapsedMs);
  const statusText = isStreaming
    ? t('thinking.statusThinking')
    : t('thinking.statusCompleted');
  const elapsedText = useMemo(
    () =>
      typeof elapsedSeconds === 'number' ? formatElapsed(elapsedSeconds) : null,
    [elapsedSeconds]
  );

  return (
    <div className="px-4 py-1">
      <div
        className={`conv-thinking ${isStreaming ? 'conv-thinking-streaming' : ''}`}
      >
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
          <span className="conv-thinking-status">{statusText}</span>
          {elapsedText ? (
            <span className="conv-thinking-elapsed">{elapsedText}</span>
          ) : null}
        </button>
        {expanded && (
          <div className="conv-thinking-content">
            <AstryxMarkdown value={content} />
          </div>
        )}
      </div>
    </div>
  );
};
