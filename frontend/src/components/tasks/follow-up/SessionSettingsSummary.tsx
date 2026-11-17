import { Check, ChevronDown } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentSessionConfigOption, AgentSessionMode } from 'shared/types';
import { AgentIcon, getAgentName } from '@/components/agents/AgentIcon';
import { isEnabledInstalledAgent } from '@/features/agents/operationalAgent';
import type { ConversationSessionModesState } from '@/features/conversation/conversationStore';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { canonicalSessionAgentId } from '@/lib/sessionQueryCache';
import type { AgentInstanceOption } from '@/lib/providerInstancesApi';
import { cn } from '@/lib/utils';
import { EffortSlider } from '@/components/tasks/effort-slider/EffortSlider';
import { AgentRail, type AgentRailProps } from './AgentRail';
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
import i18n from '@/i18n';

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

export type SessionPersona = {
  name: string;
  teamName?: string;
  summary?: string;
  agentName: string;
};

export type SessionAgentRailConfig = Omit<AgentRailProps, 'disabled'>;

export type SessionProviderInstanceConfig = {
  options: AgentInstanceOption[];
  selectedInstanceId: string;
  disabled?: boolean;
  onSelectInstance: (instanceId: string) => void;
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
    (option.key ?? '').toLowerCase() === 'mode' ||
    (option.label ?? '').trim().toLowerCase() === 'mode'
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
      const label = (choice.label ?? '').trim().toLowerCase();
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

  if (/(ultrathink|ultra)/.test(normalized)) return 'Ultra';
  if (/(maximum|max)/.test(normalized)) return 'Max';
  if (/(xhigh|extrahigh|veryhigh)/.test(normalized))
    return i18n.t('panels:ui.effort.extraHigh');
  if (/(default|auto)/.test(normalized))
    return i18n.t('panels:ui.effort.default');
  if (/high/.test(normalized)) return i18n.t('panels:ui.effort.high');
  if (/(medium|med|mid)/.test(normalized))
    return i18n.t('panels:ui.effort.medium');
  if (/(minimal|min|low)/.test(normalized))
    return i18n.t('panels:ui.effort.low');
  return fallback;
}

export function resolveSessionModelDisplayLabel(
  options: AgentSessionConfigOption[] | undefined,
  pending: Record<string, string> = {}
): string | null {
  if (!options || options.length === 0) return null;
  const visible = visibleSessionConfigOptions(options);
  const modelOption = visible.find(isModelOption);
  if (!modelOption) return null;
  const choices = resolvedConfigOptionChoices(modelOption, visible, pending);
  if (choices.length > 0) {
    const { displayChoices, presentedActiveValue } = configOptionDisplayState(
      modelOption,
      pending[modelOption.key] ?? null,
      choices
    );
    const activeChoice = displayChoices.find(
      (choice) => choice.value === presentedActiveValue
    );
    const label = (activeChoice?.name ?? presentedActiveValue).trim();
    return label || null;
  }
  const fallback = (
    pending[modelOption.key] ?? jsonValueToString(modelOption.value ?? null)
  ).trim();
  return fallback || null;
}

/**
 * A compact, human-readable entry point for the session choices that agents
 * advertise over ACP. The closed state shows only the Agent icon, active
 * model/agent name (with Fast rainbow flow when active), and reasoning effort;
 * the open state preserves one clear action per row and, in the main composer,
 * hosts a left agent-selection rail alongside the selected agent's settings.
 */
