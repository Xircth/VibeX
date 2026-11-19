import { useId, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

export function ConversationStatusDetailsTrigger({
  title,
  label,
  accessibleLabel,
  expanded,
  controlsId,
  onToggle,
}: {
  title: string;
  label: string;
  accessibleLabel?: string;
  expanded: boolean;
  controlsId: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="composer-status-disclosure"
      aria-label={accessibleLabel ?? `${label}: ${title}`}
      aria-expanded={expanded}
      aria-controls={controlsId}
      onClick={onToggle}
    >
      <span>{label}</span>
      <ChevronDown
        className={cn('h-3.5 w-3.5', expanded && 'is-expanded')}
        aria-hidden="true"
      />
    </button>
  );
}

export function ConversationStatusDetailsContent({
  id,
  mono = false,
  children,
}: {
  id: string;
  mono?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      id={id}
      className={cn('composer-status-details', mono && 'font-mono')}
    >
      {children}
    </div>
  );
}

export function ConversationStatusDetails({
  title,
  label,
  accessibleLabel,
  children,
  mono = false,
}: {
  title: string;
  label: string;
  accessibleLabel?: string;
  children: ReactNode;
  mono?: boolean;
}) {
  const detailsId = useId();
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="composer-status-details-section">
      <ConversationStatusDetailsTrigger
        title={title}
        label={label}
        accessibleLabel={accessibleLabel}
        expanded={expanded}
        controlsId={detailsId}
        onToggle={() => setExpanded((current) => !current)}
      />
      {expanded ? (
        <ConversationStatusDetailsContent id={detailsId} mono={mono}>
          {children}
        </ConversationStatusDetailsContent>
      ) : null}
    </div>
  );
}
