import { useTranslation } from 'react-i18next';
import { useEffect, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import type { AgentSessionConfigOption, AgentSessionMode } from 'shared/types';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  configOptionDisplayState,
  resolvedConfigOptionChoices,
  visibleSessionConfigOptions,
  type DisplayChoice,
} from '@/components/tasks/follow-up/SessionConfigOptionSelectors';
import {
  isDangerousPermissionsMode,
  presentableSessionModes,
  presentedActiveModeId,
} from '@/components/tasks/follow-up/SessionModeSelector';
import { cn } from '@/lib/utils';

/**
 * The create form's session-control fields: the SAME agent-advertised data the
 * composer renders, but as labeled full-width selectors — the form has room,
 * unlike the composer's icon-only bar. Display rules (hidden Default aliases,
 * model-name resolution, mode dedupe) are shared with the composer's
 * components, never re-implemented.
 */
export function SessionControlsFields({
  modes,
  currentModeId,
  configOptions,
  selectedModeId,
  pendingConfigValues,
  onSelectMode,
  onSelectConfigValue,
  disabled = false,
  dropdownSide = 'bottom',
}: {
  modes: AgentSessionMode[];
  /** The agent's last-known active mode id, if any. */
  currentModeId: string | null;
  configOptions: AgentSessionConfigOption[];
  /** The user's pending mode pick for the first turn, if any. */
  selectedModeId: string | null;
  /** Pending per-option picks (key → choice value). */
  pendingConfigValues: Record<string, string>;
  onSelectMode: (modeId: string) => void;
  onSelectConfigValue: (key: string, value: string) => void;
  disabled?: boolean;
  dropdownSide?: 'top' | 'bottom';
}) {
  const { t } = useTranslation(['tasks', 'common']);

  const activeModeId = selectedModeId ?? currentModeId;
  const hasDangerousPermissionsMode = modes.some((mode) =>
    isDangerousPermissionsMode(mode.id)
  );
  const [dangerousOperationsAllowed, setDangerousOperationsAllowed] = useState(
    () => isDangerousPermissionsMode(activeModeId)
  );
  useEffect(() => {
    if (isDangerousPermissionsMode(activeModeId)) {
      setDangerousOperationsAllowed(true);
    }
  }, [activeModeId]);
  const presentableModes = presentableSessionModes(
    modes,
    dangerousOperationsAllowed,
    activeModeId
  );
  const showModeField = presentableModes.length > 0;
  // Same dedupe rule as the composer's ActionBar: when the dedicated mode
  // field is shown, drop the overlapping `mode`-category config option.
  const visibleConfigOptions = visibleSessionConfigOptions(configOptions);
  const dedupedOptions = showModeField
    ? visibleConfigOptions.filter(
        (option) => (option.category ?? option.key) !== 'mode'
      )
    : visibleConfigOptions;

  const presentedModeId = presentedActiveModeId(modes, activeModeId);
  const activeMode =
    presentableModes.find((mode) => mode.id === presentedModeId) ?? null;

  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {showModeField ? (
        <ControlField
          id="mode"
          label={t('sessionModeSelector.title')}
          valueLabel={
            activeMode?.label ?? t('sessionModeSelector.fallbackLabel')
          }
          choices={presentableModes.map((mode) => ({
            value: mode.id,
            name: mode.label,
            description: mode.description,
          }))}
          activeValue={presentedModeId}
          onSelect={onSelectMode}
          disabled={disabled}
          dropdownSide={dropdownSide}
        />
      ) : null}
      {hasDangerousPermissionsMode ? (
        <div className="flex h-8 items-center justify-between rounded-md border border-input bg-background px-3">
          <span className="truncate text-xs">
            {t('sessionModeSelector.allowDangerousOperations', {
              defaultValue: '允许危险操作',
            })}
          </span>
          <Switch
            checked={dangerousOperationsAllowed}
            onCheckedChange={setDangerousOperationsAllowed}
            disabled={disabled}
            aria-label={t('sessionModeSelector.allowDangerousOperations', {
              defaultValue: '允许危险操作',
            })}
          />
        </div>
      ) : null}
      {dedupedOptions.map((option) => {
        if (typeof option.value === 'boolean') {
          return (
            <div
              key={option.key}
              className="flex h-8 items-center justify-between rounded-md border border-input bg-background px-3"
            >
              <span className="truncate text-xs">
                {option.label || t('sessionConfigSelector.fallbackLabel')}
              </span>
              <Switch
                checked={option.value}
                onCheckedChange={(checked) =>
                  onSelectConfigValue(option.key, String(checked))
                }
                disabled={disabled}
                aria-label={
                  option.label || t('sessionConfigSelector.fallbackLabel')
                }
              />
            </div>
          );
        }
        const choices = resolvedConfigOptionChoices(
          option,
          visibleConfigOptions,
          pendingConfigValues
        );
        const { displayChoices, presentedActiveValue } =
          configOptionDisplayState(
            option,
            pendingConfigValues[option.key] ?? null,
            choices
          );
        if (displayChoices.length < 2) return null;
        const activeChoice =
          displayChoices.find(
            (choice) => choice.value === presentedActiveValue
          ) ?? null;
        return (
          <ControlField
            key={option.key}
            id={option.key}
            label={option.label || t('sessionConfigSelector.fallbackLabel')}
            valueLabel={activeChoice?.name ?? ''}
            choices={displayChoices}
            activeValue={presentedActiveValue}
            onSelect={(value) => onSelectConfigValue(option.key, value)}
            disabled={disabled}
            dropdownSide={dropdownSide}
          />
        );
      })}
    </div>
  );
}

function ControlField({
  id,
  label,
  valueLabel,
  choices,
  activeValue,
  onSelect,
  disabled,
  dropdownSide,
}: {
  id: string;
  label: string;
  valueLabel: string;
  choices: DisplayChoice[];
  activeValue: string | null;
  onSelect: (value: string) => void;
  disabled: boolean;
  dropdownSide: 'top' | 'bottom';
}) {
  // No per-field label: the button shows the current choice, the tooltip and
  // the opened menu carry the field's name.
  return (
    <div className="min-w-0">
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full justify-between text-xs"
            disabled={disabled}
            data-testid={`session-control-${id}`}
            title={`${label}: ${valueLabel}`}
            aria-label={`${label}: ${valueLabel}`}
          >
            <span className="truncate">{valueLabel}</span>
            <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side={dropdownSide}
          align="start"
          sideOffset={1}
          className="min-w-[12rem] max-w-[18rem]"
        >
          <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">
            {label}
          </DropdownMenuLabel>
          {choices.map((choice) => {
            const isActive = choice.value === activeValue;
            return (
              <DropdownMenuItem
                key={choice.value}
                onSelect={() => onSelect(choice.value)}
                className={cn('justify-between', isActive && 'bg-accent')}
                title={choice.description ?? undefined}
              >
                <span className="truncate">{choice.name}</span>
                <Check
                  className={cn(
                    'h-3.5 w-3.5 shrink-0',
                    isActive ? 'opacity-100' : 'opacity-0'
                  )}
                />
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
