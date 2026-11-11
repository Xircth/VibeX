import { useState } from 'react';
import {
  Bot,
  ChevronRight,
  Compass,
  ExternalLink,
  FileText,
  Layers,
  LogOut,
  Puzzle,
  Settings,
  SlidersHorizontal,
  User,
} from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  restartBasicGuide,
  useOptionalBasicGuide,
  writeBasicGuide,
} from '@/features/basic-guide';
import {
  openExternal,
  resolveAccountAvatarLabel,
  resolveAccountDisplayName,
  useVibeXAccount,
} from '@/features/model-router';
import { openSettingsSurface } from '@/lib/api/settingsWindow';
import { getSiteUrl } from '@/lib/branding';
import {
  isSettingsSurfacePath,
  preloadSettingsPath,
} from '@/lib/settingsPreload';
import { cn } from '@/lib/utils';

type AccountStatusMenuProps = {
  className?: string;
};

export function AccountStatusMenu({ className }: AccountStatusMenuProps) {
  const { t } = useTranslation('settings');
  const navigate = useNavigate();
  const location = useLocation();
  const basicGuide = useOptionalBasicGuide();
  const { isSignedIn, user, signingOut, signOut } = useVibeXAccount();
  const [open, setOpen] = useState(false);

  const displayName = resolveAccountDisplayName(user);
  const avatarLabel = resolveAccountAvatarLabel(user);

  const openPath = (path: string) => {
    setOpen(false);
    preloadSettingsPath(path);
    if (isSettingsSurfacePath(location.pathname)) {
      if (location.pathname !== path) {
        navigate(path);
      }
      return;
    }
    openSettingsSurface(navigate, path);
  };

  const handleOpenChangelog = () => {
    setOpen(false);
    void openExternal(getSiteUrl('/changelog'));
  };

  const handleGettingStarted = () => {
    setOpen(false);
    if (basicGuide) {
      basicGuide.restart();
    } else {
      writeBasicGuide(restartBasicGuide());
    }
    if (isSettingsSurfacePath(location.pathname)) {
      navigate('/');
    }
  };

  const handleSignOut = async () => {
    setOpen(false);
    await signOut();
  };

  const triggerAria =
    isSignedIn && displayName
      ? t('accountMenu.triggerSignedInAria', { name: displayName })
      : t('accountMenu.triggerAria');

  const navItems = [
    {
      key: 'agents',
      label: t('accountMenu.agents'),
      icon: Bot,
      path: '/settings/agents',
    },
    {
      key: 'models',
      label: t('accountMenu.models'),
      icon: Layers,
      path: '/settings/agents',
    },
    {
      key: 'plugins',
      label: t('accountMenu.plugins'),
      icon: Puzzle,
      path: '/plugins',
    },
    {
      key: 'appearance',
      label: t('accountMenu.appearanceAndLanguage'),
      icon: SlidersHorizontal,
      path: '/settings/appearance',
    },
    {
      key: 'system',
      label: t('accountMenu.appAndUpdates'),
      icon: Settings,
      path: '/settings/system',
    },
  ] as const;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="account-status-menu-trigger"
          aria-label={triggerAria}
          title={triggerAria}
          className={cn(
            'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border/80 bg-muted/80 text-[11px] font-semibold text-foreground transition-colors hover:border-foreground/30 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            className
          )}
        >
          {isSignedIn && avatarLabel ? (
            <span className="leading-none">{avatarLabel}</span>
          ) : (
            <User
              className="h-3.5 w-3.5 text-muted-foreground"
              aria-hidden="true"
            />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        data-testid="account-status-menu-content"
        className="w-60 rounded-xl border border-border bg-popover p-1.5 text-xs text-popover-foreground shadow-lg"
      >
        <button
          type="button"
          data-testid="account-status-menu-profile"
          onClick={() => openPath('/settings/account')}
          onMouseEnter={() => preloadSettingsPath('/settings/account')}
          className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-accent/70"
        >
          <span
            aria-hidden="true"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-xs font-semibold text-foreground"
          >
            {isSignedIn && avatarLabel ? (
              avatarLabel
            ) : (
              <User className="h-4 w-4 text-muted-foreground" />
            )}
          </span>
          <span className="min-w-0 flex-1">
            {isSignedIn && user ? (
              <>
                <span className="block truncate text-xs font-semibold text-foreground">
                  {displayName}
                </span>
                {user.email ? (
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {user.email}
                  </span>
                ) : null}
              </>
            ) : (
              <>
                <span className="block truncate text-xs font-semibold text-foreground">
                  {t('accountMenu.signIn')}
                </span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {t('accountMenu.signInHint')}
                </span>
              </>
            )}
          </span>
          <ChevronRight
            className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
        </button>

        <div className="my-1 h-px bg-border/60" role="separator" />

        <div className="space-y-0.5">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.key}
                type="button"
                data-testid={`account-status-menu-item-${item.key}`}
                onClick={() => openPath(item.path)}
                onMouseEnter={() => preloadSettingsPath(item.path)}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-xs text-foreground/90 transition-colors hover:bg-accent/70 hover:text-foreground"
              >
                <Icon
                  className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
              </button>
            );
          })}
        </div>

        <div className="my-1 h-px bg-border/60" role="separator" />

        <div className="space-y-0.5">
          <button
            type="button"
            data-testid="account-status-menu-item-changelog"
            onClick={handleOpenChangelog}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-xs text-foreground/90 transition-colors hover:bg-accent/70 hover:text-foreground"
          >
            <FileText
              className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1 truncate">
              {t('accountMenu.changelog')}
            </span>
            <ExternalLink
              className="h-3 w-3 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
          </button>

          <button
            type="button"
            data-testid="account-status-menu-item-getting-started"
            onClick={handleGettingStarted}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-xs text-foreground/90 transition-colors hover:bg-accent/70 hover:text-foreground"
          >
            <Compass
              className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1 truncate">
              {t('accountMenu.gettingStarted')}
            </span>
          </button>
        </div>

        {isSignedIn ? (
          <>
            <div className="my-1 h-px bg-border/60" role="separator" />
            <button
              type="button"
              data-testid="account-status-menu-item-sign-out"
              disabled={signingOut}
              onClick={() => void handleSignOut()}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-xs text-foreground/90 transition-colors hover:bg-accent/70 hover:text-foreground disabled:opacity-50"
            >
              <LogOut
                className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1 truncate">
                {t('accountMenu.signOut')}
              </span>
            </button>
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
