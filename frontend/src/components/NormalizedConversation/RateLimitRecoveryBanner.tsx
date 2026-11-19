import { useCallback, useEffect, useState } from 'react';
import { Check, ChevronDown, Clock, Pencil, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatCountdownTimer } from '@/components/tasks/follow-up/MessageQueueIndicator';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';
import { conversationApi } from '@/features/conversation/conversationApi';
import { getErrorMessage } from '@/lib/modals';
import { cn } from '@/lib/utils';

export const DEFAULT_CONTINUATION_PROMPT = 'Continue where you left off.';

export interface RateLimitIndicatorState {
  isRateLimited: boolean;
  engine: string;
  limitedAt: string;
  resetAt: string;
  countdownSeconds?: number;
  autoResume?: boolean;
  continuationPrompt?: string;
}

export interface RateLimitRecoveryBannerProps {
  conversationId: string;
  rateLimit: RateLimitIndicatorState | null | undefined;
  onUpdateAutoResume?: (params: {
    conversationId: string;
    autoResume: boolean;
    continuationPrompt: string;
  }) => Promise<void> | void;
  onCancelWait?: (conversationId: string) => Promise<void> | void;
  className?: string;
}

export function formatRateLimitCountdown(
  resetAt: string | null | undefined,
  nowMs: number,
  fallbackSeconds?: number
): string {
  if (resetAt) {
    const parsed = Date.parse(resetAt);
    if (Number.isFinite(parsed)) {
      return formatCountdownTimer(resetAt, nowMs);
    }
  }
  if (typeof fallbackSeconds === 'number' && Number.isFinite(fallbackSeconds)) {
    const syntheticIso = new Date(
      nowMs + Math.max(0, fallbackSeconds) * 1000
    ).toISOString();
    return formatCountdownTimer(syntheticIso, nowMs);
  }
  return '00:00';
}

