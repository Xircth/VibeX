import { Check, ChevronDown } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentSessionConfigOption, AgentSessionMode } from 'shared/types';
import type { ConversationSessionModesState } from '@/features/conversation/conversationStore';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { EffortSlider } from '@/components/tasks/effort-slider/EffortSlider';
import {
  configOptionDisplayState,
  jsonValueToString,
  presentableSessionConfigOptions,
  resolvedConfigOptionChoices,
  visibleSessionConfigOptions,
} from './SessionConfigOptionSelectors';
import {
  isDangerousPermissionsMode,
  presentableSessionModes,
} from './SessionModeSelector';

type ConfigRow = {
  option: AgentSessionConfigOption;
  activeLabel: string;
  activeValue: string;
  toggleValues: { off: string; on: string } | null;
};

type SummaryItem = {
  key: string;
  label: string;
  isFast: boolean;
  isModel: boolean;
};

function normalizedOption(option: AgentSessionConfigOption) {
  return `${option.category ?? ''} ${option.key} ${option.label}`.toLowerCase();
}

function isModelOption(option: AgentSessionConfigOption) {
  const identity = `${option.key} ${option.label}`.toLowerCase();
  return option.category === 'model' || identity.includes('model');
}

function isModeOption(option: AgentSessionConfigOption) {
  return (
    option.category === 'mode' ||
    option.key.toLowerCase() === 'mode' ||
    option.label.trim().toLowerCase() === 'mode'
  );
}

function isEffortOption(option: AgentSessionConfigOption) {
  const value = normalizedOption(option);
  return (
    option.category === 'thought_level' ||
    value.includes('thought') ||
    value.includes('effort') ||
    value.includes('reasoning')
  );
}

function isFastOption(option: AgentSessionConfigOption) {
  return normalizedOption(option).includes('fast');
}

function toggleValuesForOption(
  option: AgentSessionConfigOption,
  choices: NonNullable<AgentSessionConfigOption['choices']>
): ConfigRow['toggleValues'] {
  if (typeof option.value === 'boolean') {
    return { off: 'false', on: 'true' };
  }
  if (!isFastOption(option)) return null;

  const findChoiceValue = (values: Set<string>) =>
    choices.find((choice) => {
      const value = jsonValueToString(choice.value).trim().toLowerCase();
      const label = choice.label.trim().toLowerCase();
      return values.has(value) || values.has(label);
    });
  const offChoice = findChoiceValue(new Set(['false', 'off', 'disabled']));
  const onChoice = findChoiceValue(new Set(['true', 'on', 'enabled']));
  if (!offChoice || !onChoice) return null;

  return {
    off: jsonValueToString(offChoice.value),
    on: jsonValueToString(onChoice.value),
  };
}

function optionPriority(option: AgentSessionConfigOption) {
  if (isModeOption(option)) return 0;
  if (isModelOption(option)) return 10;
  if (isEffortOption(option)) return 20;
  if (isFastOption(option)) return 30;
  return 40;
}

function effortLabel(value: string, fallback: string): string {
  const normalized = `${value} ${fallback}`
    .toLowerCase()
    .replace(/[^a-z]/g, '');

  if (/(ultra|maximum|max|ultrathink)/.test(normalized)) return '极高';
  if (/(xhigh|extrahigh|veryhigh)/.test(normalized)) return '超高';
  if (/(default|auto)/.test(normalized)) return '默认';
  if (/high/.test(normalized)) return '高';
  if (/(medium|med|mid)/.test(normalized)) return '中';
  if (/(minimal|min|low)/.test(normalized)) return '低';
  return fallback;
}

/**
 * A compact, human-readable entry point for the session choices that agents
 * advertise over ACP. The closed state reads like a short sentence; the open
 * state preserves one clear action per row and keeps each choice one level
 * deeper, close to the trigger that opened it.
 */
