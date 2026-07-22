import { Brain, Check, Cpu, Settings2, Shield } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type {
  AgentSessionConfigDependency,
  AgentSessionConfigOption,
  JsonValue,
} from 'shared/types';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EffortSlider } from '@/components/tasks/effort-slider/EffortSlider';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import {
  blockItemPointerMoveFocus,
  COMPOSER_SELECT_ITEM_CLASS,
  COMPOSER_SELECT_LABEL_CLASS,
  COMPOSER_SELECT_LIST_CLASS,
  ComposerOptionName,
} from './ComposerSelect';
import { compactSessionControlLabel } from './sessionControlLabels';

/**
 * A choice prepared for display without changing the Agent-advertised value,
 * label, or description.
 */
export interface DisplayChoice {
  value: string;
  name: string;
  description?: string | null;
}

const HIDDEN_SESSION_CONFIG_OPTION_KEYS = new Set(['collaboration_mode']);

function normalizedConfigOptionKey(key: string): string {
  return key.trim().toLowerCase().replaceAll('-', '_');
}

/**
 * Codex advertises collaboration mode as a session option, but VibeX keeps it
 * at the runtime default. Hiding it at this shared presentation boundary keeps
 * creation and composer menus consistent and prevents an oversized summary.
 */
export function visibleSessionConfigOptions(
  options: AgentSessionConfigOption[]
): AgentSessionConfigOption[] {
  return options.filter(
    (option) =>
      !HIDDEN_SESSION_CONFIG_OPTION_KEYS.has(
        normalizedConfigOptionKey(option.key)
      )
  );
}

function configOptionDependency(
  option: AgentSessionConfigOption
): AgentSessionConfigDependency | null {
  return option.dependency ?? null;
}

/**
 * Resolve choices from the catalog's dependency map. A dependent option is
 * deliberately unavailable until its parent has an actual value: do not
 * substitute a visual default for a model that ACP has not selected yet.
 */
export function resolvedConfigOptionChoices(
  option: AgentSessionConfigOption,
  options: AgentSessionConfigOption[],
  pending: Record<string, string>
): NonNullable<AgentSessionConfigOption['choices']> {
  const dependency = configOptionDependency(option);
  if (!dependency) return option.choices ?? [];

  const parent = options.find(
    (candidate) => candidate.key === dependency.parent_key
  );
  if (!parent) return [];

  const parentValue =
    pending[dependency.parent_key] ?? jsonValueToString(parent.value ?? null);
  if (!parentValue) return [];

  return dependency.choices_by_parent_value[parentValue] ?? [];
}

/**
 * Drops hidden/removed options and stale dependent selections. This is used
 * before sending next-turn overrides, so a hidden Codex collaboration mode or
 * an effort for the wrong model can never leak into a later request.
 */
export function sanitizeDependentConfigValues(
  options: AgentSessionConfigOption[],
  values: Record<string, string>
): Record<string, string> {
  let next = values;
  const visibleKeys = new Set(options.map((option) => option.key));
  for (const key of Object.keys(values)) {
    if (visibleKeys.has(key)) continue;
    if (next === values) next = { ...values };
    delete next[key];
  }
  // Dependencies are currently model → effort, but converge generically if a
  // future agent adds a short dependency chain.
  for (let pass = 0; pass < options.length; pass += 1) {
    let changed = false;
    for (const option of options) {
      if (!configOptionDependency(option) || !(option.key in next)) continue;
      const allowed = resolvedConfigOptionChoices(option, options, next);
      const selected = next[option.key];
      if (
        allowed.some((choice) => jsonValueToString(choice.value) === selected)
      ) {
        continue;
      }
      if (next === values) next = { ...values };
      else next = { ...next };
      delete next[option.key];
      changed = true;
    }
    if (!changed) break;
  }
  return next;
}

/**
 * Applies a user selection while keeping dependent values valid. Invalid
 * selections are ignored (notably an effort click before a model is known).
 */
export function selectConfigOptionValue(
  options: AgentSessionConfigOption[],
  values: Record<string, string>,
  key: string,
  value: string
): Record<string, string> {
  const option = options.find((candidate) => candidate.key === key);
  if (!option) return values;

  const choices = resolvedConfigOptionChoices(option, options, values);
  if (!choices.some((choice) => jsonValueToString(choice.value) === value)) {
    return sanitizeDependentConfigValues(options, values);
  }

  return sanitizeDependentConfigValues(options, { ...values, [key]: value });
}

