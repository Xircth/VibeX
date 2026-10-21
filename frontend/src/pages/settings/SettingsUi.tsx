import { useId, type ComponentType, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

export function SettingsPageHeader({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <header className="settings-page-header">
      <h2>{title}</h2>
      {description ? <p>{description}</p> : null}
    </header>
  );
}

interface SettingsSectionProps {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  children: ReactNode;
  /** Optional extra classes applied to the content card. */
  className?: string;
  /** Optional action rendered on the right side of the group label. */
  action?: ReactNode;
  /** Optional contrast override for the explanatory copy. */
  descriptionClassName?: string;
  /** Render children without the default settings-card wrapper. */
  bare?: boolean;
  /** Omit this section's label when a parent disclosure already names it. */
  headerless?: boolean;
}

/**
 * Grouped settings section. The label (icon + title + description) sits OUTSIDE
 * the content card so the card holds only the actual settings — matching the
 * native macOS grouped-form pattern used across the app.
 */
export function SettingsSection({
  icon: Icon,
  title,
  description,
  children,
  className,
  action,
  descriptionClassName,
  bare = false,
  headerless = false,
}: SettingsSectionProps) {
  const content = bare ? (
    <div className={className}>{children}</div>
  ) : (
    <div
      className={`settings-card overflow-hidden rounded-lg border${
        className ? ` ${className}` : ''
      }`}
    >
      {children}
    </div>
  );

  if (headerless) return content;

  return (
    <section className="settings-section space-y-3">
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <Icon className="h-4 w-4 text-muted-foreground" />
            <span>{title}</span>
          </h3>
          {description ? (
            <p
              className={`mt-1 text-xs leading-5 ${
                descriptionClassName ?? 'text-muted-foreground'
              }`}
            >
              {description}
            </p>
          ) : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      {content}
    </section>
  );
}

export function SettingsDisclosure({
  icon: Icon,
  title,
  expanded,
  onToggle,
  leading,
  detail,
  children,
}: {
  icon?: ComponentType<{ className?: string }>;
  title: string;
  expanded: boolean;
  onToggle: () => void;
  leading?: ReactNode;
  detail?: ReactNode;
  children: ReactNode;
}) {
  const bodyId = useId();

  return (
    <section className="settings-section">
      <div className="settings-card overflow-hidden rounded-lg border">
        <button
          type="button"
          className="settings-disclosure-trigger"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={onToggle}
        >
          <span className="flex min-w-0 items-center gap-2">
            {leading}
            {Icon ? (
              <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
            ) : null}
            <span className="truncate text-sm font-semibold">{title}</span>
            {detail}
          </span>
          <ChevronRight
            className={cn(
              'h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-150 ease-out',
              expanded && 'rotate-90'
            )}
            aria-hidden="true"
          />
        </button>
        {expanded ? (
          <div id={bodyId} className="settings-disclosure-body">
            {children}
          </div>
        ) : null}
      </div>
    </section>
  );
}

export function AgentLockedSurface({
  locked,
  children,
}: {
  locked: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation('settings');
  if (!locked) return children;
  return (
    <div
      className="agent-settings-locked"
      onClickCapture={(event) => {
        event.preventDefault();
        event.stopPropagation();
        toast.warning(t('agents.installAgentFirst'));
      }}
    >
      {children}
    </div>
  );
}