export function SessionSettingsSummary({
  sessionModes,
  selectedMode = null,
  onSelectMode,
  options,
  pending,
  onSelectConfigOption,
  disabled = false,
  dropdownSide = 'top',
}: {
  sessionModes?: ConversationSessionModesState;
  selectedMode?: string | null;
  onSelectMode?: (modeId: string) => void;
  options: AgentSessionConfigOption[];
  pending: Record<string, string>;
  onSelectConfigOption?: (key: string, value: string) => void;
  disabled?: boolean;
  dropdownSide?: 'top' | 'bottom';
}) {
  const { t } = useTranslation(['tasks', 'common']);
  const activeModeId = selectedMode ?? sessionModes?.current ?? null;
  const visibleOptions = useMemo(
    () => visibleSessionConfigOptions(options),
    [options]
  );
  const presentableOptions = useMemo(
    () =>
      presentableSessionConfigOptions(
        options,
        onSelectMode ? (sessionModes?.modes ?? []) : []
      ),
    [onSelectMode, options, sessionModes?.modes]
  );
  const [dangerousOperationsAllowed, setDangerousOperationsAllowed] = useState(
    () => isDangerousPermissionsMode(activeModeId)
  );

  useEffect(() => {
    if (isDangerousPermissionsMode(activeModeId)) {
      setDangerousOperationsAllowed(true);
    }
  }, [activeModeId]);

  const presentableModes = useMemo(
    () =>
      presentableSessionModes(
        sessionModes?.modes ?? [],
        dangerousOperationsAllowed,
        activeModeId
      ),
    [activeModeId, dangerousOperationsAllowed, sessionModes?.modes]
  );
  const activeMode = presentableModes.find((mode) => mode.id === activeModeId);

  const configRows = useMemo<ConfigRow[]>(() => {
    if (!onSelectConfigOption) return [];

    return presentableOptions
      .map((option) => {
        const choices = resolvedConfigOptionChoices(
          option,
          visibleOptions,
          pending
        );
        const toggleValues = toggleValuesForOption(option, choices);
        if (!toggleValues && choices.length <= 1) return null;

        if (toggleValues) {
          const activeValue =
            pending[option.key] ?? jsonValueToString(option.value ?? null);
          const checked = activeValue === toggleValues.on;
          return {
            option,
            activeLabel: checked
              ? t('sessionSettings.on')
              : t('sessionSettings.off'),
            activeValue,
            toggleValues,
          };
        }

        const { displayChoices, presentedActiveValue } =
          configOptionDisplayState(
            option,
            pending[option.key] ?? null,
            choices
          );
        const activeChoice = displayChoices.find(
          (choice) => choice.value === presentedActiveValue
        );
        return {
          option,
          activeLabel: isEffortOption(option)
            ? effortLabel(
                presentedActiveValue,
                activeChoice?.name ?? jsonValueToString(option.value ?? null)
              )
            : (activeChoice?.name ?? jsonValueToString(option.value ?? null)),
          activeValue: presentedActiveValue,
          toggleValues: null,
        };
      })
      .filter((row): row is ConfigRow => row !== null)
      .sort(
        (left, right) =>
          optionPriority(left.option) - optionPriority(right.option)
      );
  }, [onSelectConfigOption, pending, presentableOptions, t, visibleOptions]);

  const summary: SummaryItem[] = [
    ...(activeMode?.label
      ? [
          {
            key: 'session-mode',
            label: activeMode.label,
            isFast: false,
            isModel: false,
          },
        ]
      : []),
    ...configRows.flatMap((row): SummaryItem[] => {
      if (row.toggleValues && row.activeValue !== row.toggleValues.on) {
        return [];
      }

      const isFast = Boolean(row.toggleValues) && isFastOption(row.option);
      return [
        {
          key: row.option.key,
          label: isFast
            ? 'Fast'
            : row.toggleValues
              ? row.option.label
              : row.activeLabel,
          isFast,
          isModel: isModelOption(row.option),
        },
      ];
    }),
  ];

  if (summary.length === 0) return null;

  const fastEnabled = summary.some((item) => item.isFast);
  const modelCarriesFastState =
    fastEnabled && summary.some((item) => item.isModel);
  const visibleSummary = modelCarriesFastState
    ? summary.filter((item) => !item.isFast)
    : summary;
  const triggerLabel = `${t('sessionSettings.title')}: ${summary
    .map((item) => item.label)
    .join(' · ')}`;

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="session-settings-summary"
          disabled={disabled}
          aria-label={triggerLabel}
          title={triggerLabel}
          className={cn(
            'group inline-flex h-7 min-w-0 max-w-[min(29rem,calc(100vw-14rem))] items-center gap-1.5',
            'rounded-full border border-border/60 bg-background/72 px-2.5 text-xs font-medium tracking-[-0.01em] text-foreground shadow-[0_1px_1px_hsl(var(--foreground)/0.04)] backdrop-blur-md',
            'transition-[background-color,border-color,box-shadow,transform] duration-150 ease-out',
            'hover:border-foreground/15 hover:bg-muted/70 hover:shadow-[0_3px_10px_hsl(var(--foreground)/0.08)]',
            'active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
          )}
        >
          <span className="truncate">
            {visibleSummary.map((item, index) => (
              <span key={item.key}>
                {index > 0 ? <span aria-hidden="true"> · </span> : null}
                <span
                  className={cn(
                    modelCarriesFastState &&
                      item.isModel &&
                      'composer-fast-model-flow'
                  )}
                >
                  {item.label}
                </span>
              </span>
            ))}
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-150 group-data-[state=open]:rotate-180" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side={dropdownSide}
        align="start"
        sideOffset={8}
        className="w-[min(22rem,calc(100vw-2rem))] rounded-[1.15rem] border-border/60 bg-popover/95 p-1.5 shadow-[0_18px_45px_hsl(var(--foreground)/0.18)] backdrop-blur-2xl"
      >
        <DropdownMenuLabel className="px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          {t('sessionSettings.title')}
        </DropdownMenuLabel>
        {onSelectMode && presentableModes.length > 0 ? (
          <ModeRow
            modes={presentableModes}
            activeModeId={activeModeId}
            onSelect={onSelectMode}
            disabled={disabled}
            hasDangerousMode={(sessionModes?.modes ?? []).some((mode) =>
              isDangerousPermissionsMode(mode.id)
            )}
            dangerousOperationsAllowed={dangerousOperationsAllowed}
            setDangerousOperationsAllowed={setDangerousOperationsAllowed}
          />
        ) : null}
        {configRows.map((row) =>
          row.toggleValues ? (
            <ToggleRow
              key={row.option.key}
              row={row}
              disabled={disabled}
              onSelect={onSelectConfigOption!}
            />
          ) : (
            <ChoiceRow
              key={row.option.key}
              row={row}
              options={visibleOptions}
              pending={pending}
              disabled={disabled}
              onSelect={onSelectConfigOption!}
            />
          )
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RowValue({ children }: { children: string }) {
  return (
    <span className="max-w-[11rem] truncate text-sm text-muted-foreground">
      {children}
    </span>
  );
}

function ModeRow({
  modes,
  activeModeId,
  onSelect,
  disabled,
  hasDangerousMode,
  dangerousOperationsAllowed,
  setDangerousOperationsAllowed,
}: {
  modes: AgentSessionMode[];
  activeModeId: string | null;
  onSelect: (modeId: string) => void;
  disabled: boolean;
  hasDangerousMode: boolean;
  dangerousOperationsAllowed: boolean;
  setDangerousOperationsAllowed: (value: boolean) => void;
}) {
  const { t } = useTranslation(['tasks', 'common']);
  const [open, setOpen] = useState(false);
  const activeMode = modes.find((mode) => mode.id === activeModeId);

  return (
    <DropdownMenuSub open={open} onOpenChange={setOpen}>
      <DropdownMenuSubTrigger
        disabled={disabled}
        onClick={() => setOpen(true)}
        className="rounded-[0.8rem] px-2.5 py-2 focus:bg-muted data-[state=open]:bg-muted"
      >
        <span className="min-w-0 flex-1 text-sm font-semibold">
          {t('sessionModeSelector.title')}
        </span>
        <RowValue>
          {activeMode?.label ?? t('sessionModeSelector.fallbackLabel')}
        </RowValue>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="min-w-[13rem] rounded-[1rem] border-border/60 bg-popover/95 p-1.5 shadow-[0_16px_35px_hsl(var(--foreground)/0.16)] backdrop-blur-2xl">
        <DropdownMenuLabel className="px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          {t('sessionModeSelector.title')}
        </DropdownMenuLabel>
        {modes.map((mode) => {
          const active = mode.id === activeModeId;
          return (
            <DropdownMenuItem
              key={mode.id}
              onSelect={() => {
                setOpen(false);
                onSelect(mode.id);
              }}
              className="rounded-[0.7rem] px-2.5 py-2 text-sm"
              title={mode.description ?? undefined}
            >
              <span className="min-w-0 flex-1 truncate">{mode.label}</span>
              {active ? <Check className="h-4 w-4" /> : null}
            </DropdownMenuItem>
          );
        })}
        {hasDangerousMode ? (
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault();
              setDangerousOperationsAllowed(!dangerousOperationsAllowed);
            }}
            className="mt-1 rounded-[0.7rem] border-t border-border/60 px-2.5 py-2 text-sm"
          >
            <span className="min-w-0 flex-1 text-muted-foreground">
              {t('sessionModeSelector.allowDangerousOperations')}
            </span>
            <span
              className={cn(
                'rounded-full px-2 py-0.5 text-[11px] font-semibold',
                dangerousOperationsAllowed
                  ? 'bg-primary/12 text-primary'
                  : 'bg-muted text-muted-foreground'
              )}
            >
              {dangerousOperationsAllowed
                ? t('sessionSettings.on')
                : t('sessionSettings.off')}
            </span>
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

function ChoiceRow({
  row,
  options,
  pending,
  onSelect,
  disabled,
}: {
  row: ConfigRow;
  options: AgentSessionConfigOption[];
  pending: Record<string, string>;
  onSelect: (key: string, value: string) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const choices = resolvedConfigOptionChoices(row.option, options, pending);
  const { displayChoices, presentedActiveValue } = configOptionDisplayState(
    row.option,
    pending[row.option.key] ?? null,
    choices
  );

  return (
    <DropdownMenuSub open={open} onOpenChange={setOpen}>
      <DropdownMenuSubTrigger
        disabled={disabled}
        onClick={() => setOpen(true)}
        className="rounded-[0.8rem] px-2.5 py-2 focus:bg-muted data-[state=open]:bg-muted"
      >
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">
          {row.option.label}
        </span>
        <RowValue>{row.activeLabel}</RowValue>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent
        className={cn(
          isEffortOption(row.option)
            ? 'w-auto max-w-none border-0 bg-transparent p-0 shadow-none'
            : 'min-w-[13rem] rounded-[1rem] border-border/60 bg-popover/95 p-1.5 shadow-[0_16px_35px_hsl(var(--foreground)/0.16)] backdrop-blur-2xl'
        )}
      >
        {isEffortOption(row.option) ? (
          <EffortSlider
            title={row.option.label}
            choices={displayChoices.map((choice) => ({
              value: choice.value,
              label: effortLabel(choice.value, choice.name),
              description: choice.description,
            }))}
            activeValue={presentedActiveValue}
            onSelect={(value) => onSelect(row.option.key, value)}
          />
        ) : (
          <>
            <DropdownMenuLabel className="px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              {row.option.label}
            </DropdownMenuLabel>
            {displayChoices.map((choice) => {
              const active = choice.value === presentedActiveValue;
              return (
                <DropdownMenuItem
                  key={choice.value}
                  onSelect={() => {
                    setOpen(false);
                    onSelect(row.option.key, choice.value);
                  }}
                  className="rounded-[0.7rem] px-2.5 py-2 text-sm"
                  title={choice.description ?? undefined}
                >
                  <span className="min-w-0 flex-1 truncate">{choice.name}</span>
                  {active ? <Check className="h-4 w-4" /> : null}
                </DropdownMenuItem>
              );
            })}
          </>
        )}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

function ToggleRow({
  row,
  onSelect,
  disabled,
}: {
  row: ConfigRow;
  onSelect: (key: string, value: string) => void;
  disabled: boolean;
}) {
  const toggleValues = row.toggleValues;
  if (!toggleValues) return null;
  const checked = row.activeValue === toggleValues.on;
  return (
    <DropdownMenuItem
      disabled={disabled}
      onSelect={(event) => {
        event.preventDefault();
        onSelect(row.option.key, checked ? toggleValues.off : toggleValues.on);
      }}
      className="rounded-[0.8rem] px-2.5 py-2 text-sm"
    >
      <span className="min-w-0 flex-1 truncate font-semibold">
        {row.option.label}
      </span>
      <span
        className={cn(
          'rounded-full px-2 py-0.5 text-[11px] font-semibold',
          checked
            ? 'bg-primary/12 text-primary'
            : 'bg-muted text-muted-foreground'
        )}
      >
        {row.activeLabel}
      </span>
    </DropdownMenuItem>
  );
}
