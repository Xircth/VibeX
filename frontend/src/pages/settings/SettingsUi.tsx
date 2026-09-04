import { useId, useRef, type ComponentType, type ReactNode } from 'react';
import { ChevronRight, Loader2, Save, Undo2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { HostGlass } from '@/components/ui/host-glass';

import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { cn } from '@/lib/utils';

/** Static pointer used when motion is reduced: the refraction stays put. */
const STATIC_GLASS_POINTER = { x: 0, y: 0 };

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
              className={`mt-1 text-sm leading-5 ${
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

interface SettingsActionBarProps {
  dirty: boolean;
  saving: boolean;
  onDiscard: () => void;
  onSave: () => void;
  disabled?: boolean;
  message?: string;
  /** Optional failure copy shown under the controls when saving failed. */
  error?: string | null;
}

/**
 * Unified floating save/discard bar for settings pages. Rendered only while
 * there are unsaved changes. The bar is a liquid-glass panel (same material
 * as the Git workspace toolbar, see BranchInfoHeader) that pins to the bottom
 * of the scrolling content area; discard (outline) and save (primary) sit on
 * the right, status copy on the left. The `error` slot renders below the
 * glass so failure copy stays fully readable.
 */
export function SettingsActionBar({
  dirty,
  saving,
  onDiscard,
  onSave,
  disabled = false,
  message,
  error = null,
}: SettingsActionBarProps) {
  const { t } = useTranslation('common');
  const glassStageRef = useRef<HTMLDivElement | null>(null);
  const prefersReducedMotion = useMediaQuery(
    '(prefers-reduced-motion: reduce)'
  );
  if (!dirty) {
    return null;
  }

  return (
    <div className="settings-action-bar" data-testid="settings-action-bar">
      <div ref={glassStageRef} className="settings-action-bar__stage">
        <HostGlass
          className="settings-action-bar__glass"
          padding="0"
          cornerRadius={14}
          displacementScale={72}
          blurAmount={0.16}
          saturation={155}
          /* This wide surface makes the RGB edge split read as a red stripe. */
          aberrationIntensity={0}
          elasticity={prefersReducedMotion ? 0 : 0.12}
          mouseContainer={glassStageRef}
          globalMousePos={
            prefersReducedMotion ? STATIC_GLASS_POINTER : undefined
          }
          mouseOffset={prefersReducedMotion ? STATIC_GLASS_POINTER : undefined}
          mode="prominent"
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            width: '100%',
            height: '100%',
          }}
        >
          <div className="settings-action-bar__inner">
            <span className="settings-action-bar__message">
              {message ?? t('settingsChanged')}
            </span>
            <div className="settings-action-bar__actions">
              <Button
                variant="outline"
                size="sm"
                onClick={onDiscard}
                disabled={saving}
              >
                <Undo2 className="mr-2 h-4 w-4" />
                {t('discard')}
              </Button>
              <Button size="sm" onClick={onSave} disabled={disabled || saving}>
                {saving ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Save className="mr-2 h-4 w-4" />
                )}
                {t('save')}
              </Button>
            </div>
          </div>
        </HostGlass>
      </div>
      {error ? (
        <p className="settings-action-bar__error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
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
