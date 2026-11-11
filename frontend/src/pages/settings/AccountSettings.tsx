import { useEffect } from 'react';
import {
  Copy,
  ExternalLink,
  KeyRound,
  Loader2,
  LogOut,
  ReceiptText,
  RefreshCw,
  Users,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Logo } from '@/components/Logo';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import {
  openExternal,
  resolveAccountAvatarLabel,
  resolveAccountDisplayName,
  useAccountSavedHosts,
  useVibeXAccount,
} from '@/features/model-router';
import { getSiteUrl } from '@/lib/branding';
import { cn } from '@/lib/utils';

import { AccountHostConfigSection } from './AccountHostConfigSection';
import { AccountSubscriptionSection } from './AccountSubscriptionSection';
import { useAccountDeviceLogin } from './useAccountDeviceLogin';

export function AccountSettings() {
  const { t } = useTranslation(['settings', 'common']);
  const {
    isSignedIn,
    overview,
    user,
    isLoading,
    isFetching,
    signingOut,
    refresh,
    signOut,
  } = useVibeXAccount();
  const { syncNow: syncSavedHosts, isSyncing: isSyncingSavedHosts } =
    useAccountSavedHosts();

  const {
    loginState,
    startingLogin,
    authError,
    startLogin,
    cancelLogin,
    reopenVerifyUrl,
  } = useAccountDeviceLogin({ isSignedIn, refresh });

  useEffect(() => {
    if (!isSignedIn) return;
    const onFocus = () => {
      void refresh();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [isSignedIn, refresh]);

  const handleCopyAccountId = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(t('settings:account.copied'));
    } catch {
      toast.error(t('settings:account.copyFailed'));
    }
  };

  const displayName = resolveAccountDisplayName(user);
  const avatarLabel = resolveAccountAvatarLabel(user) || 'V';
  const accountIdentifier = user?.username || user?.email || '';
  const balanceMicro = overview?.balanceMicro ?? 0;
  const hasActiveSubscriptionOrCredits =
    (user?.tier && user.tier !== 'regular') || balanceMicro > 0;

  return (
    <div className="settings-content" data-testid="account-settings-page">
      <div className="mx-auto w-full max-w-3xl space-y-6">
        <header className="flex items-center justify-between gap-3">
          <h2 className="text-xl font-semibold tracking-tight text-foreground">
            {t('settings:account.title')}
          </h2>
          {isSignedIn ? (
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 gap-1.5 text-xs text-muted-foreground hover:text-foreground"
                disabled={isFetching || isSyncingSavedHosts}
                onClick={() => {
                  void refresh();
                  void syncSavedHosts();
                }}
              >
                <RefreshCw
                  className={cn(
                    'h-3.5 w-3.5',
                    (isFetching || isSyncingSavedHosts) && 'animate-spin'
                  )}
                  aria-hidden="true"
                />
                {t('settings:account.refresh')}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 text-xs"
                disabled={signingOut}
                onClick={() => void signOut()}
              >
                <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
                {t('settings:agents.modelRouterSignOut')}
              </Button>
            </div>
          ) : null}
        </header>

        {/* Profile / Sign-in Card */}
        <section className="settings-card rounded-xl border border-border bg-card p-5">
          {isLoading ? (
            <div
              role="status"
              aria-busy="true"
              className="flex h-20 items-center justify-center"
            >
              <Loader2
                aria-hidden="true"
                className="h-4 w-4 animate-spin text-muted-foreground"
              />
            </div>
          ) : isSignedIn && user ? (
            <div className="flex items-start justify-between gap-4">
              <div className="flex min-w-0 items-center gap-4">
                <div
                  aria-hidden="true"
                  className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-base font-semibold text-foreground"
                >
                  {avatarLabel}
                </div>
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-base font-semibold text-foreground">
                      {displayName}
                    </span>
                    <span
                      className={cn(
                        'inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium',
                        hasActiveSubscriptionOrCredits
                          ? 'border-primary/30 bg-primary/10 text-primary'
                          : 'border-border bg-muted text-muted-foreground'
                      )}
                    >
                      {hasActiveSubscriptionOrCredits
                        ? t('settings:account.statusActive')
                        : t('settings:account.statusInactive')}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        void openExternal(getSiteUrl('/account/profile'))
                      }
                      className="text-xs text-muted-foreground transition-colors hover:text-foreground"
                    >
                      {t('settings:account.rename')}
                    </button>
                  </div>
                  {user.email ? (
                    <div className="truncate text-xs text-muted-foreground">
                      {user.email}
                    </div>
                  ) : null}
                  {accountIdentifier ? (
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <span className="font-mono">
                        {t('settings:account.accountIdLabel', {
                          id: accountIdentifier,
                        })}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          void handleCopyAccountId(accountIdentifier)
                        }
                        aria-label={t('settings:account.copyId')}
                        title={t('settings:account.copyId')}
                        className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      >
                        <Copy className="h-3 w-3" aria-hidden="true" />
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          ) : loginState ? (
            <div
              data-testid="account-login-waiting"
              className="flex flex-col items-center gap-3 py-2 text-center"
            >
              <Loader2
                aria-hidden="true"
                className="h-5 w-5 animate-spin text-muted-foreground"
              />
              <p className="text-xs text-muted-foreground">
                {t('settings:agents.modelRouterCodeHint')}
              </p>
              <div className="flex items-center gap-2 pt-1">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={cancelLogin}
                >
                  {t('common:cancel')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={reopenVerifyUrl}
                >
                  {t('settings:agents.modelRouterReopen')}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex min-w-0 items-center gap-3.5">
                <div
                  aria-hidden="true"
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border bg-muted/40"
                >
                  <Logo showText={false} />
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-foreground">
                    {t('settings:account.signedOutTitle')}
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {t('settings:account.signedOutDesc')}
                  </p>
                </div>
              </div>
              <Button
                type="button"
                size="sm"
                disabled={startingLogin}
                onClick={() => void startLogin()}
              >
                {t('settings:agents.modelRouterSignIn')}
              </Button>
            </div>
          )}

          {authError ? (
            <p className="mt-3 text-xs text-destructive" role="alert">
              {authError}
            </p>
          ) : null}
        </section>

        {/* Subscription & Usage (hidden when signed out) */}
        <AccountSubscriptionSection />

        {/* Account Host List (hidden when signed out) */}
        <AccountHostConfigSection />

        {/* Security / Passkey Card */}
        <section className="settings-card flex items-center justify-between gap-4 rounded-xl border border-border bg-card px-5 py-4">
          <div className="min-w-0">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <KeyRound
                className="h-4 w-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <span>{t('settings:account.passkeyTitle')}</span>
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('settings:account.passkeyDesc')}
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            onClick={() => void openExternal(getSiteUrl('/account/security'))}
            className="shrink-0 gap-1.5"
          >
            <span>{t('settings:account.passkeyAction')}</span>
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        </section>

        {/* Collaboration Seats Section */}
        <section className="space-y-2.5">
          <h3 className="text-xs font-medium text-muted-foreground">
            {t('settings:account.seatsSectionTitle')}
          </h3>
          <div className="settings-card flex items-center justify-between gap-4 rounded-xl border border-border bg-card px-5 py-4">
            <div className="flex min-w-0 items-center gap-3 text-xs text-muted-foreground">
              <Users className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{t('settings:account.seatsDesc')}</span>
            </div>
            <button
              type="button"
              onClick={() => void openExternal(getSiteUrl('/account'))}
              className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-primary transition-colors hover:underline"
            >
              <span>{t('settings:account.addSeats')}</span>
              <ExternalLink className="h-3 w-3" aria-hidden="true" />
            </button>
          </div>
        </section>

        {/* Billing & Redemption Section */}
        <section className="space-y-2.5">
          <h3 className="text-xs font-medium text-muted-foreground">
            {t('settings:account.billingSectionTitle')}
          </h3>
          <div className="settings-card flex items-center justify-between gap-4 rounded-xl border border-border bg-card px-5 py-4">
            <div className="flex min-w-0 items-center gap-3.5">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/40 text-muted-foreground">
                <ReceiptText className="h-4 w-4" aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <div className="text-xs font-semibold text-foreground">
                  {t('settings:account.billingHistoryTitle')}
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {t('settings:account.billingHistoryDesc')}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => void openExternal(getSiteUrl('/account/billing'))}
              className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              <span>{t('settings:account.viewOnSite')}</span>
              <ExternalLink className="h-3 w-3" aria-hidden="true" />
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