export function areConfigValuesEqual(
  left: Record<string, string>,
  right: Record<string, string>
): boolean {
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every((key) => left[key] === right[key]);
}

export function buildDisplayChoices(
  isModelOption: boolean,
  choices: NonNullable<AgentSessionConfigOption['choices']>,
  activeValue = ''
): DisplayChoice[] {
  return choices
    .filter((choice) => {
      const value = jsonValueToString(choice.value);
      // Claude's ACP bridge prepends a "Default (recommended)" model
      // sentinel even when it resolves to the model that is already active.
      // It is not a distinct model, so omit it unless an older session has it
      // selected and we need to render that real current state faithfully.
      return (
        !isModelOption ||
        value === activeValue ||
        !(value === 'default' && /^default(?:\s|$)/i.test(choice.label))
      );
    })
    .map((choice) => ({
      value: jsonValueToString(choice.value),
      name: compactSessionControlLabel(
        jsonValueToString(choice.value),
        choice.label
      ),
      description: choice.description,
    }));
}

/**
 * Composer selectors for the config options the agent actually advertised over
 * ACP (`session/new` → `configOptions`, refreshed by `config_option_update`):
 * model, permission mode, thought level, …. Selecting a choice applies it
 * immediately via `session/set_config_option` when the session is idle, or as
 * a next-turn override while a turn is streaming. Renders nothing until the
 * agent advertises options, so it never shows fabricated choices.
 */
export function SessionConfigOptionSelectors({
  options,
  pending,
  onSelect,
  disabled = false,
}: {
  options: AgentSessionConfigOption[];
  /** Pending per-option selections awaiting the next turn (key → choice value). */
  pending: Record<string, string>;
  onSelect: (key: string, value: string) => void;
  disabled?: boolean;
}) {
  const visibleOptions = visibleSessionConfigOptions(options);
  const selectable = visibleOptions.filter(
    (option) => resolvedConfigOptionChoices(option, options, pending).length > 1
  );
  if (selectable.length === 0) return null;

  return (
    <>
      {selectable.map((option) => (
        <SessionConfigOptionSelector
          key={option.key}
          option={option}
          choices={resolvedConfigOptionChoices(option, options, pending)}
          pendingValue={pending[option.key] ?? null}
          onSelect={onSelect}
          disabled={disabled}
        />
      ))}
    </>
  );
}