export function RateLimitRecoveryBanner({
  conversationId,
  rateLimit,
  onUpdateAutoResume,
  onCancelWait,
  className,
}: RateLimitRecoveryBannerProps) {
  const { t } = useTranslation(['conversation', 'common']);
  const isRateLimited = Boolean(rateLimit?.isRateLimited);

  const [nowMs, setNowMs] = useState(() => Date.now());
  const [autoResume, setAutoResume] = useState<boolean>(
    rateLimit?.autoResume ?? true
  );
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [promptDraft, setPromptDraft] = useState<string>(
    rateLimit?.continuationPrompt?.trim() || DEFAULT_CONTINUATION_PROMPT
  );
  const [isUpdating, setIsUpdating] = useState(false);

  useEffect(() => {
    if (!rateLimit) return;
    setAutoResume(rateLimit.autoResume ?? true);
  }, [rateLimit, rateLimit?.autoResume]);

  useEffect(() => {
    if (!rateLimit) return;
    setPromptDraft(
      rateLimit.continuationPrompt?.trim() || DEFAULT_CONTINUATION_PROMPT
    );
  }, [rateLimit, rateLimit?.continuationPrompt]);

  useEffect(() => {
    if (!isRateLimited) return;
    setNowMs(Date.now());
    const interval = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => window.clearInterval(interval);
  }, [isRateLimited, rateLimit?.resetAt]);

  const persistAutoResumeState = useCallback(
    async (
      nextAutoResume: boolean,
      nextPrompt: string,
      rollback: {
        autoResume: boolean;
        promptDraft: string;
        promptExpanded?: boolean;
      }
    ) => {
      const normalizedPrompt = nextPrompt.trim() || DEFAULT_CONTINUATION_PROMPT;
      setIsUpdating(true);
      try {
        if (onUpdateAutoResume) {
          await onUpdateAutoResume({
            conversationId,
            autoResume: nextAutoResume,
            continuationPrompt: normalizedPrompt,
          });
        } else {
          await conversationApi.updateRateLimitAutoResume({
            conversationId,
            autoResume: nextAutoResume,
            continuationPrompt: normalizedPrompt,
          });
        }
      } catch (error) {
        setAutoResume(rollback.autoResume);
        setPromptDraft(rollback.promptDraft);
        if (rollback.promptExpanded !== undefined) {
          setPromptExpanded(rollback.promptExpanded);
        }
        toast.error(getErrorMessage(error));
      } finally {
        setIsUpdating(false);
      }
    },
    [conversationId, onUpdateAutoResume]
  );

  const handleToggleAutoResume = useCallback(
    (checked: boolean) => {
      const previousAutoResume = autoResume;
      setAutoResume(checked);
      void persistAutoResumeState(checked, promptDraft, {
        autoResume: previousAutoResume,
        promptDraft,
      });
    },
    [autoResume, persistAutoResumeState, promptDraft]
  );

  const handleSaveContinuationPrompt = useCallback(() => {
    const previousDraft = promptDraft;
    const normalized = promptDraft.trim() || DEFAULT_CONTINUATION_PROMPT;
    setPromptDraft(normalized);
    setPromptExpanded(false);
    void persistAutoResumeState(autoResume, normalized, {
      autoResume,
      promptDraft: previousDraft,
      promptExpanded: true,
    });
  }, [autoResume, persistAutoResumeState, promptDraft]);

  const handleCancelWait = useCallback(async () => {
    setIsUpdating(true);
    try {
      if (onCancelWait) {
        await onCancelWait(conversationId);
      } else {
        await conversationApi.cancelRateLimitWait({ conversationId });
      }
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setIsUpdating(false);
    }
  }, [conversationId, onCancelWait]);

  if (!rateLimit || !rateLimit.isRateLimited) {
    return null;
  }

  const countdown = formatRateLimitCountdown(
    rateLimit.resetAt,
    nowMs,
    rateLimit.countdownSeconds
  );

  const bannerText = autoResume
    ? t('conversation:rateLimit.bannerTitle', {
        engine: rateLimit.engine,
        countdown,
      })
    : t('conversation:rateLimit.bannerPausedTitle', {
        engine: rateLimit.engine,
        countdown,
      });

  return (
    <div
      role="status"
      data-testid="rate-limit-recovery-banner"
      data-tone="warning"
      className={cn(
        'composer-priority-banner rounded-[var(--radius-composer,0.75rem)] border border-warning/35 bg-warning/10 px-3 py-2 text-xs text-foreground',
        className
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Clock className="h-3.5 w-3.5 shrink-0 text-warning" />
          <span
            data-testid="rate-limit-banner-title"
            className="font-medium tabular-nums"
          >
            {bannerText}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-3">
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
            <Switch
              checked={autoResume}
              onCheckedChange={handleToggleAutoResume}
              disabled={isUpdating}
              aria-label={t('conversation:rateLimit.autoResume')}
              data-testid="rate-limit-auto-resume-switch"
            />
            <span className="text-foreground">
              {t('conversation:rateLimit.autoResume')}
            </span>
          </label>

          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setPromptExpanded((prev) => !prev)}
            aria-expanded={promptExpanded}
            data-testid="rate-limit-edit-prompt-toggle"
            className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
          >
            <Pencil className="h-3 w-3" />
            <span>{t('conversation:rateLimit.editPrompt')}</span>
            <ChevronDown
              className={cn(
                'h-3 w-3 transition-transform duration-150',
                promptExpanded && 'rotate-180'
              )}
            />
          </Button>

          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isUpdating}
            onClick={() => void handleCancelWait()}
            data-testid="rate-limit-cancel-btn"
            className="h-7 gap-1 px-2 text-xs"
          >
            <X className="h-3.5 w-3.5" />
            <span>{t('conversation:rateLimit.cancelWait')}</span>
          </Button>
        </div>
      </div>

      {promptExpanded ? (
        <div
          data-testid="rate-limit-prompt-editor"
          className="mt-2.5 flex items-center gap-2 border-t border-warning/20 pt-2.5"
        >
          <input
            type="text"
            value={promptDraft}
            onChange={(event) => setPromptDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                handleSaveContinuationPrompt();
              }
            }}
            placeholder={t('conversation:rateLimit.promptPlaceholder')}
            aria-label={t('conversation:rateLimit.editPrompt')}
            data-testid="rate-limit-prompt-input"
            className="h-7 flex-1 rounded-md border border-border bg-background px-2.5 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
          />
          <Button
            type="button"
            size="sm"
            disabled={isUpdating}
            onClick={handleSaveContinuationPrompt}
            data-testid="rate-limit-save-prompt-btn"
            className="h-7 gap-1 px-2.5 text-xs"
          >
            <Check className="h-3.5 w-3.5" />
            <span>{t('conversation:rateLimit.savePrompt')}</span>
          </Button>
        </div>
      ) : null}
    </div>
  );
}
