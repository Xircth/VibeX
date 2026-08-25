import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { EditorType, type EditorConfig } from 'shared/types';

import { IdeIcon } from '@/components/ide/IdeIcon';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { configApi } from '@/lib/api';
import { cn } from '@/lib/utils';

type EditorOption = {
  value: EditorType;
  label: string;
  hint: string;
};

const isMac =
  typeof navigator !== 'undefined' &&
  navigator.platform.toLowerCase().includes('mac');

export function ExternalEditorPicker({
  value,
  onChange,
  className,
  compact = false,
  modal = true,
  selectTriggerClassName,
  selectContentClassName,
}: {
  value: EditorConfig;
  onChange: (editor: EditorConfig) => void;
  className?: string;
  compact?: boolean;
  modal?: boolean;
  selectTriggerClassName?: string;
  selectContentClassName?: string;
}) {
  const { t } = useTranslation(['settings', 'common']);
  const options = useMemo<EditorOption[]>(
    () => [
      { value: EditorType.VS_CODE, label: 'Visual Studio Code', hint: 'code' },
      {
        value: EditorType.VS_CODE_INSIDERS,
        label: 'VS Code Insiders',
        hint: 'code-insiders',
      },
      { value: EditorType.CURSOR, label: 'Cursor', hint: 'cursor' },
      { value: EditorType.WINDSURF, label: 'Windsurf', hint: 'windsurf' },
      { value: EditorType.INTELLI_J, label: 'IntelliJ IDEA', hint: 'idea' },
      { value: EditorType.ZED, label: 'Zed', hint: 'zed' },
      { value: EditorType.XCODE, label: 'Xcode', hint: 'xed' },
      {
        value: EditorType.GOOGLE_ANTIGRAVITY,
        label: 'Google Antigravity',
        hint: 'antigravity',
      },
      {
        value: EditorType.FILE_MANAGER,
        label: isMac
          ? t('general.editorFinder')
          : t('general.editorFileExplorer'),
        hint: t('general.editorFileManagerHint'),
      },
      {
        value: EditorType.CUSTOM,
        label: t('general.editorCustomCommand'),
        hint: t('general.editorCustomCommand'),
      },
    ],
    [t]
  );
  const [availability, setAvailability] = useState<
    Partial<Record<EditorType, boolean>>
  >({});

  useEffect(() => {
    let active = true;
    void Promise.all(
      options
        .filter((option) => option.value !== EditorType.CUSTOM)
        .map(async (option) => {
          try {
            const result = await configApi.checkEditorAvailability(
              option.value
            );
            return [option.value, result.available] as const;
          } catch {
            return [option.value, false] as const;
          }
        })
    ).then((entries) => {
      if (active) setAvailability(Object.fromEntries(entries));
    });
    return () => {
      active = false;
    };
  }, [options]);

  const selected = options.find((option) => option.value === value.editor_type);
  const selectedAvailability =
    value.editor_type === EditorType.CUSTOM
      ? null
      : availability[value.editor_type];

  return (
    <div className={cn('space-y-4', className)}>
      <div className="settings-row">
        <div>
          <Label htmlFor="external-editor-picker">
            {t('general.externalEditorLabel')}
          </Label>
          {!compact ? (
            <p className="settings-row__description">
              {selectedAvailability === false
                ? t('general.editorNotInPath')
                : t('general.editorSelectHint')}
            </p>
          ) : null}
        </div>
        <Select
          modal={modal}
          value={value.editor_type}
          onValueChange={(editorType) =>
            onChange({
              ...value,
              editor_type: editorType as EditorType,
              custom_command:
                editorType === EditorType.CUSTOM ? value.custom_command : null,
            })
          }
        >
          <SelectTrigger
            id="external-editor-picker"
            className={cn('!w-64', selectTriggerClassName)}
          >
            <SelectValue placeholder={t('general.selectEditorPlaceholder')} />
          </SelectTrigger>
          <SelectContent
            align="start"
            className={cn('max-h-80', selectContentClassName)}
          >
            {options.map((option) => {
              const optionAvailability =
                option.value === EditorType.CUSTOM
                  ? null
                  : availability[option.value];
              return (
                <SelectItem key={option.value} value={option.value}>
                  <span className="flex min-w-0 items-center gap-2">
                    <IdeIcon
                      editorType={option.value}
                      className="h-4 w-4 shrink-0"
                    />
                    <span className="truncate">{option.label}</span>
                    {optionAvailability === true ? (
                      <Check
                        className="h-3.5 w-3.5 shrink-0 text-success"
                        aria-label={t('general.editorReadySuffix')}
                      />
                    ) : optionAvailability === false ? (
                      <AlertCircle
                        className="h-3.5 w-3.5 shrink-0 text-warning"
                        aria-label={t('general.editorNotFoundSuffix')}
                      />
                    ) : null}
                  </span>
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      </div>

      {!compact && selected && value.editor_type !== EditorType.CUSTOM ? (
        <p className="text-[11px] text-muted-foreground">
          {t('general.commandLabel')}
          <code className="font-mono">{selected.hint}</code>
          {selectedAvailability === true
            ? t('general.editorReadySuffix')
            : selectedAvailability === false
              ? t('general.editorNotFoundSuffix')
              : ''}
        </p>
      ) : null}

      {value.editor_type === EditorType.CUSTOM ? (
        <div className="settings-row settings-row--stacked">
          <div>
            <Label htmlFor="custom-editor-command">
              {t('general.customEditorCommand')}
            </Label>
            <p className="settings-row__description">
              {t('general.customEditorCommandHint')}
            </p>
          </div>
          <Input
            id="custom-editor-command"
            placeholder={t('general.customEditorCommandPlaceholder')}
            value={value.custom_command || ''}
            onChange={(event) =>
              onChange({
                ...value,
                custom_command: event.target.value || null,
              })
            }
          />
        </div>
      ) : null}
    </div>
  );
}