export function SessionSettingsSummary({
  sessionModes,
  selectedMode = null,
  onSelectMode,
  options,
  pending,
  onSelectConfigOption,
  persona = null,
  disabled = false,
  dropdownSide = 'top',
  dropdownAlign = 'start',
  agentIcon = null,
  agentIconLight = null,
  agentIconDark = null,
  agentIconSvg = null,
  agentRail = null,
  providerInstanceConfig = null,
  controlsLoading = false,
}: {
  sessionModes?: ConversationSessionModesState;
  selectedMode?: string | null;
  onSelectMode?: (modeId: string) => void;
  options: AgentSessionConfigOption[];
  pending: Record<string, string>;
  onSelectConfigOption?: (key: string, value: string) => void;
  persona?: SessionPersona | null;
  disabled?: boolean;
  dropdownSide?: 'top' | 'bottom';
  dropdownAlign?: 'start' | 'center' | 'end';
  agentIcon?: string | null;
  agentIconLight?: string | null;
  agentIconDark?: string | null;
  agentIconSvg?: string | null;
  agentRail?: SessionAgentRailConfig | null;
  providerInstanceConfig?: SessionProviderInstanceConfig | null;
  controlsLoading?: boolean;
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

  const showAgentRail = useMemo(
    () =>
      Boolean(agentRail?.profiles) &&
      (agentRail?.selectableAgents.some(isEnabledInstalledAgent) ?? false),
    [agentRail?.profiles, agentRail?.selectableAgents]
  );
  const showPersonaOnly = Boolean(persona) && !showAgentRail;

  const railSelectedAgentId =
    agentRail?.effectiveExecutorProfile?.executor ?? null;
  const railSelectedAgent = useMemo(() => {
    if (!railSelectedAgentId) return null;
    const canonicalTarget = canonicalSessionAgentId(railSelectedAgentId);
    return (
      agentRail?.selectableAgents.find(
        (agent) =>
          agent.agentId === railSelectedAgentId ||
          canonicalSessionAgentId(agent.agentId) === canonicalTarget
      ) ?? null
    );
  }, [agentRail?.selectableAgents, railSelectedAgentId]);
  const resolvedAgentId = agentIcon ?? railSelectedAgentId;
  const resolvedIconLight =
    agentIconLight ?? railSelectedAgent?.iconLight ?? null;
  const resolvedIconDark = agentIconDark ?? railSelectedAgent?.iconDark ?? null;
  const resolvedIconSvg = agentIconSvg ?? railSelectedAgent?.iconSvg ?? null;
  const selectedAgentLabel =
    railSelectedAgent?.displayName ??
    (resolvedAgentId
      ? getAgentName(resolvedAgentId)
      : t('sessionSettings.title'));

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

  const showInstanceRow = Boolean(
    providerInstanceConfig && providerInstanceConfig.options.length >= 2
  );

  const hasSessionControls =
    (Boolean(onSelectMode) && presentableModes.length > 0) ||
    configRows.length > 0;

  if (
    !showPersonaOnly &&
    !showAgentRail &&
    !showInstanceRow &&
    !hasSessionControls &&
    summary.length === 0 &&
    !resolvedAgentId
  ) {
    return null;
  }

  const fastEnabled = summary.some((item) => item.isFast);
  const modelRow = configRows.find(
    (row) => isModelOption(row.option) && !row.toggleValues
  );
  const effortRow = configRows.find(
    (row) => isEffortOption(row.option) && !row.toggleValues
  );
  const primaryNameLabel =
    modelRow?.activeLabel ?? (resolvedAgentId ? selectedAgentLabel : null);
  const visibleSummary: Array<{
    key: string;
    label: string;
    isPrimaryName: boolean;
  }> = [
    ...(primaryNameLabel
      ? [
          {
            key: modelRow?.option.key ?? 'agent-name',
            label: primaryNameLabel,
            isPrimaryName: true,
          },
        ]
      : []),
    ...(effortRow
      ? [
          {
            key: effortRow.option.key,
            label: effortRow.activeLabel,
            isPrimaryName: false,
          },
        ]
      : []),
  ];
  const summaryText =
    summary.length > 0
      ? summary.map((item) => item.label).join(' · ')
      : resolvedAgentId
        ? selectedAgentLabel
        : '';
  const triggerLabel =
    showPersonaOnly && persona
      ? persona.name
      : summaryText
        ? `${t('sessionSettings.title')}: ${summaryText}`
        : t('sessionSettings.title');
  const sessionControlRows = (
    <>
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
    </>
  );

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
            'group inline-flex h-8 min-w-0 max-w-[min(29rem,calc(100vw-14rem))] items-center gap-2 rounded-md border-0 bg-transparent px-2.5 text-sm font-medium tracking-[-0.01em] text-foreground transition-colors',
            'hover:bg-muted/60 data-[state=open]:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50',
            'active:scale-[0.98]'
          )}
        >
          {resolvedAgentId ? (
            <AgentIcon
              agent={resolvedAgentId}
              className="h-[18px] w-[18px] shrink-0"
              iconLight={resolvedIconLight}
              iconDark={resolvedIconDark}
              iconSvg={resolvedIconSvg}
            />
          ) : null}
          <span className="truncate">
            {showPersonaOnly && persona
              ? persona.name
              : visibleSummary.length > 0
                ? visibleSummary.map((item, index) => (
                    <span key={item.key}>
                      {index > 0 ? <span aria-hidden="true"> · </span> : null}
                      <span
                        className={cn(
                          fastEnabled &&
                            item.isPrimaryName &&
                            'composer-fast-model-flow'
                        )}
                      >
                        {item.label}
                      </span>
                    </span>
                  ))
                : selectedAgentLabel}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-150 group-data-[state=open]:rotate-180" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side={dropdownSide}
        align={dropdownAlign}
        sideOffset={8}
        className={cn(
          showAgentRail
            ? 'w-[min(25rem,calc(100vw-2rem))] overflow-hidden rounded-lg border border-border/80 bg-popover p-0'
            : 'w-[min(22rem,calc(100vw-2rem))]'
        )}
      >
        {showPersonaOnly && persona ? (
          <>
            <PersonaFact
              label={t('sessionSettings.personaName')}
              value={persona.name}
            />
            <PersonaFact
              label={t('sessionSettings.personaAgent')}
              value={
                <>
                  <AgentIcon
                    agent={persona.agentName}
                    className="h-4 w-4 shrink-0"
                  />
                  <span className="truncate">
                    {getAgentName(persona.agentName)}
                  </span>
                </>
              }
            />
            {showInstanceRow && providerInstanceConfig ? (
              <>
                <InstanceRow
                  config={providerInstanceConfig}
                  disabled={disabled}
                />
                {hasSessionControls ? <DropdownMenuSeparator /> : null}
              </>
            ) : null}
            {hasSessionControls ? (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger className="px-2.5 py-1.5">
                  <span className="min-w-0 flex-1 text-sm font-semibold">
                    {t('sessionSettings.sessionConfig')}
                  </span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="min-w-[16rem]">
                  {sessionControlRows}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ) : null}
          </>
        ) : showAgentRail && agentRail ? (
          <div
            data-testid="session-settings-layered-shell"
            className="flex min-h-[11rem] items-stretch bg-popover p-1"
          >
            <div className="relative w-10 shrink-0">
              <div
                data-testid="session-settings-agent-rail"
                className="absolute inset-0 overflow-y-auto overflow-x-hidden overscroll-contain bg-popover px-1.5 py-1 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden [&::-webkit-scrollbar]:h-0 [&::-webkit-scrollbar]:w-0"
              >
                <AgentRail
                  profiles={agentRail.profiles}
                  effectiveExecutorProfile={agentRail.effectiveExecutorProfile}
                  onChangeExecutorProfile={agentRail.onChangeExecutorProfile}
                  disabled={disabled}
                  selectableAgents={agentRail.selectableAgents}
                />
              </div>
            </div>
            <div
              data-testid="session-settings-detail-card"
              className="relative z-10 max-h-[min(18rem,var(--radix-dropdown-menu-content-available-height))] min-h-[10.5rem] min-w-0 flex-1 overflow-y-auto bg-popover p-1"
            >
              {showInstanceRow && providerInstanceConfig ? (
                <>
                  <InstanceRow
                    config={providerInstanceConfig}
                    disabled={disabled}
                  />
                  <DropdownMenuSeparator />
                </>
              ) : null}
              {hasSessionControls ? (
                sessionControlRows
              ) : (
                <div className="px-2.5 py-1.5 text-xs text-muted-foreground">
                  {controlsLoading
                    ? t('sessionCreation.controlsLoading')
                    : t('sessionSettings.defaultConfig')}
                </div>
              )}
            </div>
          </div>
        ) : (
          <>
            <DropdownMenuLabel className="px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              {t('sessionSettings.title')}
            </DropdownMenuLabel>
            {showInstanceRow && providerInstanceConfig ? (
              <>
                <InstanceRow
                  config={providerInstanceConfig}
                  disabled={disabled}
                />
                {hasSessionControls ? <DropdownMenuSeparator /> : null}
              </>
            ) : null}
            {sessionControlRows}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PersonaFact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center gap-3 px-2.5 py-1.5">
      <span className="min-w-0 flex-1 text-sm font-semibold">{label}</span>
      <RowValue>{value}</RowValue>
    </div>
  );
}

