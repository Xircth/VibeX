import { ArrowRight, Gift, Mic, Smartphone, Sparkles, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import dimoLogo from '@/assets/app-logo-light-default.png';
import { Button } from '@/components/ui/button';
import { persistFrontendPreference } from '@/lib/frontendPreferences';
import { readLocalStorage, writeLocalStorage } from '@/lib/safeStorage';

export const ACCOUNT_AVATAR_HOVER_INTRO_KEY =
  'dimo:account-avatar-hover-intro' as const;

export function hasSeenAccountAvatarHoverIntro(): boolean {
  return readLocalStorage(ACCOUNT_AVATAR_HOVER_INTRO_KEY) === 'seen';
}

export function markAccountAvatarHoverIntroSeen(): void {
  writeLocalStorage(ACCOUNT_AVATAR_HOVER_INTRO_KEY, 'seen');
  persistFrontendPreference(ACCOUNT_AVATAR_HOVER_INTRO_KEY, 'seen');
}

interface AnchorPosition {
  left: number;
  bottom: number;
}

const DEFAULT_ANCHOR_POSITION: AnchorPosition = {
  left: 12,
  bottom: 42,
};

function computeAnchorPosition(triggerEl: HTMLElement | null): AnchorPosition {
  if (!triggerEl || typeof window === 'undefined') {
    return DEFAULT_ANCHOR_POSITION;
  }
  const rect = triggerEl.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    return DEFAULT_ANCHOR_POSITION;
  }
  const maxLeft = Math.max(12, window.innerWidth - 368);
  const left = Math.min(Math.max(12, Math.round(rect.left)), maxLeft);
  const bottom = Math.max(12, Math.round(window.innerHeight - rect.top + 10));
  return { left, bottom };
}

export interface AccountAvatarHoverPromoProps {
  open: boolean;
  triggerRef: RefObject<HTMLElement | null>;
  onDismiss: () => void;
  onSignIn: () => void;
}

