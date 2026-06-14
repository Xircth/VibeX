import type { ComponentType, ReactNode } from 'react';
import { Loader2, Save, Undo2 } from 'lucide-react';

import { Button } from '@/components/ui/button';

interface SettingsPageHeaderProps {
  title: string;
  description?: string;
}

/**
 * Page-level title/description header. Intentionally renders nothing: each
 * settings page is reached via the sidebar item that already names it, so the
 * in-page heading was redundant. Kept as a no-op so call sites stay valid.
 */
export function SettingsPageHeader(_props: SettingsPageHeaderProps) {
  return null;
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
}: SettingsSectionProps) {
  return (
    <section className="settings-section space-y-3">
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <Icon className="h-4 w-4 text-muted-foreground" />
            <span>{title}</span>
          </h3>
          {description ? (
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      <div
        className={`settings-card overflow-hidden rounded-lg border${
          className ? ` ${className}` : ''
        }`}
      >
        {children}
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
}

export function SettingsActionBar({
  dirty,
  saving,
  onDiscard,
  onSave,
  disabled = false,
  message = '设置已修改，保存后生效。',
}: SettingsActionBarProps) {
  if (!dirty) {
    return null;
  }

  return (
    <div className="settings-action-bar">
      <span>{message}</span>
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={onDiscard}
          disabled={saving}
        >
          <Undo2 className="mr-2 h-4 w-4" />
          放弃
        </Button>
        <Button size="sm" onClick={onSave} disabled={disabled || saving}>
          {saving ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Save className="mr-2 h-4 w-4" />
          )}
          保存
        </Button>
      </div>
    </div>
  );
}
