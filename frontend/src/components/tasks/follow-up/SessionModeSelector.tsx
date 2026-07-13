import { Check, SlidersHorizontal } from 'lucide-react';
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
import {
  blockItemPointerMoveFocus,
  COMPOSER_SELECT_ITEM_CLASS,
  COMPOSER_SELECT_LABEL_CLASS,
  COMPOSER_SELECT_LIST_CLASS,
  ComposerOptionName,
} from './ComposerSelect';

const DEFAULT_MODE_ID = 'default';
/**
 * Claude Code's bypass mode is never surfaced: VibeX's own approvals system
 * (and the Auto classifier mode) covers ACP permission prompts, so nothing in
 * the integration needs bypass. Were an ACP flow to ever require it, it would
 * be enabled programmatically, not through this picker.
 */
const BYPASS_MODE_ID = 'bypassPermissions';
const HIDDEN_MODE_IDS = new Set([DEFAULT_MODE_ID, BYPASS_MODE_ID]);

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

  if (modes.length === 0) return null;

  // The agent's "Default" alias mode is never shown (product rule: the word
  // "Default" does not appear in the composer pickers), and neither is the
  // bypass mode (see HIDDEN_MODE_IDS). While the agent sits on its default,
  // the first visible mode is presented as the effective one.
  const visibleModes = modes.filter((mode) => !HIDDEN_MODE_IDS.has(mode.id));
  const presentableModes = visibleModes.length > 0 ? visibleModes : modes;
  const activeId = selected ?? current;
  const presentedActiveId =
    activeId === DEFAULT_MODE_ID && visibleModes.length > 0
      ? (visibleModes.find((mode) => mode.id === 'auto') ?? visibleModes[0]).id
      : activeId;
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
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
