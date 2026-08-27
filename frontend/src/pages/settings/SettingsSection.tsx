import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

export function AgentSectionHeading({
  headingId,
  title,
  expanded,
  onToggle,
  summary,
  children,
}: {
  headingId: string;
  title: string;
  expanded?: boolean;
  onToggle?: () => void;
  summary?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="agent-section-heading">
      {onToggle ? (
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
      ) : (
        <h3 id={headingId}>{title}</h3>
      )}
      {children}
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
    <section
      className="settings-surface overflow-hidden"
      aria-labelledby={headingId}
    >
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
