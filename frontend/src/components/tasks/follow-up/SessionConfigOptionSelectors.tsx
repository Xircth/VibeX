import { Brain, Check, Cpu, Settings2, Shield } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AgentSessionConfigOption, JsonValue } from 'shared/types';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EffortSlider } from '@/components/tasks/effort-slider/EffortSlider';
import { cn } from '@/lib/utils';
import {
  blockItemPointerMoveFocus,
  COMPOSER_SELECT_ITEM_CLASS,
  COMPOSER_SELECT_LABEL_CLASS,
  COMPOSER_SELECT_LIST_CLASS,
  ComposerOptionName,
  isDefaultChoiceLike,
  modelNameFromDescription,
} from './ComposerSelect';

/**
 * A choice prepared for display. Agent "Default" aliases never surface as
 * "Default": a model default is renamed to the concrete model it resolves to
 * (from its description, e.g. "Opus 4.8"); other defaults are hidden and the
 * concrete choice is presented as active instead.
 */
interface DisplayChoice {
  value: string;
  name: string;
  description?: string | null;
}

function buildDisplayChoices(
  isModelOption: boolean,
  choices: NonNullable<AgentSessionConfigOption['choices']>
): DisplayChoice[] {
  const out: DisplayChoice[] = [];
  for (const choice of choices) {
    const value = jsonValueToString(choice.value);
    const isDefault = isDefaultChoiceLike(value, choice.label);
    if (isModelOption) {
      const concrete = modelNameFromDescription(choice.description);
      if (isDefault && !concrete) continue;
      out.push({
        value,
        // Full model names ("Fable 5", "Sonnet 4.6"), never the agent's short
        // alias labels; the default alias shows the model it resolves to.
        name: concrete ?? choice.label,
        description: choice.description,
      });
      continue;
    }
    if (isDefault) continue;
    out.push({ value, name: choice.label, description: choice.description });
  }
  return out;
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
  const selectable = options.filter(
    (option) => (option.choices?.length ?? 0) > 1
  );
  if (selectable.length === 0) return null;

  return (
    <>
      {selectable.map((option) => (
        <SessionConfigOptionSelector
          key={option.key}
          option={option}
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
  pendingValue,
  onSelect,
  disabled,
}: {
  option: AgentSessionConfigOption;
  pendingValue: string | null;
  onSelect: (key: string, value: string) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation(['tasks', 'common']);
  const choices = option.choices ?? [];
  const activeValue = pendingValue ?? jsonValueToString(option.value ?? null);
  const Icon = iconForConfigOption(option);
  const normalizedKey = `${option.category ?? ''} ${option.key}`.toLowerCase();
  const isModelOption = normalizedKey.includes('model');

  const displayChoices = buildDisplayChoices(isModelOption, choices);
  // While the agent sits on a hidden "Default" alias, present the concrete
  // choice it effectively resolves to: effort defaults to High; otherwise the
  // first visible choice.
  const presentedActiveValue = (() => {
    if (displayChoices.some((choice) => choice.value === activeValue)) {
      return activeValue;
    }
    const high = displayChoices.find((choice) => choice.value === 'high');
    return (high ?? displayChoices[0])?.value ?? activeValue;
  })();
  const presentedActiveChoice =
    displayChoices.find((choice) => choice.value === presentedActiveValue) ??
    null;

  if (displayChoices.length === 0) return null;
  const triggerTitle =
    `${option.label || t('sessionConfigSelector.fallbackLabel')}: ${
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
            title={option.label || t('sessionConfigSelector.fallbackLabel')}
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
          {option.label || t('sessionConfigSelector.fallbackLabel')}
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

/** ACP select values are ids (strings); tolerate other JSON shapes defensively. */
function jsonValueToString(value: JsonValue | null): string {
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
  const normalized = `${option.category ?? ''} ${option.key}`.toLowerCase();
  return (
    normalized.includes('thought') ||
    normalized.includes('effort') ||
    normalized.includes('reasoning')
  );
}

function iconForConfigOption(option: AgentSessionConfigOption) {
  const normalized = `${option.category ?? ''} ${option.key}`.toLowerCase();
  if (normalized.includes('model')) return Cpu;
  if (isEffortConfigOption(option)) return Brain;
  if (normalized.includes('permission') || normalized.includes('approval')) {
    return Shield;
  }
  return Settings2;
}