function SessionConfigOptionSelector({
  option,
  choices,
  pendingValue,
  onSelect,
  disabled,
}: {
  option: AgentSessionConfigOption;
  choices: NonNullable<AgentSessionConfigOption['choices']>;
  pendingValue: string | null;
  onSelect: (key: string, value: string) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation(['tasks', 'common']);
  const Icon = iconForConfigOption(option);
  const optionLabel = option.label || t('sessionConfigSelector.fallbackLabel');
  if (typeof option.value === 'boolean') {
    const checked = pendingValue ? pendingValue === 'true' : option.value;
    return (
      <Switch
        checked={checked}
        onCheckedChange={(next) => onSelect(option.key, String(next))}
        disabled={disabled}
        title={`${optionLabel}: ${checked ? 'On' : 'Off'}`}
        aria-label={optionLabel}
      />
    );
  }
  const { displayChoices, presentedActiveValue } = configOptionDisplayState(
    option,
    pendingValue,
    choices
  );
  const presentedActiveChoice =
    displayChoices.find((choice) => choice.value === presentedActiveValue) ??
    null;

  if (displayChoices.length === 0) return null;
  const triggerTitle = `${optionLabel}: ${
    presentedActiveChoice?.name ?? ''
  }`.trim();
  const asEffortSlider =
    isEffortConfigOption(option) && displayChoices.length >= 2;

  if (asEffortSlider) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={disabled}
          className={cn(
            'inline-flex h-7 w-7 items-center justify-center rounded-md text-foreground/80',
            'hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50'
          )}
          title={triggerTitle}
          aria-label={triggerTitle}
        >
          <Icon className="h-3.5 w-3.5" />
        </DropdownMenuTrigger>
        {/* Bare content shell: the effort card brings its own squircle
            surface, border and drop shadow. */}
        <DropdownMenuContent
          side="top"
          align="start"
          sideOffset={8}
          className="w-auto max-w-none rounded-[12px] border-0 bg-transparent p-0 shadow-none"
        >
          <EffortSlider
            title={optionLabel}
            choices={displayChoices.map((choice) => ({
              value: choice.value,
              label: choice.name,
              description: choice.description,
            }))}
            activeValue={presentedActiveValue}
            onSelect={(value) => onSelect(option.key, value)}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return (
    <DropdownMenu>
      {/* Icon-only trigger (matches the composer's other icon buttons); the
          current selection lives in the tooltip and the opened menu. */}
      <DropdownMenuTrigger
        disabled={disabled}
        className={cn(
          'inline-flex h-7 w-7 items-center justify-center rounded-md text-foreground/80',
          'hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50'
        )}
        title={triggerTitle}
        aria-label={triggerTitle}
      >
        <Icon className="h-3.5 w-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        className="min-w-[10rem] max-w-[16rem] rounded-lg p-1"
      >
        <DropdownMenuLabel className={COMPOSER_SELECT_LABEL_CLASS}>
          {optionLabel}
        </DropdownMenuLabel>
        <div className={COMPOSER_SELECT_LIST_CLASS}>
          {displayChoices.map((choice) => {
            const isActive = choice.value === presentedActiveValue;
            return (
              <DropdownMenuItem
                key={choice.value}
                onSelect={() => onSelect(option.key, choice.value)}
                onPointerMove={blockItemPointerMoveFocus}
                className={cn(
                  COMPOSER_SELECT_ITEM_CLASS,
                  isActive && 'bg-accent/60'
                )}
              >
                <span className="min-w-0 flex-1">
                  <ComposerOptionName
                    active={isActive}
                    title={choice.description}
                  >
                    {choice.name}
                  </ComposerOptionName>
                </span>
                <Check
                  className={cn(
                    'h-3.5 w-3.5 shrink-0 text-foreground',
                    isActive ? 'opacity-100' : 'opacity-0'
                  )}
                />
              </DropdownMenuItem>
            );
          })}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Display model shared by the composer's icon selectors and the create form's
 * labeled fields: the prepared choices plus the value presented as active
 * (pending pick > the Agent's exact active value).
 */
export function configOptionDisplayState(
  option: AgentSessionConfigOption,
  pendingValue: string | null,
  choices: NonNullable<AgentSessionConfigOption['choices']> = option.choices ??
    []
): { displayChoices: DisplayChoice[]; presentedActiveValue: string } {
  const activeValue = pendingValue ?? jsonValueToString(option.value ?? null);
  // The ACP-stabilized `category` ("model" / "thought_level" / "mode" / …) is
  // authoritative when present; the key/name substring match is only a
  // fallback for agents that omit it.
  const normalizedKey = `${option.category ?? ''} ${option.key}`.toLowerCase();
  const isModelOption =
    option.category === 'model' || normalizedKey.includes('model');
  const displayChoices = buildDisplayChoices(
    isModelOption,
    choices,
    activeValue
  );
  return { displayChoices, presentedActiveValue: activeValue };
}

/** ACP select values are ids (strings); tolerate other JSON shapes defensively. */
export function jsonValueToString(value: JsonValue | null): string {
  if (value === null) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/**
 * Effort-like options (Codex reasoning effort, Claude Code thought level, …)
 * get the range-slider card instead of a plain choice menu. Assumes the agent
 * advertises choices in ascending effort order, which ACP agents do.
 */
function isEffortConfigOption(option: AgentSessionConfigOption): boolean {
  if (option.category === 'thought_level') return true;
  const normalized = `${option.category ?? ''} ${option.key}`.toLowerCase();
  return (
    normalized.includes('thought') ||
    normalized.includes('effort') ||
    normalized.includes('reasoning')
  );
}

function iconForConfigOption(option: AgentSessionConfigOption) {
  if (option.category === 'model') return Cpu;
  if (isEffortConfigOption(option)) return Brain;
  const normalized = `${option.category ?? ''} ${option.key}`.toLowerCase();
  if (normalized.includes('model')) return Cpu;
  if (normalized.includes('permission') || normalized.includes('approval')) {
    return Shield;
  }
  return Settings2;
}
