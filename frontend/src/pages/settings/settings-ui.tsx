import type { ComponentType, ReactNode } from 'react';
import { Loader2, Save, Undo2 } from 'lucide-react';

import { Button } from '@/components/ui/button';

interface SettingsPageHeaderProps {
  title: string;
  description?: string;
}

export function SettingsPageHeader({
  title,
  description,
}: SettingsPageHeaderProps) {
  return (
    <div className="settings-page-header">
      <h2>{title}</h2>
      {description ? <p>{description}</p> : null}
    </div>
  );
}

interface SettingsSectionProps {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}

export function SettingsSection({
  icon: Icon,
  title,
  description,
  children,
  className,
}: SettingsSectionProps) {
  return (
    <section className={`settings-card${className ? ` ${className}` : ''}`}>
      <div className="settings-card__header">
        <div>
          <h3 className="flex items-center gap-2">
            <Icon className="h-4 w-4" />
            <span>{title}</span>
          </h3>
          {description ? <p>{description}</p> : null}
        </div>
      </div>
      {children}
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
