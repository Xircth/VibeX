import { ExternalLink, Loader2, CheckCircle2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  type useVibeXAccount,
  resolveAccountDisplayName,
} from '@/features/model-router/useVibeXAccount';
import type { useAccountDeviceLogin } from '@/pages/settings/useAccountDeviceLogin';

export function OnboardingAccount({
  account,
  login,
}: {
  account: ReturnType<typeof useVibeXAccount>;
  login: ReturnType<typeof useAccountDeviceLogin>;
}) {
  const { t } = useTranslation('dialogs');
  return (
    <section
      className="onboarding-account"
      aria-label={t('onboarding.accountTitle')}
    >
      <div>
        <h2>{t('onboarding.accountTitle')}</h2>
        <p>{t('onboarding.accountDescription')}</p>
      </div>
      {account.isSignedIn ? (
        <p className="flex items-center justify-center gap-2" role="status">
          <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
          {t('onboarding.accountConnected', {
            name: account.user
              ? resolveAccountDisplayName(account.user)
              : 'VibeX',
          })}
        </p>
      ) : login.loginState ? (
        <div className="space-y-3">
          <p className="flex items-center justify-center gap-2" role="status">
            <Loader2 className="h-4 w-4 motion-safe:animate-spin" />
            {t('onboarding.accountWaiting')}
          </p>
          <div className="flex justify-center gap-2">
            <Button variant="outline" onClick={login.reopenVerifyUrl}>
              {t('onboarding.accountReopen')}
            </Button>
            <Button variant="ghost" onClick={login.cancelLogin}>
              {t('onboarding.cancel')}
            </Button>
          </div>
        </div>
      ) : (
        <Button
          onClick={() => void login.startLogin()}
          disabled={login.startingLogin}
        >
          {login.startingLogin ? (
            <Loader2 className="mr-2 h-4 w-4 motion-safe:animate-spin" />
          ) : (
            <ExternalLink className="mr-2 h-4 w-4" />
          )}
          {t('onboarding.accountLogin')}
        </Button>
      )}
      {login.authError ? (
        <p role="alert" className="text-sm text-destructive">
          {login.authError}
        </p>
      ) : null}
    </section>
  );
}
