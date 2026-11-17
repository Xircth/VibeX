import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function AgentSectionHeading({
  headingId,
  title,
  titleAddon,
  description,
  expanded,
  onToggle,
  summary,
  children,
  className,
  togglePosition = 'trailing',
}: {
  headingId: string;
  title: string;
  titleAddon?: ReactNode;
  description?: ReactNode;
  expanded?: boolean;
  onToggle?: () => void;
  summary?: ReactNode;
  children?: ReactNode;
  className?: string;
  togglePosition?: 'leading' | 'trailing';
}) {
  const trailingToggle = Boolean(onToggle && togglePosition === 'trailing');
  const hasActions = Boolean(children || trailingToggle);
  const actionsNode = hasActions ? (
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
            className={
              expanded
                ? 'h-4 w-4 rotate-180 transition-transform duration-150'
                : 'h-4 w-4 transition-transform duration-150'
            }
          />
        </Button>
      ) : null}
    </div>
  ) : null;

  if (description) {
    return (
      <div className={cn('agent-section-heading has-description', className)}>
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
            {titleAddon}
            {!expanded && summary ? (
              <span className="agent-section-summary" aria-hidden="true">
                {summary}
              </span>
            ) : null}
          </button>
        ) : (
          <div className="agent-section-heading-title-row">
            <h3 id={headingId}>{title}</h3>
            {titleAddon}
            {!expanded && summary ? (
              <span className="agent-section-summary">{summary}</span>
            ) : null}
          </div>
        )}
        <div className="agent-section-heading-subrow">
          <p className="agent-section-description">{description}</p>
          {actionsNode}
        </div>
      </div>
    );
  }

  return (
    <div className={cn('agent-section-heading', className)}>
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
          {titleAddon}
          {!expanded && summary ? (
            <span className="agent-section-summary" aria-hidden="true">
              {summary}
            </span>
          ) : null}
        </button>
      ) : trailingToggle || titleAddon ? (
        <div className="agent-section-heading-title-row">
          <h3 id={headingId}>{title}</h3>
          {titleAddon}
          {!expanded && summary ? (
            <span className="agent-section-summary">{summary}</span>
          ) : null}
        </div>
      ) : (
        <h3 id={headingId}>{title}</h3>
      )}
      {actionsNode}
    </div>
  );
}

export function SettingsSection({
  id,
  title,
  description,
  expanded = true,
  onToggle,
  action,
  summary,
  children,
}: {
  id: string;
  title: string;
  description?: ReactNode;
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
        description={description}
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