function RowValue({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex max-w-[11rem] items-center gap-1.5 truncate text-sm text-muted-foreground">
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
        className="px-2.5 py-1.5"
      >
        <span className="min-w-0 flex-1 text-sm font-semibold">
          {t('sessionModeSelector.title')}
        </span>
        <RowValue>
          {activeMode?.label ?? t('sessionModeSelector.fallbackLabel')}
        </RowValue>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="min-w-[13rem]">
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
            className="mt-1 border-t border-border/60"
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
        className="px-2.5 py-1.5"
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
            : 'min-w-[13rem]'
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

function InstanceRow({
  config,
  disabled,
}: {
  config: SessionProviderInstanceConfig;
  disabled: boolean;
}) {
  const { t } = useTranslation(['tasks', 'settings']);
  const [open, setOpen] = useState(false);
  const activeOption =
    config.options.find(
      (option) => option.instanceId === config.selectedInstanceId
    ) ?? config.options[0];

  if (!activeOption) return null;

  return (
    <DropdownMenuSub open={open} onOpenChange={setOpen}>
      <DropdownMenuSubTrigger
        data-testid="session-settings-instance-trigger"
        disabled={disabled || config.disabled}
        onClick={() => setOpen(true)}
        className="px-2.5 py-1.5"
      >
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">
          {t('sessionCreation.instanceLabel', { defaultValue: '实例' })}
        </span>
        <RowValue>{activeOption.displayName}</RowValue>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="min-w-[13rem]">
        <DropdownMenuLabel className="px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          {t('sessionCreation.instanceLabel', { defaultValue: '实例' })}
        </DropdownMenuLabel>
        {config.options.map((option) => {
          const active = option.instanceId === activeOption.instanceId;
          return (
            <DropdownMenuItem
              key={option.instanceId}
              data-testid={`session-settings-instance-option-${option.instanceId}`}
              onSelect={() => {
                setOpen(false);
                config.onSelectInstance(option.instanceId);
              }}
              className="flex items-center justify-between gap-2"
            >
              <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate">
                <span className="truncate">{option.displayName}</span>
                {option.isDefault ? (
                  <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                    {t('settings:providerInstances.defaultBadge', {
                      defaultValue: '默认',
                    })}
                  </span>
                ) : null}
              </span>
              {active ? <Check className="h-4 w-4 shrink-0" /> : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