export function AccountAvatarHoverPromo({
  open,
  triggerRef,
  onDismiss,
  onSignIn,
}: AccountAvatarHoverPromoProps) {
  const { t } = useTranslation(['settings', 'common']);
  const [position, setPosition] = useState<AnchorPosition>(
    DEFAULT_ANCHOR_POSITION
  );

  useLayoutEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      setPosition(computeAnchorPosition(triggerRef.current));
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, triggerRef]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onDismiss();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onDismiss]);

  if (!open || typeof document === 'undefined') {
    return null;
  }

  const portalContainer =
    document.querySelector('.legacy-design') ?? document.body;
  const closeLabel = t('common:close', { defaultValue: '关闭' });
  const title = t('settings:accountMenu.hoverPromoTitle', {
    defaultValue: '登录 Dimo 账号',
  });

  const features = [
    {
      key: 'models',
      icon: Sparkles,
      title: t('settings:accountMenu.hoverPromoFeatureModelsTitle', {
        defaultValue: '优质低价大模型',
      }),
      desc: t('settings:accountMenu.hoverPromoFeatureModelsDesc', {
        defaultValue: '即开即用官方模型市场，满血模型一键配置',
      }),
    },
    {
      key: 'voice',
      icon: Mic,
      title: t('settings:accountMenu.hoverPromoFeatureVoiceTitle', {
        defaultValue: '语音输入',
      }),
      desc: t('settings:accountMenu.hoverPromoFeatureVoiceDesc', {
        defaultValue: '随说随录，高效直出指令与对话内容',
      }),
    },
    {
      key: 'remote',
      icon: Smartphone,
      title: t('settings:accountMenu.hoverPromoFeatureRemoteTitle', {
        defaultValue: '跨端远程连接',
      }),
      desc: t('settings:accountMenu.hoverPromoFeatureRemoteDesc', {
        defaultValue: '手机随时随地连接桌面端查看与协作会话',
      }),
    },
  ] as const;

  return createPortal(
    <aside
      data-testid="account-avatar-hover-promo"
      role="dialog"
      aria-label={title}
      style={{
        left: `${position.left}px`,
        bottom: `${position.bottom}px`,
      }}
      className="fixed z-40 w-[356px] max-w-[calc(100vw-24px)] overflow-hidden rounded-xl border border-border/85 bg-popover text-popover-foreground shadow-[0_20px_48px_-12px_rgba(0,0,0,0.34),0_6px_16px_-4px_rgba(0,0,0,0.16)]"
    >
      <div
        className="relative px-[15px] pt-[15px] pb-[6px]"
        style={{
          background:
            'radial-gradient(95% 115% at 0% 0%, hsl(var(--primary) / 0.13) 0%, transparent 72%)',
        }}
      >
        <div className="flex items-start justify-between gap-2.5">
          <div className="flex min-w-0 items-center gap-[9px]">
            <img
              src={dimoLogo}
              alt="Dimo Logo"
              className="h-6 w-6 shrink-0 rounded-sm object-contain"
            />
            <div className="flex min-w-0 flex-wrap items-center gap-[7px]">
              <h4 className="m-0 text-[13.5px] font-semibold leading-[1.25] tracking-[-0.01em] text-foreground">
                {title}
              </h4>
              <span className="inline-flex items-center gap-1 rounded-full border border-primary/25 bg-primary/10 px-[7px] py-[2px] text-[10.5px] font-semibold leading-[1.2] text-primary">
                <Gift
                  className="h-[11px] w-[11px] shrink-0"
                  aria-hidden="true"
                />
                <span>
                  {t('settings:accountMenu.hoverPromoBadge', {
                    defaultValue: '享邀请好礼',
                  })}
                </span>
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={onDismiss}
            title={closeLabel}
            aria-label={closeLabel}
            className="inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-secondary/85 hover:text-foreground"
          >
            <X className="h-[13px] w-[13px]" />
          </button>
        </div>

        <p className="mt-2 mb-0 text-xs leading-[1.5] text-muted-foreground">
          {t('settings:accountMenu.hoverPromoSubtitle', {
            defaultValue:
              '优质低价大模型、语音输入与跨端远程连接等功能触手可得',
          })}
        </p>
      </div>

      <div className="flex flex-col gap-1.5 px-[13px] pt-2 pb-[6px]">
        {features.map((feature) => {
          const Icon = feature.icon;
          return (
            <div
              key={feature.key}
              className="flex items-center gap-2.5 rounded-md border border-border/50 bg-secondary/45 px-2.5 py-[7px] transition-colors hover:border-border/85 hover:bg-secondary/75"
            >
              <span
                aria-hidden="true"
                className="inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center text-primary"
              >
                <Icon className="h-3.5 w-3.5" />
              </span>
              <div className="flex min-w-0 flex-col gap-px">
                <span className="text-xs font-semibold leading-[1.3] text-foreground">
                  {feature.title}
                </span>
                <span className="truncate text-[11px] leading-[1.3] text-muted-foreground">
                  {feature.desc}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between gap-2.5 px-[14px] pt-2 pb-[13px]">
        <button
          type="button"
          onClick={onDismiss}
          className="rounded-sm px-2 py-[5px] text-xs font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          {t('settings:accountMenu.hoverPromoLater', {
            defaultValue: '暂不登录',
          })}
        </button>
        <Button
          type="button"
          variant="primary"
          size="xs"
          onClick={onSignIn}
          className="h-7 gap-1.5 rounded-md px-3 text-xs font-semibold shadow-sm"
        >
          <span>
            {t('settings:accountMenu.hoverPromoCta', {
              defaultValue: '立即登录',
            })}
          </span>
          <ArrowRight
            className="h-[13px] w-[13px] shrink-0"
            aria-hidden="true"
          />
        </Button>
      </div>
    </aside>,
    portalContainer
  );
}
