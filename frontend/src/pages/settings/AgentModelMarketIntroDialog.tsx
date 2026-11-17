import { ArrowUpRight, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import dimoLogo from '@/assets/app-logo-light-default.png';
import { Button } from '@/components/ui/button';
import {
  openModelMarketplace,
  supportsModelRouter,
} from '@/features/model-router';
import { persistFrontendPreference } from '@/lib/frontendPreferences';
import { readLocalStorage, writeLocalStorage } from '@/lib/safeStorage';

export const AGENT_MODEL_MARKET_INTRO_KEY =
  'dimo:agent-model-market-intro' as const;

export function hasSeenAgentModelMarketIntro(): boolean {
  return readLocalStorage(AGENT_MODEL_MARKET_INTRO_KEY) === 'seen';
}

export function markAgentModelMarketIntroSeen(): void {
  writeLocalStorage(AGENT_MODEL_MARKET_INTRO_KEY, 'seen');
  persistFrontendPreference(AGENT_MODEL_MARKET_INTRO_KEY, 'seen');
}

export interface AgentModelMarketIntroDialogProps {
  /** Wait until the Agent settings view has finished its initial load. */
  ready: boolean;
  /** Currently selected agent id, used when supported by ModelRouter. */
  selectedAgentId?: string | null;
}

export function AgentModelMarketIntroDialog({
  ready,
  selectedAgentId,
}: AgentModelMarketIntroDialogProps) {
  const { t } = useTranslation(['settings', 'common']);
  const [open, setOpen] = useState(false);
  const checkedRef = useRef(false);

  useEffect(() => {
    if (!ready || checkedRef.current) return;
    checkedRef.current = true;
    if (!hasSeenAgentModelMarketIntro()) {
      setOpen(true);
    }
  }, [ready]);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== AGENT_MODEL_MARKET_INTRO_KEY) {
        return;
      }
      if (hasSeenAgentModelMarketIntro()) {
        setOpen(false);
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  const handleDismiss = useCallback(() => {
    markAgentModelMarketIntroSeen();
    setOpen(false);
  }, []);

  const handleOpenMarket = useCallback(() => {
    markAgentModelMarketIntroSeen();
    setOpen(false);
    const targetAgent =
      selectedAgentId && supportsModelRouter(selectedAgentId)
        ? selectedAgentId
        : undefined;
    void openModelMarketplace(targetAgent);
  }, [selectedAgentId]);

  if (!open) {
    return null;
  }

  const closeLabel = t('common:close', { defaultValue: '关闭' });
  const title = t('settings:agents.modelMarketIntroTitle', {
    defaultValue: '试试 Dimo 官方模型市场？',
  });

  return (
    <div className="pointer-events-none absolute right-3 top-3 z-30 flex justify-end">
      <aside
        data-testid="agent-model-market-intro-card"
        role="dialog"
        aria-label={title}
        className="pointer-events-auto w-[312px] max-w-[calc(100vw-2rem)] rounded-[var(--radius,12px)] border border-border bg-popover p-3.5 text-popover-foreground shadow-[0_10px_28px_rgba(0,0,0,0.16)]"
      >
        <div className="flex items-start justify-between gap-2.5">
          <div className="flex min-w-0 items-start gap-2.5">
            <img
              src={dimoLogo}
              alt="Dimo Logo"
              className="mt-0.5 h-6 w-6 shrink-0 rounded-sm object-contain"
            />
            <div className="min-w-0">
              <p className="m-0 text-[13px] font-medium leading-[1.4] text-foreground">
                {title}
              </p>
              <p className="mt-0.5 text-xs leading-[1.45] text-muted-foreground">
                {t('settings:agents.modelMarketIntroSubtitle', {
                  defaultValue: '低价，高速，满血，一键配置',
                })}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleDismiss}
            title={closeLabel}
            aria-label={closeLabel}
            className="inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="mt-2.5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={handleDismiss}
            className="inline-flex h-7 items-center rounded-sm px-2 text-xs font-normal text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            {t('settings:agents.modelMarketIntroLater', {
              defaultValue: '暂不需要',
            })}
          </button>
          <Button
            type="button"
            variant="primary"
            size="xs"
            className="h-7 gap-1.5 rounded-md px-2.5 text-xs font-semibold shadow-none"
            onClick={handleOpenMarket}
          >
            <span>
              {t('settings:agents.modelMarketIntroCta', {
                defaultValue: '前往官网模型市场',
              })}
            </span>
            <ArrowUpRight className="h-3 w-3 shrink-0" aria-hidden="true" />
          </Button>
        </div>
      </aside>
    </div>
  );
}
