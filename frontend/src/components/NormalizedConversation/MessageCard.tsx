import React from 'react';
import { ChevronDown } from 'lucide-react';
import { useExpandable } from '@/stores/useExpandableStore';
import { Markdown } from './Markdown';
import type {
  CardVariant,
  CollapsibleVariant,
} from './conversation-entry-utils';

export type MarkdownRenderContext = {
  taskAttemptId?: string;
  taskId?: string;
  workspacePath?: string | null;
};

/*********************
 * Unified card      *
 *********************/

export const MessageCard: React.FC<{
  children: React.ReactNode;
  variant: CardVariant;
  expanded?: boolean;
  onToggle?: () => void;
}> = ({ children, variant, expanded, onToggle }) => {
  const cardClass =
    variant === 'system' ? 'conv-system-card' : 'conv-error-card';
  const textClass =
    variant === 'system' ? 'conv-system-text' : 'conv-error-text';

  return (
    <div className={`w-full ${cardClass}`} onClick={onToggle}>
      <div className="flex items-center gap-1.5">
        <div className={`min-w-0 flex-1 ${textClass}`}>{children}</div>
        {onToggle && (
          <ExpandChevron
            expanded={!!expanded}
            onClick={onToggle}
            variant={variant}
          />
        )}
      </div>
    </div>
  );
};

/************************
 * Expand chevron       *
 ************************/

export const ExpandChevron: React.FC<{
  expanded: boolean;
  onClick: () => void;
  variant: CollapsibleVariant;
}> = ({ expanded, onClick, variant }) => {
  const color =
    variant === 'system' ? 'text-foreground/70' : 'text-destructive';

  return (
    <ChevronDown
      onClick={onClick}
      className={`h-4 w-4 cursor-pointer transition-transform ${color} ${
        expanded ? '' : '-rotate-90'
      }`}
    />
  );
};

/************************
 * Collapsible container *
 ************************/

export const CollapsibleEntry: React.FC<{
  content: string;
  markdown: boolean;
  expansionKey: string;
  variant: CollapsibleVariant;
  contentClassName: string;
  taskAttemptId?: string;
  markdownContext?: MarkdownRenderContext;
}> = ({
  content,
  markdown,
  expansionKey,
  variant,
  contentClassName,
  markdownContext,
}) => {
  const multiline = content.includes('\n');
  const [expanded, toggle] = useExpandable(`entry:${expansionKey}`, false);

  const Inner = (
    <div className={contentClassName}>
      {markdown ? <Markdown value={content} {...markdownContext} /> : content}
    </div>
  );

  const firstLine = content.split('\n')[0];
  const PreviewInner = (
    <div className={contentClassName}>
      {markdown ? (
        <Markdown value={firstLine} {...markdownContext} />
      ) : (
        firstLine
      )}
    </div>
  );

  if (!multiline) {
    return <MessageCard variant={variant}>{Inner}</MessageCard>;
  }

  return expanded ? (
    <MessageCard variant={variant} expanded={expanded} onToggle={toggle}>
      {Inner}
    </MessageCard>
  ) : (
    <MessageCard variant={variant} expanded={expanded} onToggle={toggle}>
      {PreviewInner}
    </MessageCard>
  );
};

export const CompactNoticeEntry: React.FC<{
  content: string;
  variant: CollapsibleVariant;
  title?: string;
}> = ({ content, variant, title }) => {
  const className =
    variant === 'error'
      ? 'conv-compact-notice conv-compact-notice-error'
      : 'conv-compact-notice';

  return (
    <div className={className} title={title ?? content}>
      {content}
    </div>
  );
};

export const ContextCompactStatusEntry: React.FC<{
  content: string;
  status: 'running' | 'success' | 'failed';
}> = ({ content, status }) => (
  <div
    className={`conv-context-compact-status conv-context-compact-status-${status}`}
  >
    <span className="conv-context-compact-status-line" aria-hidden="true" />
    <span className="conv-context-compact-status-text">{content}</span>
    <span className="conv-context-compact-status-line" aria-hidden="true" />
  </div>
);

export const PlainNoticeEntry: React.FC<{
  content: string;
  markdown: boolean;
  className?: string;
  title?: string;
  markdownContext?: MarkdownRenderContext;
}> = ({ content, markdown, className, title, markdownContext }) => (
  <div
    className={`conv-plain-notice${className ? ` ${className}` : ''}`}
    title={title}
  >
    {markdown ? <Markdown value={content} {...markdownContext} /> : content}
  </div>
);

export const AssistantCommandOutputEntry: React.FC<{
  prefix: string;
  output: string;
  expansionKey: string;
  markdownContext?: MarkdownRenderContext;
}> = ({ prefix, output, expansionKey, markdownContext }) => {
  const [expanded, toggle] = useExpandable(
    `assistant-command-output:${expansionKey}`,
    false
  );
  const hasPrefix = prefix.trim().length > 0;

  return (
    <>
      {hasPrefix ? (
        <button
          type="button"
          className="mb-1 inline-flex h-4 w-4 items-center justify-center text-foreground/70 transition-transform"
          onClick={() => toggle()}
          aria-expanded={expanded}
          aria-label={
            expanded
              ? 'Collapse previous AI content'
              : 'Expand previous AI content'
          }
        >
          <ChevronDown
            className={`h-3.5 w-3.5 transition-transform ${
              expanded ? '' : '-rotate-90'
            }`}
          />
        </button>
      ) : null}
      {hasPrefix && expanded ? (
        <div className="mb-2">
          <Markdown value={prefix} {...markdownContext} />
        </div>
      ) : null}
      <Markdown value={output} {...markdownContext} />
    </>
  );
};
