import { useEffect, useState, type ReactNode } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import type { AgentSessionControlsSnapshot } from 'shared/types';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  advertisedSessionConfigValues,
  presentableSessionConfigOptions,
  sanitizeDependentConfigValues,
  selectConfigOptionValue,
  visibleSessionConfigOptions,
} from '@/components/tasks/follow-up/SessionConfigOptionSelectors';
import { SessionSettingsSummary } from '@/components/tasks/follow-up/SessionSettingsSummary';
import { loadAgentSessionControlsCatalog } from '@/features/agents/sessionControlsQuery';
import { cn } from '@/lib/utils';

import { COPY } from './spaceModel';

export type CollaborationSelectOption<T extends string = string> = {
  value: T;
  label: string;
  icon?: ReactNode;
};

export function CollaborationOptionSelect<T extends string = string>({
  ariaLabel,
  value,
  placeholder,
  options,
  onChange,
  size = 'default',
  disabled = false,
}: {
  ariaLabel: string;
  value: T;
  placeholder?: string;
  options: readonly CollaborationSelectOption<T>[];
  onChange: (value: T) => void;
  size?: 'default' | 'compact';
  disabled?: boolean;
}) {
  const selectedOption = options.find((option) => option.value === value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-label={ariaLabel}
          data-value={value}
          disabled={disabled}
          className={cn(
            'raised-control w-full justify-between px-2.5 font-normal',
            size === 'compact' ? 'h-7 text-xs' : 'h-8 text-[13px]'
          )}
        >
          <span className="flex min-w-0 items-center gap-2 truncate">
            {selectedOption?.icon ? (
              <span aria-hidden="true" className="inline-flex shrink-0">
                {selectedOption.icon}
              </span>
            ) : null}
            <span className="truncate">
              {selectedOption?.label || placeholder || ''}
            </span>
          </span>
          <ChevronDown
            className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-[var(--radix-dropdown-menu-trigger-width)] min-w-[180px]"
      >
        {options.map((option) => {
          const isSelected = option.value === value;
          return (
            <DropdownMenuItem
              key={option.value || '__empty__'}
              data-state={isSelected ? 'checked' : undefined}
              onSelect={() => onChange(option.value)}
            >
              <span className="flex min-w-0 flex-1 items-center gap-2 truncate">
                {option.icon ? (
                  <span aria-hidden="true" className="inline-flex shrink-0">
                    {option.icon}
                  </span>
                ) : null}
                <span className="truncate">{option.label}</span>
              </span>
              {isSelected ? (
                <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              ) : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function CustomAgentControls({
  agentId,
  modeId,
  values,
  onModeId,
  onValues,
}: {
  agentId: string;
  modeId: string;
  values: Record<string, string>;
  onModeId: (modeId: string) => void;
  onValues: (values: Record<string, string>) => void;
}) {
  const [catalog, setCatalog] = useState<AgentSessionControlsSnapshot | null>(
    null
  );
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!agentId) {
      setFailed(true);
      return;
    }
    let active = true;
    setFailed(false);
    setCatalog(null);
    void loadAgentSessionControlsCatalog(agentId)
      .then((next) => {
        if (active) setCatalog(next);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [agentId]);

  if (!agentId || failed) {
    return (
      <p className="settings-row__description">{COPY.controlsUnavailable}</p>
    );
  }
  if (!catalog) return null;

  const visibleConfigOptions = visibleSessionConfigOptions(
    catalog.config_options ?? []
  );
  const presentableConfigOptions = presentableSessionConfigOptions(
    visibleConfigOptions,
    catalog.modes ?? []
  );
  const advertisedConfigValues =
    advertisedSessionConfigValues(visibleConfigOptions);
  const sanitizedConfigValues = sanitizeDependentConfigValues(
    visibleConfigOptions,
    {
      ...advertisedConfigValues,
      ...values,
    }
  );
  const presentableConfigKeys = new Set(
    presentableConfigOptions.map((option) => option.key)
  );
  const configOverrides = Object.fromEntries(
    Object.entries(sanitizedConfigValues).filter(([key]) =>
      presentableConfigKeys.has(key)
    )
  );

  return (
    <div className="flex flex-wrap items-center gap-2">
      <SessionSettingsSummary
        sessionModes={{
          current: catalog.current_mode ?? null,
          modes: catalog.modes,
        }}
        options={visibleConfigOptions}
        selectedMode={modeId || catalog.current_mode || null}
        pending={configOverrides}
        onSelectMode={onModeId}
        onSelectConfigOption={(key, value) => {
          onValues(
            selectConfigOptionValue(visibleConfigOptions, values, key, value)
          );
        }}
      />
    </div>
  );
}
