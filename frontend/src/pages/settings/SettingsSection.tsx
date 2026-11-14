import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function AgentSectionHeading({
  headingId,
  title,
  expanded,
  onToggle,
  summary,
  children,
  togglePosition = 'leading',
}: {
  headingId: string;
  title: string;
  expanded?: boolean;
  onToggle?: () => void;
  summary?: ReactNode;
  children?: ReactNode;
  togglePosition?: 'leading' | 'trailing';
}) {
  const trailingToggle = Boolean(onToggle && togglePosition === 'trailing');
  return (
    <div className="agent-section-heading">
      {onToggle && !trailingToggle ? (
        <button
          type="button"
          className="agent-section-heading-toggle"
          aria-expanded={expanded}
          aria-controls={headingId ? `${headingId}-body` : undefined}
          aria-label={title}
          onClick={onToggle}
        >
          <ChevronDown
            aria-hidden="true"
            className="agent-config-file-chevron"
          />
          <h3 id={headingId}>{title}</h3>
          {!expanded && summary ? (
            <span className="agent-section-summary" aria-hidden="true">
              {summary}
            </span>
          ) : null}
        </button>
      ) : trailingToggle ? (
        <div className="flex min-w-0 items-center gap-2">
          <h3 id={headingId}>{title}</h3>
          {!expanded && summary ? (
            <span className="agent-section-summary">{summary}</span>
          ) : null}
        </div>
      ) : (
        <h3 id={headingId}>{title}</h3>
      )}
      {children || trailingToggle ? (
        <div className="agent-section-heading-actions">
          {children}
          {trailingToggle ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={title}
              aria-expanded={expanded}
              aria-controls={headingId ? `${headingId}-body` : undefined}
              onClick={onToggle}
            >
              <ChevronDown
                aria-hidden="true"
                className={expanded ? 'h-4 w-4 rotate-180' : 'h-4 w-4'}
              />
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function SettingsSection({
  id,
  title,
  expanded = true,
  onToggle,
  action,
  summary,
  children,
}: {
  id: string;
  title: string;
  icon?: unknown;
  expanded?: boolean;
  onToggle?: () => void;
  action?: ReactNode;
  summary?: ReactNode;
  children: ReactNode;
}) {
  const headingId = `agent-settings-${id}`;
  const bodyId = `${headingId}-body`;

  return (
    <section className="agent-flat-section" aria-labelledby={headingId}>
      <AgentSectionHeading
        headingId={headingId}
        title={title}
        expanded={expanded}
        onToggle={onToggle}
        summary={summary}
      >
        {action}
      </AgentSectionHeading>
      {expanded ? (
        <div id={bodyId} className="agent-section-body">
          {children}
        </div>
      ) : null}
    </section>
  );
}
