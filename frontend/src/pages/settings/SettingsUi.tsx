import { useRef, type ComponentType, type ReactNode } from 'react';
import { Loader2, Save, Undo2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import LiquidGlass from 'liquid-glass-react';

import { Button } from '@/components/ui/button';
import { useMediaQuery } from '@/hooks/useMediaQuery';

/** Static pointer used when motion is reduced: the refraction stays put. */
const STATIC_GLASS_POINTER = { x: 0, y: 0 };

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
        <LiquidGlass
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
        </LiquidGlass>
      </div>
      {error ? (
        <p className="settings-action-bar__error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
