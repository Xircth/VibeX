import { Check } from 'lucide-react';
import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import {
  blockItemPointerMoveFocus,
  COMPOSER_SELECT_ITEM_CLASS,
  ComposerOptionName,
} from './ComposerSelect';
import type { DisplayChoice } from './SessionConfigOptionSelectors';

/**
 * Multi-provider agents (OpenCode, DSH, OMP, …) advertise every model as
 * `provider/model` in one flat menu. Group those into a provider row whose
 * submenu lists only that provider's models.
 */
export interface ProviderModelGroup {
  provider: string;
  models: DisplayChoice[];
}

export interface GroupedProviderModelChoices {
  providers: ProviderModelGroup[];
  /** Choices that are not `provider/model`, in their original order. */
  plain: DisplayChoice[];
}

export function splitProviderModelLabel(
  label: string
): { provider: string; model: string } | null {
  const trimmed = label.trim();
  const slash = trimmed.indexOf('/');
  if (slash <= 0 || slash >= trimmed.length - 1) return null;
  const provider = trimmed.slice(0, slash).trim();
  const model = trimmed.slice(slash + 1).trim();
  // A provider id has no spaces or URL scheme. Model names may contain both.
  if (!provider || !model || provider.length > 80 || /[\s:]/.test(provider)) {
    return null;
  }
  return { provider, model };
}

function classifyProviderModelChoice(
  choice: DisplayChoice
): { provider: string; modelLabel: string } | null {
  const fromName = splitProviderModelLabel(choice.name);
  if (fromName) {
    return { provider: fromName.provider, modelLabel: fromName.model };
  }
  const fromValue = splitProviderModelLabel(choice.value);
  if (!fromValue) return null;
  return { provider: fromValue.provider, modelLabel: choice.name };
}

/**
 * Returns null when the list should stay flat: fewer than two `provider/model`
 * choices, or they are not at least half the list (so a stray slash in an
 * otherwise normal catalog does not grow a submenu).
 */
export function groupProviderModelChoices(
  choices: DisplayChoice[]
): GroupedProviderModelChoices | null {
  if (choices.length < 2) return null;
  const classified = choices.map(classifyProviderModelChoice);
  const groupedCount = classified.filter((entry) => entry !== null).length;
  if (groupedCount < 2 || groupedCount * 2 < choices.length) return null;

  const providers: ProviderModelGroup[] = [];
  const byProvider = new Map<string, ProviderModelGroup>();
  const plain: DisplayChoice[] = [];

  choices.forEach((choice, index) => {
    const entry = classified[index];
    if (!entry) {
      plain.push(choice);
      return;
    }
    const key = entry.provider.toLowerCase();
    let group = byProvider.get(key);
    if (!group) {
      group = { provider: entry.provider, models: [] };
      byProvider.set(key, group);
      providers.push(group);
    }
    group.models.push(
      entry.modelLabel === choice.name
        ? choice
        : { ...choice, name: entry.modelLabel }
    );
  });

  return { providers, plain };
}

const MODEL_SUBMENU_CLASS =
  'min-w-[14rem] max-w-[24rem] max-h-[min(20rem,var(--radix-dropdown-menu-content-available-height,20rem))]';

type ModelChoiceAppearance = 'composer' | 'summary' | 'field';

/**
 * Renders model choices. When they are `provider/model`, the first level is
 * only the provider; hovering that row opens its models.
 */
export function ModelChoiceItems({
  choices,
  activeValue,
  onSelect,
  groupProviders = false,
  appearance,
}: {
  choices: DisplayChoice[];
  activeValue: string | null;
  onSelect: (value: string) => void;
  groupProviders?: boolean;
  appearance: ModelChoiceAppearance;
}) {
  const grouped = groupProviders ? groupProviderModelChoices(choices) : null;
  if (!grouped) {
    return choices.map((choice) => (
      <ModelChoiceItem
        key={choice.value}
        choice={choice}
        active={choice.value === activeValue}
        onSelect={onSelect}
        appearance={appearance}
      />
    ));
  }

  return (
    <>
      {grouped.plain.map((choice) => (
        <ModelChoiceItem
          key={choice.value}
          choice={choice}
          active={choice.value === activeValue}
          onSelect={onSelect}
          appearance={appearance}
        />
      ))}
      {grouped.providers.map((group) => (
        <ProviderModelSubmenu
          key={group.provider}
          group={group}
          activeValue={activeValue}
          onSelect={onSelect}
          appearance={appearance}
        />
      ))}
    </>
  );
}

function ProviderModelSubmenu({
  group,
  activeValue,
  onSelect,
  appearance,
}: {
  group: ProviderModelGroup;
  activeValue: string | null;
  onSelect: (value: string) => void;
  appearance: ModelChoiceAppearance;
}) {
  const active = group.models.some((model) => model.value === activeValue);
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger
        className={
          appearance === 'composer' ? COMPOSER_SELECT_ITEM_CLASS : undefined
        }
        title={group.provider}
        data-testid={`model-provider-${group.provider}`}
      >
        <span className="min-w-0 flex-1 truncate">{group.provider}</span>
        {active ? (
          <Check
            className={cn(
              'shrink-0',
              appearance === 'summary' ? 'h-4 w-4' : 'h-3.5 w-3.5'
            )}
          />
        ) : null}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className={MODEL_SUBMENU_CLASS}>
        {group.models.map((model, index) => (
          <ModelChoiceItem
            key={`${model.value}:${index}`}
            choice={model}
            active={model.value === activeValue}
            onSelect={onSelect}
            appearance={appearance}
          />
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

function ModelChoiceItem({
  choice,
  active,
  onSelect,
  appearance,
}: {
  choice: DisplayChoice;
  active: boolean;
  onSelect: (value: string) => void;
  appearance: ModelChoiceAppearance;
}) {
  if (appearance === 'composer') {
    return (
      <DropdownMenuItem
        onSelect={() => onSelect(choice.value)}
        onPointerMove={blockItemPointerMoveFocus}
        className={COMPOSER_SELECT_ITEM_CLASS}
      >
        <span className="min-w-0 flex-1">
          <ComposerOptionName active={active} title={choice.description}>
            {choice.name}
          </ComposerOptionName>
        </span>
        <Check
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-foreground',
            active ? 'opacity-100' : 'opacity-0'
          )}
        />
      </DropdownMenuItem>
    );
  }

  if (appearance === 'summary') {
    return (
      <DropdownMenuItem
        onSelect={() => onSelect(choice.value)}
        title={choice.description ?? undefined}
      >
        <span className="min-w-0 flex-1 truncate">{choice.name}</span>
        {active ? <Check className="h-4 w-4" /> : null}
      </DropdownMenuItem>
    );
  }

  return (
    <DropdownMenuItem
      onSelect={() => onSelect(choice.value)}
      className="justify-between"
      title={choice.description ?? undefined}
    >
      <span className="truncate">{choice.name}</span>
      <Check
        className={cn(
          'h-3.5 w-3.5 shrink-0',
          active ? 'opacity-100' : 'opacity-0'
        )}
      />
    </DropdownMenuItem>
  );
}
