import { Check, SlidersHorizontal } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentSessionMode } from 'shared/types';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { Switch } from '@/components/ui/switch';
import {
  blockItemPointerMoveFocus,
  COMPOSER_SELECT_ITEM_CLASS,
  COMPOSER_SELECT_LABEL_CLASS,
  COMPOSER_SELECT_LIST_CLASS,
  ComposerOptionName,
} from './ComposerSelect';
import { compactSessionControlLabel } from './sessionControlLabels';

/**
 * Keep Agent-advertised modes intact, except that bypass-permissions remains
 * behind VibeX's explicit local safety gate. Shared by the composer's icon
 * picker and the create form's labeled field.
 */
export function presentableSessionModes(
  modes: AgentSessionMode[],
  dangerousOperationsAllowed = false,
  activeId: string | null = null
): AgentSessionMode[] {
  return modes
    .filter(
      (mode) =>
        !isDangerousPermissionsMode(mode.id) ||
        dangerousOperationsAllowed ||
        mode.id === activeId
    )
    .map((mode) => {
      const label = compactSessionControlLabel(mode.id, mode.label);
      return label === mode.label ? mode : { ...mode, label };
    });
}

export function presentedActiveModeId(
  _modes: AgentSessionMode[],
  activeId: string | null
): string | null {
  return activeId;
}

/**
 * Composer mode picker, driven entirely by the modes the agent actually
 * advertised for this conversation (`session_mode_updated`). Selecting a mode
 * applies it on the next turn via the real ACP `SetSessionMode`. Renders nothing
 * until the agent advertises modes, so it never shows fabricated options.
 */
export function SessionModeSelector({
  modes,
  current,
  selected,
  onSelect,
  disabled = false,
}: {
  modes: AgentSessionMode[];
  /** The agent's currently-active mode id (from the stream). */
  current: string | null;
  /** The user's pending selection for the next turn, if any. */
  selected: string | null;
  onSelect: (modeId: string) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation(['tasks', 'common']);

  const activeModeId = selected ?? current;
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

  if (modes.length === 0) return null;

  const presentableModes = presentableSessionModes(
    modes,
    dangerousOperationsAllowed,
    activeModeId
  );
  const presentedActiveId = presentedActiveModeId(modes, activeModeId);
  const activeMode =
    presentableModes.find((mode) => mode.id === presentedActiveId) ?? null;
  const triggerTitle = `${t('sessionModeSelector.title')}: ${
    activeMode?.label ?? t('sessionModeSelector.fallbackLabel')
  }`;

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
        <SlidersHorizontal className="h-3.5 w-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        className="min-w-[10rem] max-w-[16rem] rounded-lg p-1"
      >
        <DropdownMenuLabel className={COMPOSER_SELECT_LABEL_CLASS}>
          {t('sessionModeSelector.title')}
        </DropdownMenuLabel>
        <div className={COMPOSER_SELECT_LIST_CLASS}>
          {presentableModes.map((mode) => {
            const isActive = mode.id === presentedActiveId;
            return (
              <DropdownMenuItem
                key={mode.id}
                onSelect={() => onSelect(mode.id)}
                onPointerMove={blockItemPointerMoveFocus}
                className={cn(
                  COMPOSER_SELECT_ITEM_CLASS,
                  isActive && 'bg-accent/60'
                )}
              >
                <span className="min-w-0 flex-1">
                  <ComposerOptionName
                    active={isActive}
                    title={mode.description}
                  >
                    {mode.label}
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
        {hasDangerousPermissionsMode ? (
          <div className="mt-1 flex items-center justify-between gap-3 border-t px-2 py-2">
            <span className="text-xs text-muted-foreground">
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
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function isDangerousPermissionsMode(modeId: string | null): boolean {
  return (
    modeId?.replace(/[^a-z0-9]/gi, '').toLowerCase() === 'bypasspermissions'
  );
}
