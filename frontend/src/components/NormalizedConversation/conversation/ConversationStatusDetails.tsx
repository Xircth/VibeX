import { useId, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

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
      <button
        type="button"
        className="composer-status-disclosure"
        aria-label={accessibleLabel ?? `${label}: ${title}`}
        aria-expanded={expanded}
        aria-controls={detailsId}
        onClick={() => setExpanded((current) => !current)}
      >
        <span>{label}</span>
        <ChevronDown
          className={cn('h-3.5 w-3.5', expanded && 'is-expanded')}
          aria-hidden="true"
        />
      </button>
      {expanded ? (
        <div
          id={detailsId}
          className={cn('composer-status-details', mono && 'font-mono')}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}
